// 报表模块:二级表格钻取。L1 项目表(顶部 totals + 上报按钮) → L2 session 明细表。
// 每级 PagedTable 服务端分页;L2 用 /api/sessions?cwd=(与会话模块 L2 同源)。不再直拉 /api/report 全量。
import { useState } from "react";
import { useApi } from "../hooks/useApi";
import { useApp } from "../state/AppContext";
import { useProjects } from "../hooks/useProjects";
import { PagedTable, type Column } from "./PagedTable";
import { fmtDateTime, fmtTokens, fmtUsageLabeled, rawTotal } from "../lib/util";
import type {
  ProjectSession,
  ProjectSessionsResponse,
  ProjectSummary,
  ProjectsResponse,
} from "../types";

export function ReportModule() {
  const { token } = useApp();
  const api = useApi(token);
  const { totals } = useProjects(api, true);
  const [selCwd, setSelCwd] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadResult, setUploadResult] = useState<{ ok: boolean; text: string } | null>(null);

  const projectCols: Column<ProjectSummary>[] = [
    { key: "name", header: "项目", render: (p) => <span title={p.cwd}>{p.name}</span> },
    { key: "gitUser", header: "成员", render: (p) => p.gitUser ?? "—" },
    { key: "sessionCount", header: "会话", thClassName: "rt-num", tdClassName: "rt-num", render: (p) => p.sessionCount },
    { key: "token", header: "Token", thClassName: "rt-num", tdClassName: "rt-num", render: (p) => fmtTokens(rawTotal(p.totalTokens)) },
    {
      key: "lines",
      header: "代码变更",
      thClassName: "rt-num", tdClassName: "rt-num",
      render: (p) => `+${p.totalLines.added} -${p.totalLines.deleted} M${p.totalLines.modified}`,
    },
    { key: "lastActive", header: "最后活跃", render: (p) => fmtDateTime(p.lastActive) },
  ];
  const sessionCols: Column<ProjectSession>[] = [
    { key: "sid", header: "Session", render: (s) => <span title={s.sessionId} style={{ fontFamily: "monospace" }}>{s.sessionId.slice(0, 8)}</span> },
    {
      key: "title",
      header: "标题",
      render: (s) => (
        <div
          title={s.title || s.sessionId}
          style={{ width: 300, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
        >
          {s.title || s.sessionId.slice(0, 8)}
        </div>
      ),
    },
    { key: "lastActive", header: "时间", render: (s) => fmtDateTime(s.lastActive) },
    { key: "input", header: "输入 token", thClassName: "rt-num", tdClassName: "rt-num", render: (s) => fmtTokens(s.tokenTotal?.input ?? 0) },
    { key: "output", header: "输出 token", thClassName: "rt-num", tdClassName: "rt-num", render: (s) => fmtTokens(s.tokenTotal?.output ?? 0) },
    { key: "cc", header: "缓存创建", thClassName: "rt-num", tdClassName: "rt-num", render: (s) => fmtTokens(s.tokenTotal?.cacheCreation ?? 0) },
    { key: "cr", header: "缓存读", thClassName: "rt-num", tdClassName: "rt-num", render: (s) => fmtTokens(s.tokenTotal?.cacheRead ?? 0) },
    { key: "total", header: "总数", thClassName: "rt-num", tdClassName: "rt-num", render: (s) => fmtTokens(rawTotal(s.tokenTotal)) },
    {
      key: "lines",
      header: "代码变更",
      thClassName: "rt-num", tdClassName: "rt-num",
      render: (s) => (s.linesTotal ? `+${s.linesTotal.added} -${s.linesTotal.deleted} M${s.linesTotal.modified}` : "-"),
    },
  ];

  return (
    <div className="report-view" style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
      <div
        className="panel-header"
        style={{ display: "flex", gap: "1.1rem", alignItems: "baseline", flexWrap: "wrap" }}
      >
        <b>报表</b>
        {totals && (
          <span style={{ marginLeft: "auto" }}>
            {totals.projects} 项目 · {totals.sessions} 会话 · {fmtUsageLabeled(totals.tokens)}
          </span>
        )}
        <button
          type="button"
          className="tab"
          disabled={uploading}
          title="手动上报报表到服务器(需先在「设置」配置上报地址)"
          onClick={async () => {
            setUploading(true);
            setUploadResult(null);
            try {
              const r = await fetch(`${location.origin}/api/report/upload`, {
                method: "POST",
                headers: { Authorization: `Bearer ${token}` },
              });
              const j = await r.json().catch(() => ({}));
              if (r.ok && j.status === "ok") setUploadResult({ ok: true, text: "上报成功" });
              else if (r.ok && j.status === "skipped")
                setUploadResult({ ok: false, text: `已跳过：${j.reason ?? "无 git 身份"}` });
              else setUploadResult({ ok: false, text: j.error ?? `HTTP ${r.status}` });
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
        {uploadResult && <span className={uploadResult.ok ? "field-ok" : "field-err"}>{uploadResult.text}</span>}
      </div>
      <div style={{ flex: "1 1 0", minHeight: 0, display: "flex", flexDirection: "column" }}>
        {!selCwd ? (
          <PagedTable<ProjectSummary>
            columns={projectCols}
            pageSize={20}
            rowKey={(p) => p.cwd}
            fetchPage={async (page) => {
              const r = await api<ProjectsResponse>(`/api/projects?page=${page}&pageSize=20`);
              return { rows: r.projects, total: r.total };
            }}
            onRowClick={(p) => setSelCwd(p.cwd)}
          />
        ) : (
          <>
            <div className="panel-header" style={{ paddingBottom: "0.4rem" }}>
              <button type="button" className="tab" onClick={() => setSelCwd(null)}>
                ‹ 返回项目列表
              </button>
              <span title={selCwd} style={{ marginLeft: "0.6rem" }}>
                {selCwd}
              </span>
            </div>
            <PagedTable<ProjectSession>
              columns={sessionCols}
              pageSize={20}
              rowKey={(s) => s.sessionId}
              fetchPage={async (page) => {
                const r = await api<ProjectSessionsResponse>(
                  `/api/sessions?cwd=${encodeURIComponent(selCwd)}&page=${page}&pageSize=20`,
                );
                return { rows: r.sessions, total: r.total };
              }}
            />
          </>
        )}
      </div>
    </div>
  );
}
