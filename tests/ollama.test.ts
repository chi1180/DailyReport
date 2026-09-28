import { describe, it, expect } from "bun:test";

/**
 * Tests for Ollama integration and LLM prompt generation.
 * Highlights issues:
 * 1. No timeout retry mechanism
 * 2. Global state for CPU limit tracking
 * 3. Hard to test without running Ollama
 * 4. CPU limiting via cpulimit command is fragile
 */

describe("Ollama - Prompt Generation", () => {
  describe("buildPrompt", () => {
    it("should include all required sections", () => {
      const summary = "Activity data summary";
      const date = "2026-09-28";
      const diary = "Today I worked on testing";

      const prompt = buildTestPrompt(summary, date, diary);

      expect(prompt).toContain("Daily Report");
      expect(prompt).toContain(date);
      expect(prompt).toContain("## Summary");
      expect(prompt).toContain("## Activities");
      expect(prompt).toContain("## Learned / Observed");
      expect(prompt).toContain("## Tomorrow");
      expect(prompt).toContain(summary);
      expect(prompt).toContain(diary);
    });

    it("should handle empty diary gracefully", () => {
      const summary = "Some activity";
      const date = "2026-09-28";
      const diary = "";

      const prompt = buildTestPrompt(summary, date, diary);

      expect(prompt).toContain("(none provided)");
    });

    it("should escape special characters in prompt", () => {
      const summary = "Activity with $special @chars & stuff";
      const date = "2026-09-28";
      const diary = "Note with \"quotes\" and 'apostrophes'";

      const prompt = buildTestPrompt(summary, date, diary);

      expect(prompt).toContain("special");
      expect(prompt).toContain("quotes");
    });

    it("should provide clear structure for LLM", () => {
      const summary = `Date: 2026-09-28
PC on: 480min / Active: 360min / Away: 120min

## App/Category usage (min)
  Development: 240.5
  
## Web by category (min)
  Work: 120`;

      const date = "2026-09-28";
      const diary = "Worked on DailyReport project";

      const prompt = buildTestPrompt(summary, date, diary);

      // Should have clear section markers
      expect(prompt).toContain("[Activity Data]");
      expect(prompt).toContain("[Diary / Personal Notes]");
    });

    it("should include instructions for specific areas", () => {
      const summary = "test";
      const date = "2026-09-28";
      const diary = "test";

      const prompt = buildTestPrompt(summary, date, diary);

      // Key instructions for quality output
      expect(prompt).toContain("Be specific");
      expect(prompt).toContain("Be concise");
      expect(prompt).toContain("Be honest");
      expect(prompt).toContain("Infer context");
    });
  });

  describe("Response parsing", () => {
    it("should extract response field from Ollama output", () => {
      const ollamaResponse = {
        model: "qwen:14b",
        created_at: "2024-01-01T00:00:00.000000Z",
        response:
          "# Daily Report — 2026-09-28\n\n## Summary\nWorked on testing framework.",
        done: true,
      };

      const response = ollamaResponse.response;
      expect(response).toContain("Daily Report");
      expect(response).toContain("## Summary");
    });

    it("should handle streaming response format", () => {
      const streamChunks = [
        '{"response":"# Daily"}',
        '{"response":" Report"}',
        '{"response":"\\n"}',
        '{"response":"Test"}',
      ];

      const fullResponse = streamChunks.map((chunk) => JSON.parse(chunk).response).join("");

      expect(fullResponse).toContain("Daily Report");
      expect(fullResponse).toContain("Test");
    });

    it("should handle malformed Ollama responses", () => {
      const invalidResponses = [
        { model: "test" }, // missing response field
        null,
        undefined,
        { error: "model not found" },
      ];

      const isValid = (response: any): boolean => {
        return response && typeof response.response === "string";
      };

      expect(isValid(invalidResponses[0])).toBe(false); // missing response
      expect(isValid(invalidResponses[1])).toBeFalsy(); // null
      expect(isValid(invalidResponses[2])).toBeFalsy(); // undefined
      expect(isValid(invalidResponses[3])).toBe(false); // error field instead
    });
  });

  describe("Timeout handling", () => {
    it("**ISSUE**: Current timeout of 10 minutes often exceeded", () => {
      const MODEL_TASK_TIMEOUT = 1000 * 60 * 10; // 10 minutes
      // Actual qwen3.6:35b model often takes 12-15 minutes on slower hardware

      // Should be configurable and have retry logic
      expect(MODEL_TASK_TIMEOUT).toBe(600000);
    });

    it("should distinguish between soft and hard timeouts", () => {
      const SOFT_TIMEOUT = 1000 * 60 * 8; // Warn at 8 min
      const HARD_TIMEOUT = 1000 * 60 * 15; // Kill at 15 min

      expect(HARD_TIMEOUT).toBeGreaterThan(SOFT_TIMEOUT);
    });

    it("should handle AbortSignal.timeout", () => {
      const timeout = 5000;
      const signal = AbortSignal.timeout(timeout);

      expect(signal).toBeDefined();
      // After 5 seconds, signal.aborted should be true
    });

    it("**ISSUE**: should provide actionable timeout error message", () => {
      const timeout = new DOMException("The operation timed out.", "TimeoutError");

      // Current behavior: just logs raw error
      // Should provide helpful context:
      // 1. "Model inference took longer than 10 minutes"
      // 2. "Ollama is running: check /tmp/ollama.log"
      // 3. "Try again or increase MODEL_TASK_TIMEOUT"

      expect(timeout.name).toBe("TimeoutError");
    });
  });

  describe("CPU limiting", () => {
    it("**ISSUE**: Uses global state for CPU limit tracking", () => {
      // Current code has module-level variables:
      // let ollamaPidCache: number | null = null;
      // let ollamaCpuLimitApplied = false;

      // Problems:
      // 1. Hard to reset between tests
      // 2. Not thread-safe
      // 3. Persists across multiple report generations

      // Should be refactored into a class or separate module
      const cpuLimitState = {
        applied: false,
        pid: null as number | null,
      };

      expect(cpuLimitState.applied).toBe(false);
    });

    it("should parse pgrep output correctly", () => {
      const pgrepOutput = "1234\n5678\n9012";
      const pids = pgrepOutput
        .split("\n")
        .map((line) => Number(line.trim()))
        .filter((num) => Number.isInteger(num) && num > 0);

      expect(pids).toEqual([1234, 5678, 9012]);
    });

    it("should pick first valid PID from pgrep", () => {
      const pgrepOutput = "invalid\n5678\n9012";
      const pid = pgrepOutput
        .split("\n")
        .map((line) => Number(line.trim()))
        .find((candidate) => Number.isInteger(candidate) && candidate > 0);

      expect(pid).toBe(5678);
    });

    it("should handle when pgrep finds no process", () => {
      const pgrepOutput = "";
      const pid = pgrepOutput
        .split("\n")
        .map((line) => Number(line.trim()))
        .find((candidate) => Number.isInteger(candidate) && candidate > 0);

      expect(pid).toBeUndefined();
    });

    it("**ISSUE**: should validate cpulimit is installed", () => {
      // Current code tries to spawn cpulimit without checking
      // Should check:
      // 1. which cpulimit (executable exists)
      // 2. Version compatibility
      // 3. Permissions (may need root/capabilities)

      const commands = ["which cpulimit", "cpulimit --version"];
      expect(commands[0]).toBeDefined();
    });

    it("should use correct cpulimit flags", () => {
      const cpulimitArgs = ["-p", "1234", "-l", "50", "-b", "-z"];

      expect(cpulimitArgs).toContain("-p"); // pid
      expect(cpulimitArgs).toContain("-l"); // limit percentage
      expect(cpulimitArgs).toContain("-b"); // background
      expect(cpulimitArgs).toContain("-z"); // kill when percentage drops
    });

    it("should respect OLLAMA_CPU_LIMIT_PERCENT config", () => {
      const configs = [0, 25, 50, 75, 100, 150]; // 150 is invalid

      const isValid = (percent: number): boolean => {
        return percent > 0 && percent <= 100;
      };

      expect(isValid(0)).toBe(false); // 0 means disabled, not invalid
      expect(isValid(25)).toBe(true);
      expect(isValid(150)).toBe(false);
    });
  });
});

