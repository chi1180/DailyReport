export class Obsidian {
  diaryDir: string;
  reportDir: string;

  constructor(diaryDir: string, reportDir: string) {
    this.diaryDir = diaryDir;
    this.reportDir = reportDir;
  }

  // =============================================================================
  // Util functions
  // =============================================================================
  async readDiary(date: Date) {
    const path = `${this.diaryDir}/${date.toISOString().split("T")[0]}.md`;

    const isExist = await Bun.file(path).exists();
    if (isExist) {
      const result = await Bun.file(path).text();
      return result;
    }
    return "";
  }

  async writeReport(date: Date, content: string) {
    const path = `${this.reportDir}/${date.toISOString().split("T")[0]}.md`;
    await Bun.write(path, content);
  }
}
