// 前端专用类型。后端契约类型从 src/shared/types 复用（type-only，bun build 打包时擦除，运行时 0 体积）。
import type {
  CommitFile,
  CommitLog,
  CommitsResponse,
  EventsResponse,
  HookEvent,
  ReportProject,
  ReportResponse,
  ReportSession,
  SessionSummary,
  StatsResponse,
  TokenUsage,
  TranscriptMessage,
} from "../src/shared/types";

// 便于组件统一从 ui/types 引。
export type {
  CommitFile,
  CommitLog,
  CommitsResponse,
  EventsResponse,
  HookEvent,
  ReportProject,
  ReportResponse,
  ReportSession,
  SessionSummary,
  StatsResponse,
  TokenUsage,
  TranscriptMessage,
};

/** WS /api/ws 推送的消息。 */
export type WsMessage =
  | { kind: "snapshot"; stats: StatsResponse }
  | { kind: "event"; event: HookEvent };

/** GET /api/transcript 响应。tokenTotal 为该会话 assistant 消息累计用量。 */
export interface TranscriptResponse {
  transcriptPath: string;
  messages: TranscriptMessage[];
  tokenTotal?: TokenUsage;
}

/** HookEvent.payload 是 unknown，取字段时统一断言为这个字典视图。 */
export type Payload = Record<string, unknown>;

/** 主区视图模式。 */
export type ViewMode = "events" | "conversation" | "commits" | "summary";

/** 左侧导航模块（渐进重构：Step 1 起与 viewMode 并存，selectModule 经映射驱动 viewMode）。 */
export type ModuleId = "overview" | "sessions" | "events" | "commits" | "stats" | "report" | "system";
