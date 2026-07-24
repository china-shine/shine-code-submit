import { useMemo, type ReactNode } from "react";
import { fmtTokens, fmtUsage, fmtUsageFull, sumUsage } from "../lib/util";
import type { TokenUsage, TranscriptMessage } from "../types";
import { Icon } from "./Icon";
import { Message } from "./Message";

function msgMatches(m: TranscriptMessage, q: string): boolean {
  if (!q) return true;
  if ((m.text || "").toLowerCase().includes(q)) return true;
  if ((m.thinking || "").toLowerCase().includes(q)) return true;
  if ((m.toolName || "").toLowerCase().includes(q)) return true;
  return (m.tools || []).some(
    (t) =>
      (t.name || "").toLowerCase().includes(q) ||
      JSON.stringify(t.input).toLowerCase().includes(q),
  );
}

function Skeleton() {
  return (
    <>
      <div className="skeleton skel-bubble" />
      <div className="skeleton skel-block" />
      <div className="skeleton skel-bubble" />
      <div className="skeleton skel-block" style={{ width: "68%" }} />
    </>
  );
}

/** 对话视图：Step 2 起改为 props 驱动（去 Context），供 SessionDetail 复用。
 *  数据（messages/loading/error）与搜索态由调用方传入。 */
export function Conversation({
  messages,
  loading,
  error,
  search,
  tokenTotal: tokenTotalProp,
}: {
  messages: TranscriptMessage[];
  loading: boolean;
  error: string | null;
  search: string;
  /** 会话级 token 总量。优先用父组件透传的后端口径(父 + subagents + ccusage 去重,与列表同口径);
   *  未透传时回退到对当前 messages 求和(仅父文件、不去重)作兜底。 */
  tokenTotal?: TokenUsage | null;
}) {
  const q = search.trim().toLowerCase();
  const shown = useMemo(
    () => (q ? messages.filter((m) => msgMatches(m, q)) : messages),
    [messages, q],
  );
  const computedTotal = useMemo(() => sumUsage(messages), [messages]);
  const tokenTotal = tokenTotalProp ?? computedTotal;

  let body: ReactNode;
  // 仅首次加载（无缓存数据）才显骨架；切回已有数据时静默刷新，避免切换闪烁
  if (loading && messages.length === 0) {
    body = <Skeleton />;
  } else if (error) {
    body = (
      <div className="empty-state">
        <Icon name="warning" size={28} />
        <span className="es-hint">加载失败</span>
        <span className="es-sub">{error}</span>
      </div>
    );
  } else if (!messages.length) {
    body = (
      <div className="empty-state">
        <Icon name="chat" size={30} />
        <span className="es-hint">暂无对话</span>
        <span className="es-sub">该会话无 transcript 或尚未产生对话</span>
      </div>
    );
  } else if (!shown.length) {
    body = (
      <div className="empty-state">
        <span className="es-hint">无匹配消息</span>
        <span className="es-sub">“{search}” 未命中（0/{messages.length}）</span>
      </div>
    );
  } else {
    body = (
      <>
        {q && <div className="search-count">{`${shown.length}/${messages.length} 条匹配`}</div>}
        {shown.map((m, i) => (
          <Message key={i} m={m} />
        ))}
      </>
    );
  }

  return (
    <div id="conversation" className="conversation">
      {!loading && !error && messages.length > 0 && (tokenTotal.input > 0 || tokenTotal.output > 0) && (
        <div className="conv-token-bar" title={fmtUsageFull(tokenTotal)}>
          本会话累计 <b>{fmtUsage(tokenTotal)}</b>
          <span className="conv-token-cache">
            {" "}· 缓存读 {fmtTokens(tokenTotal.cacheRead)} / 写 {fmtTokens(tokenTotal.cacheCreation)}
          </span>
        </div>
      )}
      {body}
    </div>
  );
}
