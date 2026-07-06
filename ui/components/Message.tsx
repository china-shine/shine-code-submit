import { fmtTime, fmtUsage, fmtUsageFull } from "../lib/util";
import type { TranscriptMessage } from "../types";
import { Icon } from "./Icon";
import { Markdown } from "./Markdown";
import { ToolCard } from "./ToolCard";

/** 单条对话消息：user（右气泡）/ tool（结果卡片）/ assistant（角色头 + 正文 + 工具卡）。 */
export function Message({ m }: { m: TranscriptMessage }) {
  if (m.role === "user") {
    return (
      <div className="msg-row user-row">
        <div className="bubble">{m.text}</div>
      </div>
    );
  }
  if (m.role === "tool") {
    return (
      <div className="msg-row">
        <details className={`result-card${m.isError ? " is-error" : ""}`}>
          <summary className="card-trigger">
            <span className="card-chev"><Icon name="chevron" size={12} /></span>
            <span className="result-label">{m.toolName || "结果"}</span>
          </summary>
          <pre className="card-output">{m.text}</pre>
        </details>
      </div>
    );
  }
  return (
    <div className="msg-row assistant-row">
      <div className="role-head">
        <span className="role-mark"><Icon name="diamond" size={10} /></span>
        <span className="role-name">Claude</span>
        {m.usage && (
          <span className="role-tokens" title={fmtUsageFull(m.usage)}>{fmtUsage(m.usage)}</span>
        )}
        {m.ts != null && <span className="role-ts">{fmtTime(m.ts)}</span>}
      </div>
      {m.thinking && (
        <details className="think-card">
          <summary className="card-trigger">
            <span className="card-chev"><Icon name="chevron" size={12} /></span>
            <span className="think-label">Thinking</span>
          </summary>
          <div className="think-body">
            <Markdown src={m.thinking} />
          </div>
        </details>
      )}
      {m.text && (
        <div className="assistant-text msg-text">
          <Markdown src={m.text} />
        </div>
      )}
      {m.tools.map((t, i) => (
        <ToolCard key={i} t={t} />
      ))}
    </div>
  );
}
