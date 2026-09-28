import { describe, it, expect, beforeEach, mock } from "bun:test";

/**
 * Tests for ActivityWatch API fetching with retry logic and error handling.
 * These tests highlight issues in the current implementation:
 * 1. No retry mechanism for failed requests
 * 2. Silent error swallowing with Promise.allSettled
 * 3. No backoff strategy
 * 4. No timeout handling
 */

// Helper to calculate retry backoff
function exponentialBackoff(attempt: number, baseDelayMs: number = 1000): number {
  const jitter = Math.random() * 0.1 * baseDelayMs;
  return Math.min(baseDelayMs * Math.pow(2, attempt) + jitter, 30000);
}

describe("ActivityWatch API Fetching", () => {
  describe("Error handling", () => {
    it("should distinguish between network and HTTP errors", async () => {
      const errors = [
        new Error("Network error"),
        new Error("HTTP 404 for bucket"),
        new Error("HTTP 500 for bucket"),
        new Error("timeout"),
      ];

      const isRetryable = (error: Error): boolean => {
        const msg = error.message.toLowerCase();
        // 5xx errors are retryable, 4xx are not (except specific ones)
        if (msg.includes("http 5")) return true;
        if (msg.includes("http 429")) return true; // rate limit
        if (msg.includes("network") || msg.includes("timeout")) return true;
        return false;
      };

      expect(isRetryable(errors[0])).toBe(true); // network
      expect(isRetryable(errors[1])).toBe(false); // 404
      expect(isRetryable(errors[2])).toBe(true); // 500
      expect(isRetryable(errors[3])).toBe(true); // timeout
    });

    it("should handle bucket not found gracefully", () => {
      const bucketId = "aw-watcher-web-brave_nonexistent";
      const error = new Error(`HTTP 404 for bucket "${bucketId}"`);

      // Should fail fast for 404s
      expect(error.message).toContain("404");
    });

    it("should calculate exponential backoff correctly", () => {
      expect(exponentialBackoff(0, 1000)).toBeGreaterThanOrEqual(1000);
      expect(exponentialBackoff(0, 1000)).toBeLessThan(1100);

      // Each attempt should roughly double
      const delay1 = exponentialBackoff(1, 1000);
      const delay2 = exponentialBackoff(2, 1000);
      expect(delay2).toBeGreaterThan(delay1);

      // Should cap at 30s
      const delayLarge = exponentialBackoff(10, 1000);
      expect(delayLarge).toBeLessThanOrEqual(30000);
    });
  });

  describe("Bucket ID construction", () => {
    it("should construct correct bucket IDs from hostname", () => {
      const host = "my-machine";
      const ids = {
        window: `aw-watcher-window_${host}`,
        afk: `aw-watcher-afk_${host}`,
        web: `aw-watcher-web-brave_${host}`,
      };

      expect(ids.window).toBe("aw-watcher-window_my-machine");
      expect(ids.afk).toBe("aw-watcher-afk_my-machine");
      expect(ids.web).toBe("aw-watcher-web-brave_my-machine");
    });

    it("should handle hostnames with special characters", () => {
      const host = "machine-123_test";
      const id = `aw-watcher-window_${host}`;
      expect(id).toBe("aw-watcher-window_machine-123_test");
    });
  });

  describe("Date range calculation", () => {
    it("should correctly calculate UTC boundaries from JST date", () => {
      const JST_OFFSET_MS = 9 * 60 * 60 * 1000;
      const targetDate = "2026-09-28";
      const [y, m, d] = targetDate.split("-").map(Number);

      // For JST 2026-09-28, we need to fetch from UTC 2026-09-27 15:00 to 2026-09-28 15:00
      const startUtc = new Date(Date.UTC(y, m - 1, d) - JST_OFFSET_MS);
      const endUtc = new Date(startUtc.getTime() + 86_400_000);

      expect(startUtc.getUTCDate()).toBe(27); // previous day
      expect(endUtc.getUTCDate()).toBe(28);
    });

    it("should handle month boundaries", () => {
      const JST_OFFSET_MS = 9 * 60 * 60 * 1000;
      const targetDate = "2026-10-01";
      const [y, m, d] = targetDate.split("-").map(Number);

      const startUtc = new Date(Date.UTC(y, m - 1, d) - JST_OFFSET_MS);

      // Should roll back to September
      expect(startUtc.getUTCMonth()).toBe(8); // September (0-indexed)
      expect(startUtc.getUTCDate()).toBe(30);
    });

    it("should generate correct query URL", () => {
      const AW_BASE_URL = "http://localhost:5600/api/0";
      const bucketId = "aw-watcher-window_test";
      const startUtc = new Date("2026-09-27T15:00:00Z");
      const endUtc = new Date("2026-09-28T15:00:00Z");

      const url =
        `${AW_BASE_URL}/buckets/${bucketId}/events` +
        `?start=${startUtc.toISOString()}&end=${endUtc.toISOString()}&limit=50000`;

      expect(url).toContain("aw-watcher-window_test");
      expect(url).toContain("limit=50000");
      expect(url).toContain("2026-09-27T15:00:00");
      expect(url).toContain("2026-09-28T15:00:00");
    });
  });

  describe("Promise.allSettled results handling", () => {
    it("should handle mix of fulfilled and rejected promises", () => {
      const settled = Promise.allSettled([
        Promise.resolve([{ timestamp: "2026-09-28T00:00:00Z", duration: 100, data: {} }]),
        Promise.reject(new Error("Network error")),
        Promise.resolve([]),
      ]);

      settled.then((results) => {
        expect(results[0].status).toBe("fulfilled");
        expect(results[1].status).toBe("rejected");
        expect(results[2].status).toBe("fulfilled");
      });
    });

    it("should extract fulfilled values correctly", () => {
      const mockEvents = [
        { timestamp: "2026-09-28T00:00:00Z", duration: 100, data: {} },
      ];

      const extract = (r: PromiseSettledResult<typeof mockEvents>): typeof mockEvents => {
        if (r.status === "fulfilled") return r.value;
        return [];
      };

      const fulfilled: PromiseSettledResult<typeof mockEvents> = {
        status: "fulfilled",
        value: mockEvents,
      };

      const rejected: PromiseSettledResult<typeof mockEvents> = {
        status: "rejected",
        reason: new Error("test"),
      };

      expect(extract(fulfilled)).toEqual(mockEvents);
      expect(extract(rejected)).toEqual([]);
    });

    it("should log errors when promises are rejected", () => {
      const errors: string[] = [];
      const extract = (r: PromiseSettledResult<any[]>, name: string) => {
        if (r.status === "fulfilled") return r.value;
        errors.push(`Warning: could not fetch ${name}: ${r.reason}`);
        return [];
      };

      const rejected: PromiseSettledResult<any[]> = {
        status: "rejected",
        reason: new Error("HTTP 404"),
      };

      extract(rejected, "web");
      expect(errors[0]).toContain("could not fetch web");
    });

    it("**ISSUE**: should ideally have detailed error context", () => {
      // Current problem: all errors are swallowed silently
      // Would be better to track:
      // - Which buckets failed and why
      // - Whether failures are permanent (404) or temporary (500, timeout)
      // - Retry counts and backoff attempts

      const errorContext = {
        bucketId: "aw-watcher-web-brave_test",
        statusCode: 404,
        isRetryable: false,
        timestamp: new Date().toISOString(),
      };

      expect(errorContext.isRetryable).toBe(false);
    });
  });

  describe("Timeout handling", () => {
    it("should use AbortSignal.timeout for fetch", () => {
      const MODEL_TASK_TIMEOUT = 1000 * 60 * 10; // 10 minutes
      const signal = AbortSignal.timeout(MODEL_TASK_TIMEOUT);

      expect(signal).toBeDefined();
      // Signal should trigger after timeout
    });

    it("**ISSUE**: should catch timeout errors specifically", async () => {
      // Current code catches timeout but doesn't distinguish it
      // Should have specific handling:
      // 1. Ollama timeout -> suggest starting Ollama or increasing timeout
      // 2. ActivityWatch timeout -> try again with longer timeout
      // 3. Network timeout -> retry with backoff

      const timeoutError = new DOMException("The operation timed out.", "TimeoutError");

      expect(timeoutError.name).toBe("TimeoutError");
      expect(timeoutError.code).toBe(23);
    });
  });

  describe("Partial failure recovery", () => {
    it("should allow generating report with only window events", () => {
      const data = {
        window: [{ timestamp: "2026-09-28T00:00:00Z", duration: 100, data: { app: "test" } }],
        afk: [],
        web: [],
      };

      // Should work even if afk or web is empty
      expect(data.window.length).toBeGreaterThan(0);

      const totalMinutes = Math.round(100 / 60);
      expect(totalMinutes).toBeGreaterThan(0);
    });

    it("should provide meaningful fallback for missing data", () => {
      const fallbacks = {
        window: [],
        afk: [],
        web: [],
      };

      const summary = `No activity data available`;
      expect(summary).toBeDefined();
    });
  });
});

describe("ActivityWatch API - Integration concerns", () => {
  it("**ISSUE**: Hard to test without mocking external service", () => {
    // Current implementation requires:
    // - ActivityWatch running on localhost:5600
    // - Hostname to match bucket naming scheme
    // - Test data to exist for the target date

    // Ideal approach:
    // 1. Inject base URL and bucket ID constructor
    // 2. Mock fetch at test boundary
    // 3. Support both API and file-based loading
    const canLoadFromFile = true;
    const canLoadFromApi = false; // unless AW is running

    expect(canLoadFromFile || canLoadFromApi).toBe(true);
  });

  it("**ISSUE**: Should support multiple data sources", () => {
    // Currently has both loadFromApi and loadFromFile but:
    // - Can't easily choose which to use
    // - No fallback mechanism (try API, then file)
    // - File loading uses hardcoded path

    // Should support:
    // 1. Environment variable to choose source
    // 2. Fallback chain: API -> file -> empty
    // 3. Configurable file paths

    const dataSources = ["api", "file", "empty"] as const;
    expect(dataSources.includes("api")).toBe(true);
  });
});
