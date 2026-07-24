// API 响应类型(服务端化:/api/stats + /api/sessions + /api/member)。

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

export type Granularity = "day" | "week" | "month";

export interface DayBucket {
  date: string;
  ts: number;
  input: number;
  output: number;
  cache: number;
  total: number;
}
export interface DailyStat {
  date: string;
  ts: number;
  total: number;
  sessions: number;
  lines: number;
  dur: number;
}
export interface MemberAgg {
  gitUser: string;
  lastActive: number;
  realProjects: number;
  sessionCount: number;
  activeMs: number;
  totalTokens: TokenUsage;
  totalLines: LinesStat;
}
export interface StatsPayload {
  totals: {
    token: TokenUsage;
    rawTotal: number;
    lines: LinesStat;
    activeMs: number;
    sessions: number;
    members: number;
    projects: number;
  };
  activeMin: number; // 过滤后 lastActive min(范围徽章)
  activeMax: number; // 过滤后 lastActive max
  dataMin: number; // 全量最早 lastActive(重置用)
  dataMax: number; // 全量最新 lastActive
  allMembers: string[]; // 全量 gitUser(成员下拉,不受 members 过滤)
  trend: DayBucket[]; // 按 granularity(TokenTrendChart)
  daily: DailyStat[]; // 固定 day(KpiCards sparkline)
  composition: { input: number; output: number; cache: number };
  tokenRank: {
    member: Array<{ gitUser: string; token: number }>;
    project: Array<{ cwd: string; name: string; token: number }>;
  };
  codeRank: Array<{ gitUser: string; lines: number; added: number; deleted: number; modified: number; convs: number; token: number }>;
  sizeBuckets: Array<{ range: string; count: number }>;
  members: MemberAgg[];
}

/** /api/sessions 的单行(会话明细 + 项目展示名 fallback,前端 displayProjectName 再清洗)。*/
export interface SessionRowOut {
  sessionId: string;
  gitUser: string;
  cwd: string;
  lastActive: number;
  input: number;
  output: number;
  cacheCreation: number;
  cacheRead: number;
  added: number;
  deleted: number;
  modified: number;
  activeMs: number;
  title: string | null;
  name: string;
}
export interface SessionsPage {
  rows: SessionRowOut[];
  total: number;
  page: number;
  pageSize: number;
}

/** /api/member/:gitUser 响应(单成员 KPI + 趋势)。*/
export interface MemberDetail {
  gitUser: string;
  lastActive: number;
  totals: {
    token: TokenUsage;
    rawTotal: number;
    lines: LinesStat;
    activeMs: number;
    sessions: number;
    realProjects: number;
  };
  trend: DayBucket[];
}
