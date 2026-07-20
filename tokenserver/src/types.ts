// 上报数据契约（与 shine-code-submit src/shared/types.ts 的 ReportResponse 一致）。
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
  gitError?: string;
}

export interface ReportTotals {
  projects: number;
  sessions: number;
  tokens: TokenUsage;
  lines: LinesStat;
}

export interface ReportResponse {
  version: string;
  generatedAt: number;
  since: number;
  gitUser: string | null;
  projects: ReportProject[];
  totals: ReportTotals;
}
