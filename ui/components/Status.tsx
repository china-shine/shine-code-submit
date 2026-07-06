import { useMemo } from "react";
import { useApp } from "../state/AppContext";
import { Icon } from "./Icon";
import { fmtUsage, fmtUsageFull, sumTokenUsage } from "../lib/util";

/** 顶栏运行状态：常驻版本号 + 全局 token + 速率/积压/错误徽章；pid/uptime/总计 收进 info popover。 */
export function Status() {
  const { stats, sessions } = useApp();
  // 全局 token：累加已加载会话的 tokenTotal。仅最近 50 个被 enrich（见 SESSION_TOKEN_ENRICH_LIMIT），
  // 故为「最近活跃会话累计」而非历史全量；count 即实际覆盖的会话数，展示在 title 里。
  const token = useMemo(
    () => sumTokenUsage(sessions.map((s) => s.tokenTotal)),
    [sessions],
  );
  if (!stats) {
    return (
      <div className="status">
        <span className="st-dot connecting">连接中…</span>
      </div>
    );
  }
  const up = Math.floor(stats.uptime / 1000);
  const backlog = stats.spoolBacklog;
  const lastError = stats.lastError;
  const hasTokens = token.total.input > 0 || token.total.output > 0;

  return (
    <div className="status">
      <span className="st-ver">v{stats.version}</span>
      {hasTokens && (
        <span
          className="st-tokens"
          title={`近 ${token.count} 会话累计（最多覆盖最近 50 个活跃会话）· ${fmtUsageFull(token.total)}`}
        >
          {fmtUsage(token.total)}
        </span>
      )}
      {backlog > 0 && (
        <span className="badge warn" title={`spool 积压 ${backlog} 条待消费`}>
          积压 {backlog}
        </span>
      )}
      {lastError ? (
        <span className="badge err" title={lastError.message}>
          <Icon name="warning" size={12} /> 错误
        </span>
      ) : (
        <span className="st-rate" title="事件速率">
          <Icon name="activity" size={12} />
          {stats.eventsPerSec.toFixed(1)}/s
        </span>
      )}
      <div className="status-detail" tabIndex={0} title="运行详情">
        <Icon name="info" />
        <div className="popover" role="tooltip">
          <div className="pop-row"><span>pid</span><b>{stats.pid}</b></div>
          <div className="pop-row"><span>uptime</span><b>{up}s</b></div>
          <div className="pop-row"><span>积压</span><b>{backlog}</b></div>
          <div className="pop-row"><span>速率</span><b>{stats.eventsPerSec.toFixed(1)} evt/s</b></div>
          <div className="pop-row"><span>总计</span><b>{stats.totalEvents}</b></div>
          {lastError && <div className="pop-err">{lastError.message}</div>}
        </div>
      </div>
    </div>
  );
}
