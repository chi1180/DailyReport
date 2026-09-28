import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import * as path from "path";

// Mock data for testing
const mockAwEvent = (overrides = {}) => ({
  timestamp: "2026-09-28T00:00:00Z",
  duration: 120,
  data: {
    app: "code",
    title: "example.ts",
  },
  ...overrides,
});

const mockCategory = (overrides = {}) => ({
  id: 1,
  name: ["development", "code"],
  name_pretty: "Development",
  rule: {
    type: "regex" as const,
    regex: "code|zed|vim",
    ignore_case: true,
  },
  depth: 2,
  ...overrides,
});

// Helper to safely extract domain from URL
function extractDomain(url: string): string | null {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

describe("Activity Watcher - Data Parsing", () => {
  describe("extractDomain", () => {
    it("should extract domain from valid URL", () => {
      expect(extractDomain("https://github.com/user/repo")).toBe("github.com");
      expect(extractDomain("http://localhost:3000")).toBe("localhost");
      expect(extractDomain("https://api.example.com/v1")).toBe("api.example.com");
    });

    it("should return null for invalid URLs", () => {
      expect(extractDomain("not a url")).toBeNull();
      expect(extractDomain("")).toBeNull();
      expect(extractDomain("just some text")).toBeNull();
    });

    it("should handle URLs with ports and paths", () => {
      expect(extractDomain("https://localhost:8080/api")).toBe("localhost");
      expect(extractDomain("http://192.168.1.1:5600")).toBe("192.168.1.1");
    });
  });

  describe("Date shifting (JST offset)", () => {
    it("should correctly shift UTC to JST", () => {
      const JST_OFFSET_MS = 9 * 60 * 60 * 1000;
      const utcDate = new Date("2026-09-28T00:00:00Z");
      const jstDate = new Date(utcDate.getTime() + JST_OFFSET_MS);

      // JST is 9 hours ahead
      expect(jstDate.getUTCHours()).toBe(9);
    });

    it("should identify dates correctly across day boundary", () => {
      const JST_OFFSET_MS = 9 * 60 * 60 * 1000;
      const targetDate = "2026-09-28";
      const [y, m, d] = targetDate.split("-").map(Number);

      // Event at 23:00 UTC should be next day in JST
      const eventUtc = new Date("2026-09-28T23:00:00Z");
      const jstDate = new Date(eventUtc.getTime() + JST_OFFSET_MS);

      const isOnTargetDate =
        jstDate.getUTCFullYear() === y &&
        jstDate.getUTCMonth() + 1 === m &&
        jstDate.getUTCDate() === d;

      // 23:00 UTC + 9 hours = 08:00 JST next day
      expect(isOnTargetDate).toBe(false);
      expect(jstDate.getUTCDate()).toBe(d + 1);
    });
  });

  describe("Window events aggregation", () => {
    it("should filter events below MIN_WINDOW_SEC threshold", () => {
      const MIN_WINDOW_SEC = 1;
      const events = [
        mockAwEvent({ duration: 0.5 }), // too short
        mockAwEvent({ duration: 1 }), // exactly at threshold
        mockAwEvent({ duration: 120 }), // good
      ];

      const filtered = events.filter((e) => e.duration >= MIN_WINDOW_SEC);
      expect(filtered.length).toBe(2);
    });

    it("should aggregate and sort by duration", () => {
      const events = [
        mockAwEvent({ data: { app: "code", title: "a.ts" }, duration: 100 }),
        mockAwEvent({ data: { app: "code", title: "b.ts" }, duration: 50 }),
        mockAwEvent({ data: { app: "code", title: "c.ts" }, duration: 200 }),
      ];

      const totals = new Map<string, number>();
      for (const e of events) {
        const key = String(e.data.app || "");
        totals.set(key, (totals.get(key) ?? 0) + e.duration);
      }

      const sorted = [...totals.entries()].sort((a, b) => b[1] - a[1]);
      expect(sorted[0][1]).toBe(350); // total duration
    });

    it("should round minutes to one decimal place", () => {
      const seconds = 125; // 2.083... minutes
      const minutes = Math.round((seconds / 60) * 10) / 10;
      expect(minutes).toBe(2.1);
    });
  });

  describe("AFK time calculation", () => {
    it("should sum active and away time separately", () => {
      const events = [
        mockAwEvent({ data: { status: "not-afk" }, duration: 3600 }), // 1 hour active
        mockAwEvent({ data: { status: "not-afk" }, duration: 1800 }), // 30 min active
        mockAwEvent({ data: { status: "afk" }, duration: 7200 }), // 2 hours away
      ];

      let active = 0,
        afk = 0;
      for (const e of events) {
        if (e.data.status === "not-afk") active += e.duration;
        else afk += e.duration;
      }

      expect(Math.round(active / 60)).toBe(90); // minutes
      expect(Math.round(afk / 60)).toBe(120); // minutes
    });
  });

  describe("Web domain extraction and categorization", () => {
    it("should extract domains and titles from web events", () => {
      const events = [
        mockAwEvent({
          data: { url: "https://github.com/user/project", title: "GitHub - User/Project" },
          duration: 300,
        }),
        mockAwEvent({
          data: { url: "https://localhost:3000", title: "Local App" },
          duration: 150,
        }),
      ];

      const domainSec = new Map<string, number>();
      const domainTitles = new Map<string, string[]>();

      for (const e of events) {
        const domain = extractDomain(String(e.data.url ?? ""));
        if (!domain) continue;

        domainSec.set(domain, (domainSec.get(domain) ?? 0) + e.duration);

        const titles = domainTitles.get(domain) ?? [];
        if (titles.length < 2) {
          const t = String(e.data.title ?? "").slice(0, 45);
          if (t && !titles.includes(t)) titles.push(t);
          domainTitles.set(domain, titles);
        }
      }

      expect(domainSec.get("github.com")).toBe(300);
      expect(domainSec.get("localhost")).toBe(150);
      expect(domainTitles.get("github.com")).toContain("GitHub - User/Project");
    });

    it("should respect MIN_WEB_SEC filter", () => {
      const MIN_WEB_SEC = 3;
      const events = [
        mockAwEvent({ data: { url: "https://example.com" }, duration: 2 }), // filtered
        mockAwEvent({ data: { url: "https://example.com" }, duration: 5 }), // kept
      ];

      const filtered = events.filter((e) => e.duration >= MIN_WEB_SEC);
      expect(filtered.length).toBe(1);
    });

    it("should handle invalid URLs gracefully", () => {
      const events = [
        mockAwEvent({
          data: { url: "not a valid url", title: "broken" },
          duration: 100,
        }),
      ];

      let validCount = 0;
      for (const e of events) {
        const domain = extractDomain(String(e.data.url ?? ""));
        if (domain) validCount++;
      }

      expect(validCount).toBe(0);
    });
  });

  describe("Work context extraction", () => {
    it("should extract file names from Zed editor", () => {
      const windowEvents = [
        mockAwEvent({
          data: { app: "zed", title: "test.ts — Zed" },
          duration: 300,
        }),
        mockAwEvent({
          data: { app: "zed", title: "config.json — Zed" },
          duration: 150,
        }),
      ];

      const extracted: string[] = [];
      for (const e of windowEvents) {
        if (e.duration < 5) continue;
        const app = String(e.data.app ?? "");
        const title = String(e.data.title ?? "");

        if (/zed/i.test(app)) {
          const m = title.match(/^(.+?) [—–-]/);
          if (m) extracted.push(`Editing: ${m[1]}`);
        }
      }

      expect(extracted).toContain("Editing: test.ts");
      expect(extracted).toContain("Editing: config.json");
    });

    it("should extract Obsidian notes", () => {
      const windowEvents = [
        mockAwEvent({
          data: { app: "obsidian", title: "Daily Notes - Obsidian" },
          duration: 300,
        }),
        mockAwEvent({
          data: { app: "obsidian", title: "Project Alpha - Obsidian" },
          duration: 150,
        }),
      ];

      const extracted: string[] = [];
      for (const e of windowEvents) {
        if (e.duration < 5) continue;
        const app = String(e.data.app ?? "");
        const title = String(e.data.title ?? "");

        if (/obsidian/i.test(app)) {
          const m = title.match(/^(.+?) - Obsidian/);
          if (m && m[1] !== "Obsidian vault") extracted.push(`Note: ${m[1]}`);
        }
      }

      expect(extracted).toContain("Note: Project Alpha");
      expect(extracted).toContain("Note: Daily Notes"); // Both notes are extracted
    });

    it("should handle special characters in titles", () => {
      const windowEvents = [
        mockAwEvent({
          data: { app: "zed", title: "async–utils.rs — Zed" },
          duration: 100,
        }),
        mockAwEvent({
          data: { app: "zed", title: "module-test.js — Zed" },
          duration: 100,
        }),
      ];

      const extracted: string[] = [];
      for (const e of windowEvents) {
        const app = String(e.data.app ?? "");
        const title = String(e.data.title ?? "");
        if (/zed/i.test(app)) {
          const m = title.match(/^(.+?) [—–-]/);
          if (m) extracted.push(`Editing: ${m[1]}`);
        }
      }

      expect(extracted.length).toBe(2);
      expect(extracted[0]).toMatch(/async/);
    });

    it("should deduplicate work context items", () => {
      const items = ["Editing: test.ts", "Editing: test.ts", "Terminal: ~/project"];
      const seen = new Set<string>();
      const unique: string[] = [];

      for (const item of items) {
        if (!seen.has(item)) {
          seen.add(item);
          unique.push(item);
        }
      }

      expect(unique.length).toBe(2);
    });
  });

  describe("Summary text building", () => {
    it("should format all sections correctly", () => {
      const lines = [
        "Date: 2026-09-28",
        "PC on: 480min / Active: 360min / Away: 120min",
        "",
        "## App/Category usage (min)",
        "  Development: 240.5",
        "",
        "## Web by category (min)",
        "  Work: 120",
      ];

      const text = lines.join("\n");
      expect(text).toContain("Date: 2026-09-28");
      expect(text).toContain("PC on:");
      expect(text).toContain("## App/Category usage");
      expect(text).toContain("## Web by category");
    });
  });
});

describe("Activity Watcher - Data Flow", () => {
  it("should handle empty event arrays gracefully", () => {
    const events: typeof mockAwEvent[] = [];

    let active = 0;
    for (const e of events) {
      if (e.data.status === "not-afk") active += e.duration;
    }

    expect(active).toBe(0);
  });

  it("should handle missing data fields", () => {
    const events = [
      {
        timestamp: "2026-09-28T00:00:00Z",
        duration: 120,
        data: {},
      },
    ];

    const apps: string[] = [];
    for (const e of events) {
      const app = String(e.data.app ?? "");
      if (app) apps.push(app);
    }

    expect(apps.length).toBe(0);
  });

  it("should handle very long event sequences", () => {
    const events = Array.from({ length: 1000 }, (_, i) =>
      mockAwEvent({
        duration: Math.random() * 600,
        data: { app: `app-${i % 10}`, title: `window-${i}` },
      }),
    );

    expect(events.length).toBe(1000);

    // Should not crash when processing
    let totalDuration = 0;
    for (const e of events) {
      totalDuration += e.duration;
    }

    expect(totalDuration).toBeGreaterThan(0);
  });
});
