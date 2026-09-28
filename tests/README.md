# DailyReport Test Suite

This directory contains comprehensive tests for the DailyReport project, with a focus on identifying and documenting code quality issues.

## Running Tests

```bash
# Run all tests
bun test

# Watch mode
bun test --watch

# Run specific test file
bun test tests/activity-watcher.test.ts
```

## Test Coverage

### 1. `activity-watcher.test.ts` - Data Processing Logic
Tests for the core logic that processes ActivityWatch data:

- **Domain extraction**: Parsing URLs to extract hostnames
- **Date shifting**: Converting UTC timestamps to JST
- **Event aggregation**: Summing durations by category
- **AFK tracking**: Calculating active vs idle time
- **Work context extraction**: Parsing editor/terminal window titles
- **Data validation**: Handling missing/invalid fields

✅ **Status**: Data processing logic is generally sound

---

### 2. `fetch-utils.test.ts` - Network and API Issues
Tests highlighting critical issues with data fetching:

#### ⚠️ **CRITICAL ISSUES FOUND**

**Issue #1: Silent Error Handling**
```typescript
// Current code (activity-watcher.ts:108-121)
const settled = await Promise.allSettled([...]);

const extract = (r, name) => {
  if (r.status === "fulfilled") return r.value;
  console.error(`  Warning: could not fetch ${name}: ${r.reason}`);
  return [];
};
```

**Problem**: 
- Errors are logged but not tracked
- No way to know which buckets succeeded/failed
- Can't differentiate between "bucket doesn't exist" (404) vs "service down" (500)
- No retry mechanism for transient failures

**Fix**: Implement structured error tracking and retry logic
```typescript
interface FetchResult {
  success: boolean;
  data: AwEvent[];
  error?: {
    statusCode?: number;
    isRetryable: boolean;
    message: string;
  };
}

async function fetchBucketEventsWithRetry(
  bucketId: string,
  targetDate: string,
  maxRetries = 3
): Promise<FetchResult> {
  // implementation with exponential backoff
}
```

**Issue #2: No Timeout Strategy**
```typescript
// Current code
const res = await fetch(url); // No timeout
```

**Problem**:
- fetch() has no default timeout
- ActivityWatch might hang indefinitely
- Node timeout would be system-dependent

**Fix**:
```typescript
const controller = new AbortController();
const timeout = setTimeout(() => controller.abort(), 5000);
try {
  const res = await fetch(url, { signal: controller.signal });
} finally {
  clearTimeout(timeout);
}
```

**Issue #3: Hard to Test**
- Requires ActivityWatch running on specific port
- Hostname must match bucket naming scheme
- Test data must exist for target date
- Can't inject base URL or fetch implementation

**Fix**: Dependency injection
```typescript
class ActivityWatchClient {
  constructor(
    private baseUrl = "http://localhost:5600/api/0",
    private fetch = globalThis.fetch
  ) {}
}
```

---

### 3. `ollama.test.ts` - LLM Integration Issues
Tests highlighting problems with Ollama integration:

#### ⚠️ **CRITICAL ISSUES FOUND**

**Issue #1: Timeout Exceeds Configuration**
```typescript
// Config says 10 minutes
export const MODEL_TASK_TIMEOUT = 1000 * 60 * 10; // 10 minutes
```

**Reality**:
- qwen3.6:35b model often takes **12-15 minutes**
- TimeoutError seen after 300s (5 minutes) in error output
- No indication of how long the model was actually running

**Fix**: Make timeout configurable and provide better diagnostics
```typescript
const SOFT_TIMEOUT = 1000 * 60 * 8;  // Warn at 8 min
const HARD_TIMEOUT = 1000 * 60 * 20; // Kill at 20 min

async function callOllamaWithDiagnostics(model, prompt) {
  const startTime = Date.now();
  
  try {
    return await withTimeout(
      fetch(OLLAMA_URL, { signal: AbortSignal.timeout(HARD_TIMEOUT) }),
      SOFT_TIMEOUT
    );
  } catch (error) {
    const elapsed = (Date.now() - startTime) / 1000;
    if (error instanceof DOMException && error.name === 'TimeoutError') {
      throw new Error(
        `Ollama model inference timeout after ${elapsed.toFixed(1)}s. ` +
        `(configured: ${HARD_TIMEOUT / 1000}s). ` +
        `Model is slower than expected. Try: ` +
        `1. Increase MODEL_TASK_TIMEOUT, ` +
        `2. Use a smaller model, ` +
        `3. Check Ollama logs at ~/.ollama/logs/server.log`
      );
    }
    throw error;
  }
}
```

**Issue #2: Global State for CPU Limiting**
```typescript
// Module-level state (activity-watcher.ts:27-28)
let ollamaPidCache: number | null = null;
let ollamaCpuLimitApplied = false;
```

**Problems**:
- Can't reset between test runs
- Not thread-safe
- Persists across multiple invocations
- Hard to mock