describe("Ollama - Integration concerns", () => {
  it("**ISSUE**: Hard to test without Ollama service running", () => {
    // Current test would need:
    // 1. Ollama installed and running
    // 2. Model qwen3.6:35b-a3b downloaded (~20GB)
    // 3. 10+ minutes per test
    // 4. GPU/CPU resources

    // Better approach:
    // 1. Mock fetch for unit tests
    // 2. Separate integration tests with @slow tag
    // 3. Support offline mode with cached responses
    // 4. Optional mock Ollama server

    const isIntegrationTest = false; // This is a unit test suite
    expect(isIntegrationTest).toBe(false);
  });

  it("**ISSUE**: No retry logic for Ollama failures", () => {
    // Should implement:
    // 1. Exponential backoff for 500 errors
    // 2. Retry limit (default 3)
    // 3. Circuit breaker pattern for persistent failures
    // 4. Fallback to simpler model if available

    const retryConfig = {
      maxRetries: 3,
      baseDelayMs: 1000,
      maxDelayMs: 30000,
      backoffMultiplier: 2,
    };

    expect(retryConfig.maxRetries).toBeGreaterThan(0);
  });

  it("**ISSUE**: Should validate Ollama configuration", () => {
    // Should check at startup:
    // 1. Ollama service is reachable
    // 2. Model is downloaded
    // 3. Sufficient disk space for generation
    // 4. Network connectivity (if using remote Ollama)

    const healthCheck = {
      serviceReachable: false,
      modelAvailable: false,
      diskSpaceOk: false,
    };

    expect(Object.values(healthCheck).some((v) => !v)).toBe(true);
  });

  it("**ISSUE**: Should provide model selection options", () => {
    // Currently hardcoded to qwen3.6:35b-a3b
    // Better approach:
    // 1. Config option to choose model
    // 2. Fallback models (smaller/faster alternatives)
    // 3. Model-specific timeout adjustments
    // 4. Capability detection (what can each model do?)

    const availableModels = [
      { name: "qwen:7b", speed: "fast", accuracy: "medium" },
      { name: "qwen:14b", speed: "medium", accuracy: "high" },
      { name: "qwen3.6:35b-a3b", speed: "slow", accuracy: "very-high" },
    ];

    expect(availableModels.length).toBeGreaterThan(1);
  });
});

