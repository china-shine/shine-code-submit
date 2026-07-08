import { useMemo, useState } from "react";
import { useApp } from "../state/AppContext";
import { fmtDateTime, fmtTokens, fmtUsageFull, realInput } from "../lib/util";
import type { SessionSummary } from "../types";

/** 会话树（按 cwd 分组、可折叠、token 角标、时间点）。纯展示 + onSelect 回调。
 *  会话模块用它选会话进详情；事件模块用它选会话筛选（allLabel 显「全部」项）。 */
export function SessionTree({
  selectedId,
  onSelect,
  allLabel,
}: {
  selectedId: string | null;
  onSelect: (sid: string | null) => void;
  allLabel?: string;
}) {
  const { sessions } = useApp();
  const [collapsedCwds, setCollapsedCwds] = useState<Set<string>>(new Set());
  const toggleCwd = (cwd: string) => {
    setCollapsedCwds((prev) => {
      const next = new Set(prev);
      if (next.has(cwd)) next.delete(cwd);
      else next.add(cwd);
      return next;
    });
  };

  const groups = useMemo(() => {
    const g: Record<string, SessionSummary[]> = {};
    for (const s of sessions) {
      const arr = g[s.cwd] ?? (g[s.cwd] = []);
      arr.push(s);
    }
    return g;
  }, [sessions]);

  const groupEntries = Object.entries(groups);

  return (
    <ul className="session-tree">
      {allLabel && (
        <li
          className={`tree-all${selectedId === null ? " active" : ""}`}
          onClick={() => onSelect(null)}
        >
          {allLabel}
        </li>
      )}
      {groupEntries.length === 0 && !allLabel ? (
        <li className="empty-state">
          <span className="es-hint">暂无 session</span>
          <span className="es-sub">启动 Claude Code 后会出现</span>
        </li>
      ) : (
        groupEntries.map(([cwd, sess]) => {
          const collapsed = collapsedCwds.has(cwd);
          return (
            <li className="group" key={cwd}>
              <div className="group-head" title={cwd} onClick={() => toggleCwd(cwd)}>
                <span className="group-caret">{collapsed ? "▸" : "▾"}</span>
                <span className="group-cwd">{cwd}</span>
              </div>
              {!collapsed && (
                <ul>
                  {sess.map((s) => (
                    <li
                      key={s.sessionId}
                      className={s.sessionId === selectedId ? "active" : undefined}
                      title={s.sessionId}
                      onClick={() => onSelect(s.sessionId)}
                    >
                      <div className="sess-row">
                        <span className="sess-time">{fmtDateTime(s.lastActive)}</span>
                        <span className="sess-sid">{s.sessionId.slice(0, 8)}</span>
                        {s.tokenTotal && (realInput(s.tokenTotal) > 0 || s.tokenTotal.output > 0) && (
                          <span className="sess-tokens" title={fmtUsageFull(s.tokenTotal)}>
                            {fmtTokens(realInput(s.tokenTotal) + s.tokenTotal.output)}
                          </span>
                        )}
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </li>
          );
        })
      )}
    </ul>
  );
}
