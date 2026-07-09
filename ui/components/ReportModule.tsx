// 「数据上报」模块:顶部汇总标题 + 左侧项目导航(仅项目名) + 右侧 session 表格(分页,隐藏 0 token)。
// 表格列:Session / 时间 / 输入 token / 输出 token;标题显示该项目的输入/输出 token 汇总。
// 数据来自 GET /api/report?since=0(全部)。后期真·上报服务器时,把顶部占位按钮接上即可。
import { useEffect, useState } from "react";
import { useApi } from "../hooks/useApi";
import { useApp } from "../state/AppContext";
import { Icon } from "./Icon";
import { Splitter } from "./Splitter";
import type { ReportProject, ReportResponse } from "../types";
import { fmtDateTime, fmtTokens, fmtUsageFull, fmtUsageLabeled, realInput, shortDir } from "../lib/util";

const PAGE = 20; // 每页 session 数

export function ReportModule() {
  const { token } = useApp();
  const api = useApi(token);
  const [data, setData] = useState<ReportResponse | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [selCwd, setSelCwd] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadResult, setUploadResult] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    let cancelled = false;
    setErr(null);
    api<ReportResponse>(`/api/report?since=0`)
      .then((d) => !cancelled && setData(d))
      .catch((e) => !cancelled && setErr(String(e)));
    return () => {
      cancelled = true;
    };
  }, [api]);

  // 默认选中第一个项目
  useEffect(() => {
    if (data && !selCwd && data.projects[0]) setSelCwd(data.projects[0].cwd);
  }, [data, selCwd]);

  const sel = data?.projects.find((p) => p.cwd === selCwd) ?? null;

  return (
    <div className="stats-view">
      {/* 顶部汇总标题 */}
      <div
        className="panel-header"
        style={{ display: "flex", gap: "1.1rem", alignItems: "baseline", flexWrap: "wrap" }}
      >
        {data ? (
          <>
            <b>报表</b>
            <span title="软件版本">v{data.version}</span>
            <span title="git 用户">👤 {data.gitUser ?? "—"}</span>
            <span>
              {data.totals.projects} 项目 · {data.totals.sessions} 会话
            </span>
            <button
              type="button"
              className="tab"
              disabled={uploading}
              title="手动上报报表到服务器(需先在「设置」配置上报地址)"
              style={{ marginLeft: "auto" }}
              onClick={async () => {
                setUploading(true);
                setUploadResult(null);
                try {
                  const r = await fetch(`${location.origin}/api/report/upload`, {
                    method: "POST",
                    headers: { Authorization: `Bearer ${token}` },
                  });
                  const j = await r.json().catch(() => ({}));
                  if (r.ok && j.status === "ok") {
                    setUploadResult({ ok: true, text: "上报成功" });
                  } else if (r.ok && j.status === "skipped") {
                    setUploadResult({ ok: false, text: `已跳过：${j.reason ?? "无 git 身份"}` });
                  } else {
                    setUploadResult({ ok: false, text: j.error ?? `HTTP ${r.status}` });
                  }
                } catch (e) {
                  setUploadResult({ ok: false, text: e instanceof Error ? e.message : String(e) });
                } finally {
                  setUploading(false);
                  setTimeout(() => setUploadResult(null), 3000);
                }
              }}
            >
              ☁ {uploading ? "上报中…" : "上报"}
            </button>
            {uploadResult && (
              <span className={uploadResult.ok ? "field-ok" : "field-err"}>{uploadResult.text}</span>
            )}
          </>
        ) : (
          <span>{err ? `加载失败:${err}` : "加载中…"}</span>
        )}
      </div>

      {/* 项目导航 | 详情表格 */}
      <div className="sessions-with-tree">
        <aside className="sessions-tree-panel panel">
          <div className="panel-header">
            <h2>项目 · {data?.projects.length ?? 0}</h2>
          </div>
          {!data || data.projects.length === 0 ? (
            <div className="empty-state" style={{ padding: "2rem 1rem" }}>
              <span className="es-hint">暂无项目</span>
              <span className="es-sub">启动 Claude Code 后会出现</span>
            </div>
          ) : (
            <ul className="report-nav">
              {data.projects.map((p) => (
                <li
                  key={p.cwd}
                  className={p.cwd === selCwd ? "active" : undefined}
                  title={p.cwd}
                  onClick={() => setSelCwd(p.cwd)}
                  style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: "0.5rem" }}
                >
                  <span>{shortDir(p.cwd) || p.cwd}</span>
                  <span className="nav-tokens" title={fmtUsageFull(p.totalTokens)}>
                    {fmtTokens(realInput(p.totalTokens) + p.totalTokens.output)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </aside>

        <Splitter orient="v" varName="--tree-w" />

        <div className="sessions-main">
          {sel ? (
            <ProjectDetail key={sel.cwd} p={sel} />
          ) : (
            <div className="empty-state">
              <Icon name="log" size={30} />
              <span className="es-hint">选左侧项目查看详情</span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/** 右侧详情:标题(仓库地址 + 用户 + token 汇总) + session 表格(分页,隐藏 0 token)。
 *  key=sel.cwd:换项目时重挂载,分页回到第 1 页。 */
function ProjectDetail({ p }: { p: ReportProject }) {
  const [page, setPage] = useState(1);
  // 过滤掉 0 token 的 session(tokenTotal 为 null 或 真实输入+输出=0)
  const rows = p.sessions.filter((s) => s.tokenTotal && realInput(s.tokenTotal) + s.tokenTotal.output > 0);
  const pageCount = Math.max(1, Math.ceil(rows.length / PAGE));
  const cur = Math.min(page, pageCount);
  const pageRows = rows.slice((cur - 1) * PAGE, cur * PAGE);

  return (
    <>
      <div className="report-title">
        {p.gitRemote && (
          <span
            className="rt-sum"
            title={p.gitRemote}
            style={{
              flex: "0 0 60ch",
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
            }}
          >
            🔗 {p.gitRemote}
          </span>
        )}
        <span className="rt-sum" title={fmtUsageFull(p.totalTokens)} style={{ marginLeft: "auto", color: "#9dbefe" }}>
          {fmtUsageLabeled(p.totalTokens)}
        </span>
        <span className="rt-sum" title={`代码变更 +${p.totalLines.added} -${p.totalLines.deleted} M${p.totalLines.modified}`} style={{ color: "#9aa" }}>
          +{p.totalLines.added} -{p.totalLines.deleted} M{p.totalLines.modified}
        </span>
      </div>

      <div style={{ overflow: "auto", flex: "1 1 0", minHeight: 0 }}>
        <table className="report-table">
          <thead>
            <tr>
              <th className="rt-idx">#</th>
              <th>Session</th>
              <th>时间</th>
              <th className="rt-num">输入 token</th>
              <th className="rt-num">输出 token</th>
              <th className="rt-num">总数</th>
              <th className="rt-num">代码变更</th>
            </tr>
          </thead>
          <tbody>
            {pageRows.map((s, idx) => (
              <tr key={s.sessionId}>
                <td className="rt-idx">{(cur - 1) * PAGE + idx + 1}</td>
                <td className="rt-sid" title={s.sessionId}>
                  {s.sessionId.slice(0, 8)}
                </td>
                <td>{fmtDateTime(s.lastActive)}</td>
                <td className="rt-num">{fmtTokens(realInput(s.tokenTotal!))}</td>
                <td className="rt-num">{fmtTokens(s.tokenTotal!.output)}</td>
                <td className="rt-num">{fmtTokens(realInput(s.tokenTotal!) + s.tokenTotal!.output)}</td>
                <td className="rt-num" title={s.linesTotal ? `+${s.linesTotal.added} -${s.linesTotal.deleted} M${s.linesTotal.modified}` : ""}>
                  {s.linesTotal ? `+${s.linesTotal.added} -${s.linesTotal.deleted} M${s.linesTotal.modified}` : "-"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {rows.length === 0 && <div className="sum-empty">无有效会话(均已隐藏 0 token)</div>}
      </div>

      <div className="report-pager">
        <button type="button" disabled={cur <= 1} onClick={() => setPage(cur - 1)}>
          ‹ 上一页
        </button>
        <span>
          第 {cur} / {pageCount} 页
        </span>
        <button type="button" disabled={cur >= pageCount} onClick={() => setPage(cur + 1)}>
          下一页 ›
        </button>
        <span style={{ marginLeft: "auto" }}>共 {rows.length} 个会话(已隐藏 0 token)</span>
      </div>
    </>
  );
}
