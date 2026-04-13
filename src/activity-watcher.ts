import { parseArgs } from "util";
import { readFileSync, writeFileSync } from "fs";
import { execSync } from "child_process";
import {
  JST_OFFSET_MS,
  AW_BASE_URL,
  MIN_WINDOW_SEC,
  MIN_APP_SEC,
  MIN_WEB_SEC,
  OLLAMA_URL,
  DEFAULT_MODEL,
} from "./config";
import type {
  Category,
  AwEvent,
  AwBucketExport,
  AppStat,
  WebStat,
  DailySummary,
  CategoryExport,
} from "./types";
import path from "node:path";

// ─── Category Classifier ──────────────────────────────────────────────────────

class CategoryClassifier {
  private rules: Array<{ pattern: RegExp | null; label: string }>;

  constructor(categories: Category[]) {
    // Most specific (deepest, then highest id) first so they win on match
    const sorted = [...categories].sort((a, b) =>
      b.depth !== a.depth ? b.depth - a.depth : b.id - a.id,
    );

    this.rules = sorted.map((cat) => ({
      pattern:
        cat.rule.type === "regex" && cat.rule.regex
          ? new RegExp(cat.rule.regex, cat.rule.ignore_case ? "i" : "")
          : null,
      label: cat.name_pretty,
    }));
  }

  /** Match app + title against rules. Returns the most specific hit, or "Uncategorized". */
  classify(app: string, title: string): string {
    const haystack = `${app} ${title}`;
    for (const { pattern, label } of this.rules) {
      if (pattern?.test(haystack)) return label;
    }
    return "Uncategorized";
  }
}

// ─── Date helpers ─────────────────────────────────────────────────────────────

/** Shift a UTC timestamp to JST (no external library needed). */
function toJst(isoTimestamp: string): Date {
  return new Date(new Date(isoTimestamp).getTime() + JST_OFFSET_MS);
}

/** Check if a JST-shifted Date falls on targetDate ("YYYY-MM-DD"). */
function onTargetDate(jstDate: Date, targetDate: string): boolean {
  const [y, m, d] = targetDate.split("-").map(Number);
  return (
    jstDate.getUTCFullYear() === y &&
    jstDate.getUTCMonth() + 1 === m &&
    jstDate.getUTCDate() === d
  );
}

// ─── AW API loader ────────────────────────────────────────────────────────────