**Fix**: Use a class-based approach
```typescript
class OllamaManager {
  private cpuLimitApplied = false;
  private pidCache: number | null = null;

  async call(model: string, prompt: string): Promise<string> {
    this.applyOllamaCpuLimit();
    // ...
  }
}
```

**Issue #3: No Retry Logic**
- Single attempt to call Ollama
- Temporary Ollama failures (restart, out of memory) cause immediate failure
- No circuit breaker pattern

**Fix**: Implement exponential backoff
```typescript
async function callOllamaWithRetry(
  model: string,
  prompt: string,
  maxRetries = 3
): Promise<string> {
  let lastError;
  
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await callOllama(model, prompt);
    } catch (error) {
      lastError = error;
      const backoff = Math.min(
        1000 * Math.pow(2, attempt),
        30000
      );
      await new Promise(r => setTimeout(r, backoff));
    }
  }
  
  throw lastError;
}
```

**Issue #4: CPU Limiting is Fragile**
```typescript
// Uses spawned cpulimit process (activity-watcher.ts:417-429)
const limiter = spawn("cpulimit", [...], { detached: true, stdio: "ignore" });
limiter.unref();
```

**Problems**:
- Assumes `cpulimit` is installed
- May require root/capabilities
- Detached process might not clean up properly
- No validation that limit actually applied

**Fix**:
```typescript
async function applyOllamaCpuLimit(): Promise<void> {
  const limit = Math.floor(OLLAMA_CPU_LIMIT_PERCENT);
  if (limit <= 0) return; // Disabled

  const pid = getOllamaServerPid();
  if (!pid) {
    console.warn("Could not find Ollama process to limit CPU");
    return;
  }

  // Check if cpulimit is available
  try {
    await execPromise("which cpulimit");
  } catch {
    console.warn(
      "cpulimit not found. Install with: apt-get install cpulimit"
    );
    return;
  }

  try {
    // Use cgroup v2 if available (more reliable)
    await applyOllamaCgroupLimit(pid, limit);
  } catch {
    // Fallback to cpulimit
    await applyOllamaCpulimitLimit(pid, limit);
  }
}
```

---

## Code Quality Issues Summary

### High Priority
1. **Timeout handling in Ollama** - Model often exceeds 10-minute timeout with no retry
2. **Silent error swallowing** - API errors logged but not actionable
3. **No retry logic** - Transient failures cause immediate abort
4. **Global state** - `ollamaPidCache` and `ollamaCpuLimitApplied` not testable

### Medium Priority
1. **Hard to test** - Tight coupling to external services
2. **No configuration for timeouts** - Values hardcoded in source
3. **CPU limiting is fragile** - Assumes `cpulimit` available, uses detached processes
4. **Error messages unhelpful** - Raw errors with no context

### Low Priority
1. **Data processing logic** - Generally sound, could benefit from better types
2. **Work context extraction** - Regex-based parsing could be more robust
3. **Summary text building** - Works but could be more structured

---

## Recommended Improvements

### Phase 1: Crash Recovery (High Priority)
- [ ] Add retry logic with exponential backoff to API calls
- [ ] Increase/configure Ollama timeout
- [ ] Add detailed timeout error messages
- [ ] Implement health checks for services

### Phase 2: Testability (Medium Priority)
- [ ] Extract API client into injectable class
- [ ] Remove global state (convert to class instance)
- [ ] Support mock data sources
- [ ] Add integration test suite

### Phase 3: Robustness (Medium Priority)
- [ ] Implement circuit breaker for Ollama
- [ ] Add fallback models
- [ ] Support config file for timeouts
- [ ] Better CPU limiting strategy

### Phase 4: Observability (Low Priority)
- [ ] Structured logging with context
- [ ] Metrics collection (timing, errors, retries)
- [ ] Debug mode for development
- [ ] Service health dashboard

---

## Testing Tips

### Running Specific Tests
```bash
# Run only activity-watcher tests
bun test tests/activity-watcher.test.ts

# Run tests matching pattern
bun test --match "*Domain*"

# Watch mode for development
bun test --watch tests/fetch-utils.test.ts
```

### Writing New Tests

Use the existing test patterns:

```typescript
import { describe, it, expect } from "bun:test";

describe("Feature Name", () => {
  describe("Specific aspect", () => {
    it("should do something", () => {
      expect(result).toBe(expected);
    });

    it("**ISSUE**: should highlight problems", () => {
      // Document discovered bugs/design problems
      expect(true).toBe(true);
    });
  });
});
```

### Mocking External Services

```typescript
// For testing without Ollama/ActivityWatch running:
const mockFetch = (url: string) => {
  if (url.includes("/api/generate")) {
    return Promise.resolve(new Response(
      JSON.stringify({ response: "Mock response" })
    ));
  }
  return globalThis.fetch(url);
};
```

---

## References

- [Bun Test Documentation](https://bun.sh/docs/api/test)
- [ActivityWatch API](https://docs.activitywatch.net/en/latest/api.html)
- [Ollama API](https://github.com/ollama/ollama/blob/main/docs/api.md)
