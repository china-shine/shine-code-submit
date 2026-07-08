// 「数据上报」模块:跨项目聚合(版本/git 用户/会话数+每会话 token/提交次数+行数+时间)。
// 数据来自 GET /api/report?since=<ms>(0=全部)。后期要真·上报服务器时,把底部占位按钮接上即可。
import { useEffect, useState } from "react";
import { useApi } from "../hooks/useApi";
import { useApp } from "../state/AppContext";
import type { ReportProject, ReportResponse } from "../types";
import { fmtDateTime, fmtTokens, fmtUsage, fmtUsageFull, shortDir } from "../lib/util";

type Range = "all" | "7d" | "30d";

const RANGES: Array<{ id: Range; label: string; days: number }> = [
  { id: "all", label: "全部", days: 0 },
  { id: "7d", label: "近 7 天", days: 7 },
  { id: "30d", label: "近 30 天", days: 30 },
];

function rangeSince(r: Range): number {
  const days = RANGES.find((x) => x.id === r)!.days;
  return days > 0 ? Date.now() - days * 86400000 : 0;
}

export function ReportModule() {
  const { token } = useApp();
  const api = useApi(token);
  const [range, setRange] = useState<Range>("all");
  const [data, setData] = useState<ReportResponse | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [openCwd, setOpenCwd] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setErr(null);
    setData(null);
    api<ReportResponse>(`/api/report?since=${rangeSince(range)}`)
      .then((d) => !cancelled && setData(d))
      .catch((e) => !cancelled && setErr(String(e)));
    return () => {
      cancelled = true;
    };
  }, [api, range]);

  return (
    <div className="stats-view">
      <div className="toolbar">
        <div className="tabs">
          {RANGES.map((r) => (
            <button
              key={r.id}
              type="button"
              className={`tab${range === r.id ? " active" : ""}`}
              onClick={() => setRange(r.id)}
            >
              {r.label}
            </button>
          ))}
        </div>
        {/* 占位:后期接「上报到服务器」(POST 本报告到远端)。现在禁用,提示敬请期待。 */}
        <button type="button" className="tab" disabled title="后期接入:把本报告上报到服务器(占位)">
          ☁ 上报到服务器(敬请期待)
        </button>
      </div>

      <div className="stats-body">
        {err && <div className="sum-empty">加载失败:{err}</div>}
        {!err && !data && <div className="sum-empty">加载中…</div>}
        {data && (
          <>
            <section className="sum-section">
              <div className="sum-head">
                <h3>汇总</h3>
              </div>
              <div className="bar-list">
                <div className="bar-row">
                  <span className="bar-label">软件版本</span>
                  <span className="bar-val">{data.version}</span>
                </div>
                <div className="bar-row">
                  <span className="bar-label">git 用户</span>
                  <span className="bar-val">{data.gitUser ?? "—"}</span>
                </div>
                <div className="bar-row">
                  <span className="bar-label">项目数</span>
                  <span className="bar-val">{data.totals.projects}</span>
                </div>
                <div className="bar-row">
                  <span className="bar-label">会话总数</span>
                  <span className="bar-val">{data.totals.sessions}</span>
                </div>
                <div className="bar-row">
                  <span className="bar-label">token 总量</span>
                  <span className="bar-val" title={fmtUsageFull(data.totals.tokens)}>
                    {fmtUsage(data.totals.tokens) || "—"}
                  </span>
                </div>
                <div className="bar-row">
                  <span className="bar-label">提交总数</span>
                  <span className="bar-val">
                    {data.totals.commitCount} · +{fmtTokens(data.totals.added)}/-{fmtTokens(data.totals.deleted)}
                  </span>
                </div>
              </div>
            </section>

            {data.projects.length === 0 && <div className="sum-empty">窗口内无项目数据</div>}
            {data.projects.map((p) => (
              <ReportCard
                key={p.cwd}
                p={p}
                open={openCwd === p.cwd}
                onToggle={() => setOpenCwd(openCwd === p.cwd ? null : p.cwd)}
              />
            ))}
          </>
        )}
      </div>
    </div>
  );
}

function ReportCard({ p, open, onToggle }: { p: ReportProject; open: boolean; onToggle: () => void }) {
  return (
    <section className="sum-section">
      <div className="sum-head">
        <h3 title={p.cwd}>{shortDir(p.cwd) || p.cwd}</h3>
        <span style={{ marginLeft: "auto", opacity: 0.65, fontSize: "var(--fs-xs)" }}>
          {p.gitUser ? `@${p.gitUser}` : "@—"}
          {p.gitError ? " · git 不可用" : ""}
        </span>
        <button type="button" className="tab" onClick={onToggle} style={{ marginLeft: "0.5rem" }}>
          {open ? "收起" : "展开"}
        </button>
      </div>
      <div className="bar-list">
        <div className="bar-row">
          <span className="bar-label">会话</span>
          <span className="bar-val">{p.sessionCount}</span>
        </div>
        <div className="bar-row">
          <span className="bar-label">token</span>
          <span className="bar-val" title={fmtUsageFull(p.totalTokens)}>
            {fmtUsage(p.totalTokens) || "—"}
          </span>
        </div>
        <div className="bar-row">
          <span className="bar-label">提交</span>
          <span className="bar-val">
            {p.commits.count} · +{fmtTokens(p.commits.added)}/-{fmtTokens(p.commits.deleted)}
          </span>
        </div>
        <div className="bar-row">
          <span className="bar-label">最近提交</span>
          <span className="bar-val">{p.commits.lastTime ? fmtDateTime(p.commits.lastTime) : "—"}</span>
        </div>
      </div>

      {open && (
        <>
          <div className="sum-head" style={{ marginTop: "0.8rem" }}>
            <h3>会话 token 明细 · {p.sessions.length}</h3>
          </div>
          {p.sessions.length === 0 ? (
            <div className="sum-empty">无会话</div>
          ) : (
            <div className="bar-list">
              {p.sessions.map((s) => (
                <div className="bar-row" key={s.sessionId}>
                  <span className="bar-label" title={s.sessionId}>
                    {s.sessionId.slice(0, 8)} · {fmtDateTime(s.lastActive)}
                  </span>
                  <span className="bar-val" title={fmtUsageFull(s.tokenTotal)}>
                    {fmtUsage(s.tokenTotal) || "—"}
                  </span>
                </div>
              ))}
            </div>
          )}

          <div className="sum-head" style={{ marginTop: "0.8rem" }}>
            <h3>最近提交 · {p.recentCommits.length}</h3>
          </div>
          {p.recentCommits.length === 0 ? (
            <div className="sum-empty">无提交</div>
          ) : (
            <div className="bar-list">
              {p.recentCommits.map((c) => (
                <div className="bar-row" key={c.hash}>
                  <span className="bar-label" title={c.subject}>
                    {(c.subject || c.hash).slice(0, 40)}
                  </span>
                  <span className="bar-val">
                    {fmtDateTime(c.time)} · +{c.added}/-{c.deleted}
                  </span>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </section>
  );
}
