# DailyReport

DailyReport is a local-first automation tool that generates a daily work report in Markdown from:

- **ActivityWatch** activity data (apps, browser, AFK)
- **Obsidian diary context** (today's note)
- **Ollama** (LLM-based report writing)

The generated report is saved directly into your Obsidian vault.

---

## Why this project

I built this as a personal workflow helper to avoid writing end-of-day reports from scratch.
It converts raw activity logs into a concise, readable summary of what I worked on, what I learned, and what to do next.

---

## Features

- Pulls daily events from local ActivityWatch buckets
- Converts timestamps to JST and filters by target date
- Classifies activity by regex-based category rules
- Summarizes:
  - app/category usage time
  - active vs away time
  - top web domains and categories
  - inferred work context (files edited, notes, searches)
- Combines activity summary + diary notes into an LLM prompt
- Generates and writes a Markdown report to Obsidian

---

## Tech stack

- **Runtime:** [Bun](https://bun.sh)
- **Language:** TypeScript (strict mode)
- **Local services:**
  - ActivityWatch API (`http://localhost:5600/api/0`)
  - Ollama API (`http://localhost:11434/api/generate`)

No external cloud dependency is required for report generation.

---

## Project structure

```text
.
├── index.ts                     # Entry point / orchestrator
├── src/
│   ├── activity-watcher.ts      # Fetch, classify, summarize, prompt, generate
│   ├── obsidian.ts              # Read diary / write report in vault
│   ├── config.ts                # Paths, API URLs, thresholds, model
│   ├── types.ts                 # Type definitions
│   └── aw-category-export.json  # Category rules exported from ActivityWatch
├── tsconfig.json
└── package.json
```

---

## Requirements

1. [Bun](https://bun.sh) installed
2. [ActivityWatch](https://activitywatch.net/) running locally
3. [Ollama](https://ollama.com/) running locally with your target model available
4. Obsidian vault with diary and report directories

---

## Setup

### 1) Install dependencies

```bash
bun install
```

### 2) Configure paths and endpoints

Edit `src/config.ts`:

- `DIARY_DIR` - directory containing daily diary notes (e.g. `YYYY-MM-DD.md`)
- `REPORT_DIR` - directory where generated report files will be saved
- `AW_BASE_URL` - ActivityWatch API base URL
- `OLLAMA_URL` - Ollama generate endpoint
- `DEFAULT_MODEL` - Ollama model name

You can also tune minimum event duration thresholds in the same file.

### 3) Ensure ActivityWatch buckets exist

This project fetches these buckets using your hostname:

- `aw-watcher-window_<hostname>`
- `aw-watcher-afk_<hostname>`
- `aw-watcher-web-brave_<hostname>`

If you use a different browser watcher, update `src/activity-watcher.ts` accordingly.

---

## Usage

Run:

```bash
bun run index.ts
```

The script will:

1. Read today's diary note
2. Generate today's report from ActivityWatch + Ollama
3. Write the report to `REPORT_DIR/YYYY-MM-DD.md`

---

## Output format

The generated report uses this structure:

- `# Daily report YYYY-MM-DD`
- `## Today's summary`
- `## Learned / Observed`
- `## For tomorrow`

---

## Notes

- This project is optimized for my personal environment (JST + Obsidian workflow).
- It can be adapted for other timezones, bucket names, and note-taking layouts.
- Since this uses local services, make sure ActivityWatch and Ollama are running before execution.

---

## License

This is a personal project shared for learning and reference.
Add a license file if you want to define reuse terms explicitly.
