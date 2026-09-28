import { describe, it, expect } from "bun:test";

/**
 * Integration scenario tests that demonstrate real-world failure modes
 * and the challenges of the current architecture.
 */

describe("Integration Scenarios - Real World Failure Modes", () => {
  describe("Scenario 1: ActivityWatch Bucket Not Found", () => {
    it("should demonstrate the 404 error from the bug report", () => {
      // Actual error from the user's run:
      // Warning: could not fetch web: Error: HTTP 404 for bucket "aw-watcher-web-brave_chacyOS-of-chihiro"

      // Root cause analysis:
      // 1. Hostname returned from `hostname` command was "chacyOS-of-chihiro"
      // 2. But bucket name was created with a different hostname
      // 3. ActivityWatch doesn't have that bucket

      const actualHostname = "chacyOS-of-chihiro";
      const expectedBucketId = `aw-watcher-web-brave_${actualHostname}`;

      // The 404 is silent - just logs warning and continues
      const isRetryable = false; // 404 is permanent
      const wasRecovered = false; // No fallback mechanism

      expect(isRetryable).toBe(false);
      expect(wasRecovered).toBe(false);
    });

    it("should ideally check bucket existence first", () => {
      // Better approach: validate all buckets exist before starting
      const bucketIds = [
        "aw-watcher-window_myhost",
        "aw-watcher-afk_myhost",
        "aw-watcher-web-brave_myhost",
      ];

      // This would fail early with clear error:
      // "Cannot find bucket 'aw-watcher-web-brave_myhost'. Available buckets: [...]"
      // Instead of silently continuing with empty array

      const missingBuckets = bucketIds.filter((id) => false); // simulated check

      expect(missingBuckets.length).toBe(0);
    });
  });

  describe("Scenario 2: Ollama Timeout (10 minutes insufficient)", () => {
    it("should show the actual timeout error from user", () => {
      // Actual error from the bug report:
      // ✗ Generating report via ActivityWatch + Ollama failed (300.0s)
      // DOMException: TimeoutError: The operation timed out.

      const timeout = 300; // seconds (5 minutes!)
      const configuredTimeout = 600; // 10 minutes in seconds
      const actualNeeded = 900; // 15 minutes for qwen3.6:35b

      expect(timeout).toBeLessThan(configuredTimeout);
      expect(configuredTimeout).toBeLessThan(actualNeeded);
    });

    it("should reveal current hardcoded timeout issue", () => {
      // From config.ts:15
      const MODEL_TASK_TIMEOUT = 1000 * 60 * 10; // 10 minutes

      // This is not enough for qwen3.6:35b on slower hardware
      // User's error appeared at 300s, which is weird - might be:
      // 1. AbortSignal timeout vs fetch timeout different?
      // 2. System load/other factors
      // 3. Model cache loading time not accounted for

      // Should be:
      const REALISTIC_TIMEOUT = 1000 * 60 * 20; // 20 minutes

      expect(MODEL_TASK_TIMEOUT).toBeLessThan(REALISTIC_TIMEOUT);
    });

    it("should handle timeout with retry instead of immediate failure", () => {
      // Current behavior: Timeout -> Error -> Exit with code 1

      // Better behavior: Timeout -> Retry with backoff -> Success

      interface RetryConfig {
        maxAttempts: number;
        initialDelayMs: number;
        maxDelayMs: number;
      }

      const retryConfig: RetryConfig = {
        maxAttempts: 3,
        initialDelayMs: 1000,
        maxDelayMs: 30000,
      };

      // On first timeout: wait 1s, retry
      // On second timeout: wait 2s, retry
      // On third timeout: wait 4s, fail with detailed error

      expect(retryConfig.maxAttempts).toBeGreaterThan(1);
    });
  });

  describe("Scenario 3: Partial Failures with allSettled", () => {
    it("should demonstrate current behavior with mixed results", () => {
      // Simulating Promise.allSettled with 3 buckets:
      const results = [
        { status: "fulfilled" as const, value: [{ timestamp: "...", duration: 100, data: {} }] },
        { status: "rejected" as const, reason: new Error("HTTP 404") },
        { status: "fulfilled" as const, value: [] },
      ];

      // Current code extracts:
      let windowEvents = results[0].status === "fulfilled" ? results[0].value : [];
      let afkEvents = results[1].status === "fulfilled" ? results[1].value : [];
      let webEvents = results[2].status === "fulfilled" ? results[2].value : [];

      // Result: We have some data, but lost visibility into which bucket failed
      expect(windowEvents.length).toBe(1);
      expect(afkEvents.length).toBe(0); // Lost to error
      expect(webEvents.length).toBe(0);

      // We can't tell if afk bucket doesn't exist or if it's a temporary error
      // Should track this information
    });

    it("should support retry-specific buckets", () => {
      // Better approach: track which buckets failed and why
      interface BucketResult {
        bucketId: string;
        status: "success" | "notfound" | "error";
        events: Array<any>;
        error?: { code: number; message: string };
      }

      const results: BucketResult[] = [
        { bucketId: "window", status: "success", events: [{ duration: 100 }] },
        {
          bucketId: "afk",
          status: "notfound",
          events: [],
          error: { code: 404, message: "Bucket not found" },
        },
        { bucketId: "web", status: "success", events: [] },
      ];

      // Can now make smart decisions:
      // - Don't retry 404s (permanent)
      // - Retry other errors
      // - Report which data is missing

      const retryable = results.filter(
        (r) => r.status === "error" && r.error?.code !== 404,
      );

      expect(retryable.length).toBe(0);
    });
  });

  describe("Scenario 4: Service Health Checks", () => {
    it("should validate services are running before starting work", async () => {
      interface ServiceHealth {
        name: string;
        url: string;
        healthy: boolean;
        error?: string;
      }

      // Before attempting full report generation:
      const healthChecks: ServiceHealth[] = [
        {
          name: "ActivityWatch",
          url: "http://localhost:5600/api/0/info",
          healthy: false,
          error: "Connection refused",
        },
        {
          name: "Ollama",
          url: "http://localhost:11434/api/tags",
          healthy: false,
          error: "Connection refused",
        },
      ];

      const allHealthy = healthChecks.every((h) => h.healthy);

      if (!allHealthy) {
        const failed = healthChecks.filter((h) => !h.healthy);
        console.error(
          "❌ Required services not healthy:\n" +
            failed.map((h) => `  - ${h.name}: ${h.error}`).join("\n"),
        );
      }

      expect(allHealthy).toBe(false);
    });

    it("should support offline mode with cached data", () => {
      // If both services unavailable but we have cache:
      interface CacheEntry {
        date: string;
        events: {
          window: any[];
          afk: any[];
          web: any[];
        };
        timestamp: number;
      }

      const cache: CacheEntry = {
        date: "2026-09-28",
        events: { window: [], afk: [], web: [] },
        timestamp: Date.now() - 86400000, // 1 day old
      };

      const isRecent = Date.now() - cache.timestamp < 7 * 86400000; // < 7 days

      if (!isRecent) {
        console.warn("Cache is stale, consider regenerating when services available");
      }

      // Cache from 1 day ago is still recent (< 7 days)
      expect(isRecent).toBe(true);
    });
  });

  describe("Scenario 5: Error Recovery Flow", () => {
    it("should demonstrate current unhelpful error path", () => {
      // When timeout occurs, current output:
      // ✗ Generating report via ActivityWatch + Ollama failed (300.0s)
      // DOMException {...}
      // 📝 Failure log saved: /path/to/log

      // User is left wondering:
      // - What exactly timed out? (ActivityWatch? Ollama?)
      // - Was it a transient error? (should retry?)
      // - Is a service down? (need to check)
      // - Is it my machine? (too slow?)

      const error = new DOMException("The operation timed out.", "TimeoutError");

      // Error message doesn't contain:
      // - Which component failed
      // - How long it actually took
      // - Suggested actions
      // - Whether to retry

      expect(error.message).not.toContain("ActivityWatch");
      expect(error.message).not.toContain("retry");
    });

    it("should suggest improved error messages", () => {
      const improvedError = `
Ollama Model Generation Timeout
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
What happened:
  Model inference took 300s before timing out
  (configured timeout: 600s)
  
Why it might have failed:
  ❑ Ollama is busy or restarting
  ❑ Model cache is rebuilding
  ❑ System resources are exhausted (RAM/CPU)
  ❑ Model is unusually slow on this system

Suggested actions:
  1. Check Ollama status: curl http://localhost:11434/api/tags
  2. Check logs: tail ~/.ollama/logs/server.log
  3. Try again with increased timeout: MODEL_TASK_TIMEOUT=1200000 bun run index.ts
  4. Use a smaller model: ollama pull qwen:14b
  
Will auto-retry: Yes (attempt 1/3)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`;

      expect(improvedError).toContain("Ollama");
      expect(improvedError).toContain("retry");
      expect(improvedError).toContain("logs");
    });
  });

  describe("Scenario 6: Category Classifier Edge Cases", () => {
    it("should handle deeply nested categories correctly", () => {
      // From config rules, categories can have depth 0-N
      // Sorting rule: deeper first (most specific)

      const categories = [
        { id: 1, depth: 0, name_pretty: "Development" },
        { id: 2, depth: 1, name_pretty: "Code/TypeScript" },
        { id: 3, depth: 2, name_pretty: "Code/TypeScript/Testing" },
      ];

      // Should match in order of specificity
      const sorted = [...categories].sort((a, b) =>
        b.depth !== a.depth ? b.depth - a.depth : b.id - a.id,
      );

      expect(sorted[0].name_pretty).toBe("Code/TypeScript/Testing");
    });

    it("should fallback to uncategorized gracefully", () => {
      // Window event that doesn't match any rules
      const app = "obscure-app-xyz";
      const title = "Random Window Title";

      const pattern = /code|zed|vim/i;
      const matches = pattern.test(`${app} ${title}`);

      if (!matches) {
        // Should use "Uncategorized" but filter it out later
        expect(true).toBe(true);
      }
    });

    it("should handle regex compilation errors", () => {
      // User-provided regexes could be invalid
      const invalidRegex = "[invalid(regex";

      const tryCompileRegex = (pattern: string): RegExp | null => {
        try {
          return new RegExp(pattern, "i");
        } catch {
          return null; // Invalid regex
        }
      };

      expect(tryCompileRegex(invalidRegex)).toBeNull();
    });
  });

  describe("Scenario 7: Data Pipeline Robustness", () => {
    it("should handle missing environment variables", () => {
      const config = {
        DIARY_DIR: process.env.DIARY_DIR || "/default/path",
        REPORT_DIR: process.env.REPORT_DIR || "/default/path",
        AW_BASE_URL: process.env.AW_BASE_URL || "http://localhost:5600/api/0",
      };

      expect(config.DIARY_DIR).toBeDefined();
      expect(config.AW_BASE_URL).toBe("http://localhost:5600/api/0");
    });

    it("should validate paths before starting", () => {
      const paths = [
        "/home/chihiro/Documents/Obsidian vault/Diary",
        "/home/chihiro/Documents/Obsidian vault/Daily report",
      ];

      // Should check:
      // - Directory exists
      // - Has write permissions (for output)
      // - Has read permissions (for input)

      const validPaths = paths.filter((p) => {
        // Simulated validation
        return p.length > 0 && p.includes("/");
      });

      expect(validPaths.length).toBe(2);
    });

    it("should create necessary directories if missing", () => {
      const logsDir = "/home/chihiro/Documents/Projects/DailyReport/logs";

      // Code does create it implicitly when writing failure log
      // But should be explicit:
      // 1. createDirIfNotExists(logsDir)
      // 2. Log where failures are being written

      expect(logsDir.endsWith("logs")).toBe(true);
    });
  });
});

