import { Obsidian } from "./src/obsidian";
import { DIARY_DIR, REPORT_DIR } from "./src/config";
import { generateReport } from "./src/activity-watcher";

async function runWithSpinner<T>(label: string, task: () => Promise<T>): Promise<T> {
  const startedAt = Date.now();
  const isTty = Boolean(process.stdout.isTTY);
  const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  let frameIndex = 0;

  if (!isTty) {
    console.log(`▶ ${label}...`);
    const result = await task();
    const elapsedSec = ((Date.now() - startedAt) / 1000).toFixed(1);
    console.log(`✓ ${label} (${elapsedSec}s)`);
    return result;
  }

  const timer = setInterval(() => {
    process.stdout.write(`\r${frames[frameIndex]} ${label}...`);
    frameIndex = (frameIndex + 1) % frames.length;
  }, 90);

  try {
    const result = await task();
    clearInterval(timer);
    process.stdout.write("\r");
    const elapsedSec = ((Date.now() - startedAt) / 1000).toFixed(1);
    console.log(`✓ ${label} (${elapsedSec}s)`);
    return result;
  } catch (error) {
    clearInterval(timer);
    process.stdout.write("\r");
    const elapsedSec = ((Date.now() - startedAt) / 1000).toFixed(1);
    console.error(`✗ ${label} failed (${elapsedSec}s)`);
    throw error;
  }
}

async function main() {
  const startedAt = Date.now();
  console.log("🚀 DailyReport started");

  const _Obsidian = new Obsidian(DIARY_DIR, REPORT_DIR);
  const today = new Date();
  const reportDate = today.toISOString().split("T")[0] as string;
  console.log(`📅 Target date: ${reportDate}`);

  const todayDiary = await runWithSpinner("Reading today's diary", () =>
    _Obsidian.readDiary(today),
  );

  // generate report
  const report = await runWithSpinner("Generating report via ActivityWatch + Ollama", () =>
    generateReport(reportDate, todayDiary),
  );

  // write report
  await runWithSpinner("Writing report to Obsidian", () =>
    _Obsidian.writeReport(today, report),
  );

  const totalSec = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.log(`✅ DailyReport completed in ${totalSec}s`);
}

main().catch((error) => {
  console.error("\n❌ DailyReport failed");
  console.error(error);
  process.exitCode = 1;
});
