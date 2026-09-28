export interface AwEvent {
  timestamp: string;
  duration: number;
  data: Record<string, string | boolean | number>;
}

export interface AwBucketExport {
  buckets: Record<string, { events: AwEvent[] }>;
}

export interface CategoryRule {
  type: "regex" | "none";
  regex?: string;
  ignore_case?: boolean;
}

export interface Category {
  id: number;
  name: string[];
  name_pretty: string;
  rule: CategoryRule;
  depth: number;
}

export interface CategoryExport {
  categories: Category[];
}

export interface AppStat {
  label: string;
  minutes: number;
}

export interface WebStat {
  domain: string;
  category: string;
  minutes: number;
  sampleTitles: string[];
}

export interface DailySummary {
  date: string;
  activeMinutes: number;
  afkMinutes: number;
  totalMinutes: number;
  apps: AppStat[];
  webByCategory: Record<string, number>;
  webDetails: WebStat[];
  workContext: string[];
}
