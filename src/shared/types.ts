// 事件与 API 契约类型。Hook / Daemon / 查看页共享，固化接口。

export type HookEventType =
  | "SessionStart"
  | "UserPromptSubmit"
  | "PreToolUse"
  | "PostToolUse"
  | "Stop"
  | "SubagentStop"
  | "PreCompact"
  | "SessionEnd";

/** Hook 采集后、落盘与转发的事件信封。payload 为 Claude 注入 stdin 的原始 JSON（透传）。 */
export interface HookEvent {
  eventId: string; // 稳定 id，幂等去重用
  type: HookEventType;
  timestamp: number; // ms
  cwd: string; // process.cwd()
  sessionId: string;
  pid: number;
  payload: unknown;
}

/** pid 文件内容。 */
export interface PidFile {
  pid: number;
  port: number;
  token: string;
  startedAt: number; // ms
}

/** GET /api/health 响应。service 字段用于 Hook「认自己人」。 */
export interface HealthResponse {
  service: string;
  version: string;
  pid: number;
  uptime: number; // ms
}

/** GET /api/stats 响应。 */
export interface StatsResponse {
  service: string;
  version: string;
  pid: number;
  uptime: number;
  spoolBacklog: number;
  eventsPerSec: number;
  totalEvents: number;
  lastError: { time: number; message: string } | null;
  logTail: string[];
}

/** GET /api/events 响应。 */
export interface EventsResponse {
  events: HookEvent[];
}

/** 单次 assistant 响应的 token 用量（来自 transcript message.usage 的扁平四字段，缺失按 0）。 */
export interface TokenUsage {
  input: number;
  output: number;
  cacheCreation: number;
  cacheRead: number;
}

/** 单个 session 的概览（查看页 session 树用）。tokenTotal 来自 transcript 汇总，读不到为 null。 */
export interface SessionSummary {
  sessionId: string;
  cwd: string;
  lastActive: number;
  eventCount: number;
  lastType: HookEventType | null;
  tokenTotal?: TokenUsage | null;
}

/** GET /api/sessions 响应。 */
export interface SessionsResponse {
  sessions: SessionSummary[];
}

/** GET /api/transcript 响应里的单条消息（daemon 解析 jsonl 产物，对话视图消费）。 */
export interface TranscriptMessage {
  role: "user" | "assistant" | "tool";
  text: string;
  thinking?: string;
  tools: { name: string; input: unknown }[];
  toolName?: string;
  isError?: boolean;
  ts?: number;
  usage?: TokenUsage; // 仅 assistant 有，来自 message.usage
}

/** git commit 的单个文件变更（来自 git log --numstat；二进制文件 added/deleted 为 0）。 */
export interface CommitFile {
  path: string;
  added: number;
  deleted: number;
}

/** 单条 git commit（/api/commits 返回）。added/deleted 为其下 files 的合计。 */
export interface CommitLog {
  hash: string;
  time: number; // ms，提交时间（%cI）
  author: string;
  subject: string;
  files: CommitFile[];
  added: number;
  deleted: number;
}

/** GET /api/commits 响应。非 git 目录或 git 不可用时 commits 为空、带 error。 */
export interface CommitsResponse {
  cwd: string;
  commits: CommitLog[];
  error?: string;
}

// ---- GET /api/report:数据上报页用的跨项目聚合 ----

/** 报告里单个会话的 token 明细。tokenTotal 读不到 transcript 为 null。 */
/** 代码变更行数(分开统计,三者不重复:added 纯增 / deleted 纯删 / modified 一删一加配对)。 */
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
  title?: string | null; // 首条 user 消息(会话标题),读不到为 null
}

/** 报告里单个项目(=cwd)的聚合行。 */
export interface ReportProject {
  cwd: string;
  name: string; // shortDir(cwd),展示用
  gitUser: string | null; // git config user.name
  gitRemote: string | null; // git remote origin URL
  sessionCount: number;
  sessions: ReportSession[]; // 每会话 token 明细
  totalTokens: TokenUsage; // 该项目 token 合计
  totalLines: LinesStat; // 该项目代码变更行数合计
  gitError?: string;
}

/** 报告全局合计。 */
export interface ReportTotals {
  projects: number;
  sessions: number;
  tokens: TokenUsage;
  lines: LinesStat;
}

/** GET /api/report 响应。 */
export interface ReportResponse {
  version: string;
  generatedAt: number;
  since: number; // 统计窗口起点(ms),0=全部
  gitUser: string | null; // 全局代表(首个有 user.name 的项目)
  projects: ReportProject[];
  totals: ReportTotals;
}
