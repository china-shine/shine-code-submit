// GET /api/reports 响应类型（与 src/store.ts 的 UserAgg/ProjectAgg/SessionAgg 一致）。

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

export interface SessionAgg {
  sessionId: string;
  lastActive: number;
  tokenTotal: TokenUsage | null;
  linesTotal: LinesStat | null;
  title?: string | null;
}

export interface ProjectAgg {
  cwd: string;
  name: string;
  gitRemote: string | null;
  lastActive: number;
  sessionCount: number;
  totalTokens: TokenUsage;
  totalLines: LinesStat;
  sessions: SessionAgg[];
}

export interface UserAgg {
  gitUser: string;
  lastActive: number;
  projectCount: number;
  sessionCount: number;
  totalTokens: TokenUsage;
  totalLines: LinesStat;
  projects: ProjectAgg[];
}

export interface ReportsResponse {
  users: UserAgg[];
}
