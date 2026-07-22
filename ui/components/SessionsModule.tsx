// 会话模块:三级表格钻取。L1 项目表 → L2 session 表 → L3 聊天详情(SessionDetail 复用)。
// 每级 PagedTable 服务端分页;面包屑返回上级;L1 头部 token 汇总(与报表对称,来自 useProjects totals)。
import { useState } from "react";
import { useApp } from "../state/AppContext";
import { useApi } from "../hooks/useApi";
import { useProjects } from "../hooks/useProjects";
import { PagedTable, type Column } from "./PagedTable";
import { SessionDetail } from "./SessionDetail";
import { fmtDateTime, fmtTokens, fmtUsageLabeled, rawTotal, shortDir } from "../lib/util";
import type {
  ProjectSession,
  ProjectSessionsResponse,
  ProjectSummary,
  ProjectsResponse,
} from "../types";

const PROJECT_COLS: Column<ProjectSummary>[] = [
  { key: "name", header: "项目", render: (p) => <span title={p.cwd}>{p.name}</span> },
  { key: "sessionCount", header: "会话数", thClassName: "rt-num", tdClassName: "rt-num", render: (p) => p.sessionCount },
  { key: "token", header: "Token", thClassName: "rt-num", tdClassName: "rt-num", render: (p) => fmtTokens(rawTotal(p.totalTokens)) },
  { key: "lastActive", header: "最后活跃", render: (p) => fmtDateTime(p.lastActive) },
];

const SESSION_COLS: Column<ProjectSession>[] = [
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
];

export function SessionsModule() {
  const { token, selectedSessionId, setSelectedSessionId } = useApp();
  const api = useApi(token);
  const { totals } = useProjects(api, true);
  const [view, setView] = useState<"l1" | "l2" | "l3">("l1");
  const [selCwd, setSelCwd] = useState<string | null>(null);

  const crumbs = [
    { label: "项目", onClick: view !== "l1" ? () => setView("l1") : undefined },
    ...(selCwd ? [{ label: shortDir(selCwd), onClick: view === "l3" ? () => setView("l2") : undefined }] : []),
    ...(view === "l3" && selectedSessionId ? [{ label: selectedSessionId.slice(0, 8) }] : []),
  ].filter((it) => it.label);

  return (
    <div className="report-view" style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
      <div className="panel-header" style={{ display: "flex", gap: "0.6rem", alignItems: "center", flexWrap: "wrap" }}>
        {crumbs.map((it, i) => (
          <span key={i} style={{ display: "inline-flex", alignItems: "center", gap: "0.4rem" }}>
            {it.onClick ? (
              <button type="button" className="tab" onClick={it.onClick}>
                {it.label}
              </button>
            ) : (
              <b>{it.label}</b>
            )}
            {i < crumbs.length - 1 && <span style={{ color: "#9aa" }}>/</span>}
          </span>
        ))}
        {view === "l1" && totals && (
          <span style={{ marginLeft: "auto" }}>
            {totals.projects} 项目 · {totals.sessions} 会话 · {fmtUsageLabeled(totals.tokens)}
          </span>
        )}
      </div>
      <div style={{ flex: "1 1 0", minHeight: 0, display: "flex", flexDirection: "column" }}>
        {view === "l1" && (
          <PagedTable<ProjectSummary>
            columns={PROJECT_COLS}
            pageSize={20}
            rowKey={(p) => p.cwd}
            fetchPage={async (page) => {
              const r = await api<ProjectsResponse>(`/api/projects?page=${page}&pageSize=20`);
              return { rows: r.projects, total: r.total };
            }}
            onRowClick={(p) => {
              setSelCwd(p.cwd);
              setView("l2");
            }}
          />
        )}
        {view === "l2" && selCwd && (
          <PagedTable<ProjectSession>
            columns={SESSION_COLS}
            pageSize={20}
            rowKey={(s) => s.sessionId}
            fetchPage={async (page) => {
              const r = await api<ProjectSessionsResponse>(
                `/api/sessions?cwd=${encodeURIComponent(selCwd)}&page=${page}&pageSize=20`,
              );
              return { rows: r.sessions, total: r.total };
            }}
            onRowClick={(s) => {
              setSelectedSessionId(s.sessionId);
              setView("l3");
            }}
          />
        )}
        {view === "l3" && selectedSessionId && (
          <SessionDetail sessionId={selectedSessionId} cwd={selCwd ?? undefined} />
        )}
      </div>
    </div>
  );
}
