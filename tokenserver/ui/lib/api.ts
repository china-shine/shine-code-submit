import type { StatsPayload, SessionsPage, MemberDetail } from "../types";

// 趋势图固定按日聚合（日/周/月切换已移除），URL 始终带 granularity=day。
const GRANULARITY = "day";

export async function fetchStats(opts: {
  startDate: string;
  endDate: string;
  members: string[];
}): Promise<StatsPayload> {
  const p = new URLSearchParams({ start: opts.startDate, end: opts.endDate, granularity: GRANULARITY });
  if (opts.members.length) p.set("members", opts.members.join(","));
  const r = await fetch(`/api/stats?${p}`);
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
  const r = await fetch(`/api/sessions?${p}`);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

export async function fetchMember(
  gitUser: string,
  opts: { startDate: string; endDate: string },
): Promise<MemberDetail> {
  const p = new URLSearchParams({ start: opts.startDate, end: opts.endDate, granularity: GRANULARITY });
  const r = await fetch(`/api/member/${encodeURIComponent(gitUser)}?${p}`);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}
