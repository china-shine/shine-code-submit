import { useState } from "react";
import { useApi } from "../hooks/useApi";
import { useConversation } from "../hooks/useConversation";
import { useApp } from "../state/AppContext";
import { fmtUsageFull, fmtUsageLabeled, rawTotal, shortDir } from "../lib/util";
import { Conversation } from "./Conversation";

/** 会话详情（右侧）：顶部摘要（sid/cwd/token）+ 该会话对话。
 *  两栏布局下不再需要返回按钮（左侧树常驻，选会话即切换）。 */
export function SessionDetail({ sessionId }: { sessionId: string }) {
  const { token, sessions } = useApp();
  const api = useApi(token);
  const [searchConv, setSearchConv] = useState("");
  const { messages, loading, error } = useConversation(api, sessionId, true);

  const session = sessions.find((s) => s.sessionId === sessionId);
  const tokenTotal = session?.tokenTotal ?? null;

  return (
    <div className="session-detail">
      <div className="detail-head">
        <span className="detail-sid" title={sessionId}>
          {sessionId.slice(0, 8)}
        </span>
        {session?.cwd && (
          <span className="detail-cwd" title={session.cwd}>
            {shortDir(session.cwd)}
          </span>
        )}
        {tokenTotal && rawTotal(tokenTotal) > 0 && (
          <span className="detail-token" title={fmtUsageFull(tokenTotal)}>
            {fmtUsageLabeled(tokenTotal)}
          </span>
        )}
      </div>
      <div className="toolbar">
        <input
          className="search-input"
          type="search"
          placeholder="搜索对话…"
          value={searchConv}
          onChange={(e) => setSearchConv(e.target.value)}
          autoComplete="off"
        />
      </div>
      <div className="detail-body">
        <Conversation messages={messages} loading={loading} error={error} search={searchConv} />
      </div>
    </div>
  );
}
