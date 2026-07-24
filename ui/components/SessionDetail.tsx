import { useState } from "react";
import { useApi } from "../hooks/useApi";
import { useConversation } from "../hooks/useConversation";
import { useApp } from "../state/AppContext";
import { fmtUsageFull, fmtUsageLabeled, rawTotal, shortDir } from "../lib/util";
import { Conversation } from "./Conversation";

/** 会话详情(L3):顶部摘要(sid/cwd/token) + 该会话对话。
 *  P3 起三级钻取:cwd 由父组件传入,tokenTotal 来自 useConversation(不再依赖全局 sessions)。 */
export function SessionDetail({ sessionId, cwd }: { sessionId: string; cwd?: string }) {
  const { token } = useApp();
  const api = useApi(token);
  const [searchConv, setSearchConv] = useState("");
  const { messages, tokenTotal, loading, error } = useConversation(api, sessionId, true);

  return (
    <div className="session-detail">
      <div className="detail-head">
        <span className="detail-sid" title={sessionId}>
          {sessionId.slice(0, 8)}
        </span>
        {cwd && (
          <span className="detail-cwd" title={cwd}>
            {shortDir(cwd)}
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
        <Conversation messages={messages} loading={loading} error={error} search={searchConv} tokenTotal={tokenTotal} />
      </div>
    </div>
  );
}
