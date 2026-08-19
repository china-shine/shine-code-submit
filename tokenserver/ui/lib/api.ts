import type { StatsPayload, SessionsPage, MemberDetail, WorklogPage } from "../types";

// 趋势图固定按日聚合（日/周/月切换已移除），URL 始终带 granularity=day。
const GRANULARITY = "day";

// 访问令牌：服务端配了 viewToken 时 API 需带 ?t=（看板链接 /?t=<令牌> 透传；未配置则空，服务端不校验）。
const TOKEN = new URLSearchParams(location.search).get("t") ?? "";

export async function apiGet(path: string, p: URLSearchParams): Promise<Response> {
  if (TOKEN) p.set("t", TOKEN);
  const r = await fetch(`${path}?${p}`);
  if (r.status === 401) throw new Error("HTTP 401：缺少访问 token，请用带 ?t=<令牌> 的链接打开");
  return r;
}

export async function fetchStats(opts: {
  startDate: string;
  endDate: string;
  members: string[];
}): Promise<StatsPayload> {
  const p = new URLSearchParams({ start: opts.startDate, end: opts.endDate, granularity: GRANULARITY });
  if (opts.members.length) p.set("members", opts.members.join(","));
  const r = await apiGet("/api/stats", p);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

export async function fetchSessions(opts: {
  startDate: string;
  endDate: string;
  members: string[];
  member?: string;
  page: number;
  pageSize: number;
}): Promise<SessionsPage> {
  const p = new URLSearchParams({
    start: opts.startDate,
    end: opts.endDate,
    page: String(opts.page),
    pageSize: String(opts.pageSize),
  });
  if (opts.members.length) p.set("members", opts.members.join(","));
  if (opts.member) p.set("member", opts.member);
  const r = await apiGet("/api/sessions", p);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

export async function fetchMember(
  gitUser: string,
  opts: { startDate: string; endDate: string },
): Promise<MemberDetail> {
  const p = new URLSearchParams({ start: opts.startDate, end: opts.endDate, granularity: GRANULARITY });
  const r = await apiGet(`/api/member/${encodeURIComponent(gitUser)}`, p);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

export async function fetchMemberWorklogs(
  gitUser: string,
  opts: { startDate: string; endDate: string; page: number; pageSize: number },
): Promise<WorklogPage> {
  const p = new URLSearchParams({
    start: opts.startDate,
    end: opts.endDate,
    page: String(opts.page),
    pageSize: String(opts.pageSize),
  });
  const r = await apiGet(`/api/member/${encodeURIComponent(gitUser)}/worklog`, p);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}
