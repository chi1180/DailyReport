import { Obsidian } from "./src/obsidian";
import { DIARY_DIR, REPORT_DIR } from "./src/config";
import { generateReport } from "./src/activity-watcher";

async function main() {
  // const result = Bun.spawnSync(["bun", "./src/activity-watcher.ts"]);
  // console.log(result.stdout.toString());

  const _Obsidian = new Obsidian(DIARY_DIR, REPORT_DIR);
  const today = new Date();
  const todayDiary = await _Obsidian.readDiary(today);

  // generate report
  const report = await generateReport(
    today.toISOString().split("T")[0] as string,
    todayDiary,
  );

  // write report
  await _Obsidian.writeReport(today, report);
}

main();
