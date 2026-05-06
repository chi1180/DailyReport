// =============================================================================
// Path
// =============================================================================
export const DIARY_DIR = "/home/chihiro/Documents/Obsidian vault/Diary";
export const REPORT_DIR = "/home/chihiro/Documents/Obsidian vault/Daily report";

// =============================================================================
// Activity watcher & LLM
// =============================================================================
export const AW_BASE_URL = "http://localhost:5600/api/0";
export const OLLAMA_URL = "http://localhost:11434/api/generate";
export const DEFAULT_MODEL = "hf.co/LiquidAI/LFM2-24B-A2B-GGUF:Q4_K_M";
export const OLLAMA_CPU_LIMIT_PERCENT = 0; // 0 disables CPU throttling, 1-100 enables
export const JST_OFFSET_MS = 9 * 60 * 60 * 1000;
export const MODEL_TASK_TIMEOUT = 1000 * 60 * 10; // 10 minutes
export const MIN_WINDOW_SEC = 1; // drop window events shorter than this
export const MIN_WEB_SEC = 3; // drop web events shorter than this
export const MIN_APP_SEC = 30; // drop apps with less than this total
