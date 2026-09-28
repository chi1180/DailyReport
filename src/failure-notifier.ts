import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";

function commandExists(command: string): boolean {
  const result = spawnSync("sh", ["-c", `command -v ${command}`], {
    stdio: "ignore",
  });
  return result.status === 0;
}

function formatError(error: unknown): string {
  if (error instanceof Error) {
    const stack = error.stack ? `\nStack:\n${error.stack}` : "";
    return `${error.name}: ${error.message}${stack}`;
  }
  return String(error);
}

function openLogFile(logPath: string): void {
  if (!commandExists("xdg-open")) {
    console.warn(`[notify] xdg-open not found. Open the log manually: ${logPath}`);
    return;
  }

  const opener = spawn("xdg-open", [logPath], {
    detached: true,
    stdio: "ignore",
  });
  opener.unref();
}

export function writeFailureLog(error: unknown): string {
  const logsDir = resolve(process.cwd(), "logs");
  mkdirSync(logsDir, { recursive: true });

  const timestamp = new Date().toISOString().replace(/[.:]/g, "-");
  const logPath = join(logsDir, `dailyreport-failure-${timestamp}.log`);
  const content = [
    "# DailyReport failure log",
    `Timestamp: ${new Date().toISOString()}`,
    `Platform: ${process.platform} ${process.arch}`,
    `Bun: ${process.versions.bun ?? "unknown"}`,
    `Working directory: ${process.cwd()}`,
    "",
    formatError(error),
    "",
  ].join("\n");

  writeFileSync(logPath, content, "utf8");
  return logPath;
}

export function notifyFailure(logPath: string): void {
  if (process.platform !== "linux") return;

  if (!commandExists("notify-send")) {
    console.warn(
      `[notify] notify-send not found. Install libnotify-bin. Log: ${logPath}`,
    );
    return;
  }

  const title = "DailyReport failed";
  const message = "Click \"Open log\" to view failure details.";

  const withAction = spawnSync(
    "notify-send",
    [
      "--app-name=DailyReport",
      "--urgency=critical",
      "--icon=dialog-error",
      "--expire-time=15000",
      "--action=open=Open log",
      "--wait",
      title,
      message,
    ],
    { encoding: "utf8" },
  );

  if (withAction.status === 0) {
    if ((withAction.stdout ?? "").trim() === "open") {
      openLogFile(logPath);
    }
    return;
  }

  spawnSync(
    "notify-send",
    [
      "--app-name=DailyReport",
      "--urgency=critical",
      "--icon=dialog-error",
      "--expire-time=15000",
      title,
      `${message}\nLog: ${logPath}`,
    ],
    { stdio: "ignore" },
  );
}