async function fetchBucketEvents(
  bucketId: string,
  targetDate: string,
): Promise<AwEvent[]> {
  const [y, m, d] = targetDate.split("-").map(Number);
  const startUtc = new Date(Date.UTC(y || 1, (m || 1) - 1, d) - JST_OFFSET_MS);
  const endUtc = new Date(startUtc.getTime() + 86_400_000);

  const url =
    `${AW_BASE_URL}/buckets/${bucketId}/events` +
    `?start=${startUtc.toISOString()}&end=${endUtc.toISOString()}&limit=50000`;

  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} for bucket "${bucketId}"`);
  return res.json() as Promise<AwEvent[]>;
}

function getHostname(): string {
  return execSync("hostname").toString().trim();
}

async function loadFromApi(targetDate: string) {
  const host = getHostname();
  const ids = {
    window: `aw-watcher-window_${host}`,
    afk: `aw-watcher-afk_${host}`,
    web: `aw-watcher-web-brave_${host}`,
  };

  const settled = await Promise.allSettled([
    fetchBucketEvents(ids.window, targetDate),
    fetchBucketEvents(ids.afk, targetDate),
    fetchBucketEvents(ids.web, targetDate),
  ]);

  const extract = (
    r: PromiseSettledResult<AwEvent[]>,
    name: string,
  ): AwEvent[] => {
    if (r.status === "fulfilled") return r.value;
    console.error(`  Warning: could not fetch ${name}: ${r.reason}`);
    return [];
  };

  return {
    window: extract(settled[0], "window"),
    afk: extract(settled[1], "afk"),
    web: extract(settled[2], "web"),
  };
}

// ─── JSON export loader ───────────────────────────────────────────────────────

function loadFromFile(path: string, targetDate: string): AwEvent[] {
  const raw: AwBucketExport = JSON.parse(readFileSync(path, "utf8"));
  const rawValues = Object.values(raw.buckets);
  if (rawValues.length > 0) {
    const events = rawValues[0]?.events || [];
    return events.filter((e) => onTargetDate(toJst(e.timestamp), targetDate));
  } else {
    console.error(`  Warning: no "buckets" found in ${path}`);
    return [];
  }
}

// ─── Aggregation ──────────────────────────────────────────────────────────────

function summarizeWindow(
  events: AwEvent[],
  cls: CategoryClassifier,
): AppStat[] {
  const totals = new Map<string, number>();

  for (const e of events) {
    if (e.duration < MIN_WINDOW_SEC) continue;
    const cat = cls.classify(
      String(e.data.app ?? ""),
      String(e.data.title ?? ""),
    );

    // Ignore "Uncategorized" to reduce noise
    if (cat === "Uncategorized") continue;
    totals.set(cat, (totals.get(cat) ?? 0) + e.duration);
  }

  return [...totals.entries()]
    .filter(([, sec]) => sec >= MIN_APP_SEC)
    .sort((a, b) => b[1] - a[1])
    .map(([label, sec]) => ({
      label,
      minutes: Math.round((sec / 60) * 10) / 10,
    }));
}

function summarizeAfk(events: AwEvent[]): { active: number; afk: number } {
  let active = 0,
    afk = 0;
  for (const e of events) {
    if (e.data.status === "not-afk") active += e.duration;
    else afk += e.duration;
  }
  return { active: Math.round(active / 60), afk: Math.round(afk / 60) };
}

function extractDomain(url: string): string | null {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

function summarizeWeb(events: AwEvent[], cls: CategoryClassifier) {
  const domainSec = new Map<string, number>();
  const domainTitles = new Map<string, string[]>();

  for (const e of events) {
    if (e.duration < MIN_WEB_SEC) continue;
    const domain = extractDomain(String(e.data.url ?? ""));
    if (!domain) continue;

    domainSec.set(domain, (domainSec.get(domain) ?? 0) + e.duration);

    const titles = domainTitles.get(domain) ?? [];
    if (titles.length < 2) {
      const t = String(e.data.title ?? "")
        .replace(/ [-|] (Brave|YouTube|Google|GitHub).*$/, "")
        .slice(0, 45);
      if (t && !titles.includes(t)) titles.push(t);
      domainTitles.set(domain, titles);
    }
  }

  const catSec: Record<string, number> = {};
  const details: WebStat[] = [];

  for (const [domain, sec] of [...domainSec.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20)) {
    const mins = Math.round((sec / 60) * 10) / 10;
    if (mins < 0.5) continue;

    // Classify by matching domain string against category rules
    const category = cls.classify(domain, domain);
    // Ignore "Uncategorized" to reduce noise
    if (category === "Uncategorized") continue;

    catSec[category] = (catSec[category] ?? 0) + sec;
    details.push({
      domain,
      category,
      minutes: mins,
      sampleTitles: domainTitles.get(domain) ?? [],
    });
  }

  const byCategory = Object.fromEntries(
    Object.entries(catSec)
      .sort((a, b) => b[1] - a[1])
      .map(([cat, sec]) => [cat, Math.round((sec / 60) * 10) / 10]),
  );

  return { byCategory, details };
}

function extractWorkContext(
  windowEvents: AwEvent[],
  webEvents: AwEvent[],
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const add = (s: string) => {
    if (!seen.has(s) && out.length < 25) {
      seen.add(s);
      out.push(s);
    }
  };

  for (const e of windowEvents) {
    if (e.duration < 5) continue;
    const app = String(e.data.app ?? "");
    const title = String(e.data.title ?? "");

    if (/zed/i.test(app)) {
      const m = title.match(/^(.+?) [—–-]/);
      if (m) add(`Editing: ${m[1]}`);
    }
    if (/obsidian/i.test(app)) {
      const m = title.match(/^(.+?) - Obsidian/);
      if (m && m[1] !== "Obsidian vault") add(`Note: ${m[1]}`);
    }
    if (/ghostty|terminal/i.test(app)) {
      const m = title.match(/^(~\/\S+|\/[\w/.]+)/);
      if (m) add(`Terminal: ${m[0]}`);
    }
  }

  for (const e of webEvents) {
    if (e.duration < 3) continue;
    try {
      const u = new URL(String(e.data.url ?? ""));
      if (/search\.brave|google\.com/.test(u.hostname)) {
        const q = u.searchParams.get("q");
        if (q) add(`Search: ${decodeURIComponent(q).slice(0, 60)}`);
      }
    } catch {
      /* ignore invalid URLs */
    }
  }

  return out;
}

// ─── Compact summary text ─────────────────────────────────────────────────────

function buildSummary(s: DailySummary): string {
  const lines = [
    `Date: ${s.date}`,
    `PC on: ${s.totalMinutes}min / Active: ${s.activeMinutes}min / Away: ${s.afkMinutes}min`,
    "",
    "## App/Category usage (min)",
    ...s.apps.slice(0, 12).map((a) => `  ${a.label}: ${a.minutes}`),
    "",
    "## Web by category (min)",
    ...Object.entries(s.webByCategory).map(([c, m]) => `  ${c}: ${m}`),
  ];

  if (s.webDetails.length) {
    lines.push("", "## Top sites");
    for (const d of s.webDetails.slice(0, 10)) {
      const t = d.sampleTitles.join(" / ");
      lines.push(
        `  ${d.domain} [${d.category}] ${d.minutes}min${t ? ": " + t : ""}`,
      );
    }
  }

  if (s.workContext.length) {
    lines.push("", "## Work context");
    lines.push(...s.workContext.map((c) => `  ${c}`));
  }

  return lines.join("\n");
}

// ─── Ollama ───────────────────────────────────────────────────────────────────

function buildPrompt(summary: string, date: string, diary: string): string {
  return `\
