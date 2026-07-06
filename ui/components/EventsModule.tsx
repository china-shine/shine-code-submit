import { useMemo, useState } from "react";
import { useApi } from "../hooks/useApi";
import { useEvents } from "../hooks/useEvents";
import { useWebSocket } from "../hooks/useWebSocket";
import { useApp } from "../state/AppContext";
import { download } from "../lib/export";
import { fmtUsage, fmtUsageFull, shortDir } from "../lib/util";
import { Icon } from "./Icon";
import { EventList } from "./EventList";
import { SessionTree } from "./SessionTree";
import { Splitter } from "./Splitter";
import type { HookEvent } from "../types";

/** 事件模块（统一事件入口）：左侧会话树（筛选）+ 右侧事件流。
 *  选会话 → 顶部显该会话摘要（sid/cwd/token，与对话页对称）+ 只看该会话事件；
 *  全部 → 跨会话全局实时流。树宽可拖拽（--tree-w）。 */
export function EventsModule() {
  const { token, sessions } = useApp();
  const api = useApi(token);
  const [search, setSearch] = useState("");
  const [sessionFilter, setSessionFilter] = useState<string | null>(null);
  const [live, setLive] = useState<HookEvent[]>([]);
  const { events, loading, error } = useEvents(api, sessionFilter, true);
  useWebSocket(token, (ev) => setLive((prev) => [ev, ...prev].slice(0, 200)));

  const session = sessionFilter ? sessions.find((s) => s.sessionId === sessionFilter) : undefined;
  const tokenTotal = session?.tokenTotal ?? null;

  const all = useMemo(() => {
    const seen = new Set<string>();
    const merged: HookEvent[] = [];
    for (const ev of [...live, ...events]) {
      if (sessionFilter && ev.sessionId !== sessionFilter) continue;
      if (seen.has(ev.eventId)) continue;
      seen.add(ev.eventId);
      merged.push(ev);
    }
    return merged;
  }, [live, events, sessionFilter]);

  const q = search.trim().toLowerCase();
  const filtered = useMemo(() => {
    if (!q) return all;
    return all.filter((ev) =>
      (ev.type + " " + JSON.stringify(ev.payload ?? "")).toLowerCase().includes(q),
    );
  }, [all, q]);

  const onExport = () => {
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
    const sid = sessionFilter ? sessionFilter.slice(0, 8) : "all";
    download(`events-${sid}-${stamp}.json`, JSON.stringify(filtered, null, 2), "application/json");
  };

  let body;
  if (loading && all.length === 0) {
    body = (
      <div className="empty-state">
        <span className="es-hint">加载事件…</span>
      </div>
    );
  } else if (error) {
    body = (
      <div className="empty-state">
        <Icon name="warning" size={28} />
        <span className="es-hint">{error}</span>
      </div>
    );
  } else {
    body = <EventList events={filtered} filtered={false} />;
  }

  return (
    <div className="events-with-tree">
      <aside className="events-tree-panel panel">
        <div className="panel-header">
          <h2>会话</h2>
        </div>
        <SessionTree selectedId={sessionFilter} onSelect={setSessionFilter} allLabel="全部会话" />
      </aside>
      <Splitter orient="v" varName="--tree-w" />
      <div className="events-main">
        {session && (
          <div className="detail-head">
            <span className="detail-sid" title={session.sessionId}>
              {session.sessionId.slice(0, 8)}
            </span>
            {session.cwd && (
              <span className="detail-cwd" title={session.cwd}>
                {shortDir(session.cwd)}
              </span>
            )}
            {tokenTotal && (tokenTotal.input > 0 || tokenTotal.output > 0) && (
              <span className="detail-token" title={fmtUsageFull(tokenTotal)}>
                {fmtUsage(tokenTotal)}
              </span>
            )}
          </div>
        )}
        <div className="toolbar">
          <input
            className="search-input"
            type="search"
            placeholder="搜索事件…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            autoComplete="off"
          />
          <button
            className="icon-btn"
            type="button"
            title="导出事件为 JSON"
            aria-label="导出"
            onClick={onExport}
          >
            <Icon name="download" />
          </button>
        </div>
        {body}
      </div>
    </div>
  );
}