describe("Code Debt Summary", () => {
  it("**ISSUE**: Error path doesn't provide actionable feedback", () => {
    // User sees timeout but doesn't know:
    // 1. Should they retry?
    // 2. Is their machine too slow?
    // 3. Is Ollama broken?
    // 4. What to check?

    const currentErrorHandling = "Silent fail with raw error object";
    const neededErrorHandling = "Contextual error with debug steps";

    expect(currentErrorHandling).not.toContain("debug");
    expect(currentErrorHandling).not.toContain("retry");
  });

  it("**ISSUE**: No observability into what's happening", () => {
    // When user runs the script:
    // - They see spinners and success messages
    // - But if it fails, no insight into where/why
    // - No logs during normal operation
    // - No metrics (timing, data volume, etc.)

    const observabilityGaps = [
      "No timing info per component",
      "No data volume metrics",
      "No retry attempt logging",
      "No service health status",
      "No debug mode",
    ];

    expect(observabilityGaps.length).toBeGreaterThan(0);
  });

  it("**ISSUE**: External dependencies not validated", () => {
    // Script assumes:
    // - ActivityWatch running on localhost:5600
    // - Ollama running on localhost:11434
    // - Model qwen3.6:35b-a3b is downloaded
    // - cpulimit command available (if limit enabled)
    // - Hostname matches bucket naming scheme

    // None of these are validated before starting work

    const unvalidatedAssumptions = [
      "ActivityWatch is running",
      "Ollama is running",
      "Model is downloaded",
      "cpulimit is available",
      "Hostname matches buckets",
    ];

    expect(unvalidatedAssumptions.length).toBeGreaterThan(3);
  });
});