You are a daily work report assistant.
Write a concise daily report in English based on the PC activity data & diary context below.

[Activity Data]
${summary}

[Diary Context]
${diary}

[Output format - write in English]
# Daily report ${date}

## Today's summary
(A brief 2-3 sentences summary of the day's work)
(Bullet points of activities inferred from apps and websites. Specify project names and tools.)

## Learned / Observed
(YouTbue, articles read, AI tools used, search queries, etc...)

## For tomorrow
(Continuing tasks, points of concern, etc...)
`;
}

async function callOllama(model: string, prompt: string): Promise<string> {
  const res = await fetch(OLLAMA_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model, prompt, stream: false }),
    signal: AbortSignal.timeout(180_000),
  });
  if (!res.ok) throw new Error(`Ollama ${res.status}: ${await res.text()}`);
  const json = (await res.json()) as { response: string };
  return json.response;
}

export async function generateReport(
  targetDate: string,
  diaryContext: string,
): Promise<string> {
  // ── Load category rules ───────────────────────────────────────────────────────
  const catData: CategoryExport = JSON.parse(
    readFileSync(path.join(__dirname, "./aw-category-export.json"), "utf8"),
  );
  const classifier = new CategoryClassifier(catData.categories);

  // ── Load events ───────────────────────────────────────────────────────────────
  let windowEvents: AwEvent[], afkEvents: AwEvent[], webEvents: AwEvent[];
  ({
    window: windowEvents,
    afk: afkEvents,
    web: webEvents,
  } = await loadFromApi(targetDate));

  // ── Aggregate ─────────────────────────────────────────────────────────────────
  const apps = summarizeWindow(windowEvents, classifier);
  const { active, afk } = summarizeAfk(afkEvents);
  const { byCategory, details } = summarizeWeb(webEvents, classifier);
  const workContext = extractWorkContext(windowEvents, webEvents);

  const summary: DailySummary = {
    date: targetDate,
    activeMinutes: active,
    afkMinutes: afk,
    totalMinutes: active + afk,
    apps,
    webByCategory: byCategory,
    webDetails: details,
    workContext,
  };

  const compact = buildSummary(summary);

  // ── Generate report via Ollama ────────────────────────────────────────────────
  let report: string;
  try {
    report = await callOllama(
      DEFAULT_MODEL,
      buildPrompt(compact, targetDate, diaryContext),
    );
  } catch (error) {
    throw error;
  }
  return report;
}
