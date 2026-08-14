// 上报数据契约（与 shine-worklog src/shared/types.ts 的 ReportResponse 一致）。
// daemon POST /api/report 的 body 即此结构。

export interface TokenUsage {
  input: number;
  output: number;
  cacheCreation: number;
  cacheRead: number;
}

export interface LinesStat {
  added: number;
  deleted: number;
  modified: number;
}

export interface ReportSession {
  sessionId: string;
  lastActive: number;
  tokenTotal: TokenUsage | null;
  linesTotal: LinesStat | null;
  title?: string | null;
  activeMs?: number; // gap-aware 活跃时长(ms);旧 daemon 上报可能缺失
}

export interface GitCommitStat {
  hash: string;
  ts: number;
  added: number;
  deleted: number;
}

export interface ReportProject {
  cwd: string;
  name: string;
  gitUser: string | null;
  gitRemote: string | null;
  sessionCount: number;
  sessions: ReportSession[];
  totalTokens: TokenUsage;
  totalLines: LinesStat;
  gitCommits?: GitCommitStat[];
  gitError?: string;
}

export interface ReportTotals {
  projects: number;
  sessions: number;
  tokens: TokenUsage;
  lines: LinesStat;
}

/** 禅道工时条目(与 shine-worklog src/shared/types.ts 的 WorklogEntry 一致)。 */
export interface WorklogEntry {
  date: string;
  sessionId: string;
  cwd: string;
  repo: string | null;
  branch: string | null;
  start: string | null;
  end: string | null;
  minutes: number;
  hours: number;
  taskId: number | null;
  taskName: string | null;
  projectId: number | null;
  projectName: string | null;
  work: string | null;
  status: string;
  zentaoUrl: string | null;
  subId?: string; // 提交流水号("<date>:<行号>"),PK 组成部分;旧 daemon 上报缺失→落库兜底 ''
}

export interface ReportResponse {
  version: string;
  generatedAt: number;
  since: number;
  gitUser: string | null;
  projects: ReportProject[];
  totals: ReportTotals;
  worklogs?: WorklogEntry[];
}