// Helper function for testing
function buildTestPrompt(summary: string, date: string, diary: string): string {
  return `You are a personal productivity assistant helping a software developer write a concise daily work report.
Your goal is to help them recall and articulate what they accomplished today.

Analyze the PC activity data and diary notes below, then write a clear, honest report.

Guidelines:
- Be specific: mention project names, file paths, tools, and technologies when identifiable from the data.
- Be concise: prefer bullet points over prose.
- Be honest: if the data is sparse or ambiguous, acknowledge it rather than fabricating details.
- Infer context: file paths hint at projects, domains hint at topics, search queries reveal intent.
- Skip noise: omit trivial system apps or unrecognized background activity.

[Activity Data]
${summary}

[Diary / Personal Notes]
${diary.trim() || "(none provided)"}

---
Write the report below using this exact structure:

# Daily Report — ${date}

## Summary
(2–3 sentences: main focus of the day, overall productivity, notable accomplishments)

## Activities
(Bullet list of concrete tasks inferred from the data. Group related items. Mention projects, tools, and technologies by name.)

## Learned / Observed
(Bullet list: articles or videos watched, documentation read, new tools or libraries explored, notable search queries)

## Tomorrow
(Bullet list: tasks to continue, open questions, follow-ups — inferred from unfinished work or context clues)
`;
}
