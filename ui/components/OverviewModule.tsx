import { useMemo } from "react";
import { useApi } from "../hooks/useApi";
import { useEvents } from "../hooks/useEvents";
import { useAllCommits } from "../hooks/useAllCommits";
import { useProjects } from "../hooks/useProjects";
import { useApp } from "../state/AppContext";
import { fmtDateTime, fmtTokens, rawTotal, shortDir } from "../lib/util";

interface TimelineItem {
  ts: number;
  kind: "event" | "commit";
  text: string;
  cwd: string;
}

/** 概览首页:KPI(走 /api/projects 的 totals,ccusage 口径) + 近期活动时间线。
 *  P3 起不再直拉 /api/report、不依赖全局 sessions;项目 cwds 来自 useProjects 喂 useAllCommits。 */
export function OverviewModule() {
  const { token, stats } = useApp();
  const api = useApi(token);
  const { events } = useEvents(api, null, true);
  const { projects, totals } = useProjects(api, true);
  const { commits } = useAllCommits(api, projects.map((p) => p.cwd), true);

  const tot = totals?.tokens ?? null;

  const recent = useMemo<TimelineItem[]>(() => {
    const es: TimelineItem[] = events.slice(0, 20).map((e) => ({
      ts: e.timestamp,
      kind: "event",
      text: e.type,
      cwd: e.cwd,
    }));
    const cs: TimelineItem[] = commits.slice(0, 20).map((c) => ({
      ts: c.time,
      kind: "commit",
      text: c.subject || "(无说明)",
      cwd: c.cwd,
    }));
    return [...es, ...cs].sort((a, b) => b.ts - a.ts).slice(0, 20);
  }, [events, commits]);

  return (
    <div className="overview-view">
      <div className="kpi-grid">
        <div className="kpi-card">
          <span className="kpi-label">Token 总量</span>
          <b className="kpi-value">{tot ? fmtTokens(rawTotal(tot)) : "…"}</b>
        </div>
        <div className="kpi-card">
          <span className="kpi-label">Token 输出</span>
          <b className="kpi-value">{tot ? fmtTokens(tot.output) : "…"}</b>
        </div>
        <div className="kpi-card">
          <span className="kpi-label">会话数</span>
          <b className="kpi-value">{totals?.sessions ?? "…"}</b>
        </div>
        <div className="kpi-card">
          <span className="kpi-label">事件总数</span>
          <b className="kpi-value">{stats?.totalEvents ?? 0}</b>
        </div>
        <div className="kpi-card">
          <span className="kpi-label">提交数</span>
          <b className="kpi-value">{commits.length}</b>
        </div>
      </div>
      <section className="sum-section">
        <div className="sum-head">
          <h3>近期活动</h3>
        </div>
        {recent.length === 0 ? (
          <div className="sum-empty">暂无活动</div>
        ) : (
          <ul className="sum-list">
            {recent.map((it, i) => (
              <li key={i}>
                <span className="sum-ts">{fmtDateTime(it.ts)}</span>
                <span className={`tl-kind ${it.kind}`}>{it.kind === "event" ? "事件" : "提交"}</span>
                <span className="sum-cwd" title={it.cwd}>
                  {shortDir(it.cwd) || "?"}
                </span>
                <span className="sum-subject">{it.text}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
