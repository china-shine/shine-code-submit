import type { StatsPayload, SessionsPage, MemberDetail, Granularity } from "../types";

export async function fetchStats(opts: {
  range: string;
  members: string[];
  granularity: Granularity;
}): Promise<StatsPayload> {
  const p = new URLSearchParams({ range: opts.range, granularity: opts.granularity });
  if (opts.members.length) p.set("members", opts.members.join(","));
  const r = await fetch(`/api/stats?${p}`);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

export async function fetchSessions(opts: {
  range: string;
  members: string[];
  member?: string;
  page: number;
  pageSize: number;
}): Promise<SessionsPage> {
  const p = new URLSearchParams({
    range: opts.range,
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
  opts: { range: string; granularity: Granularity },
): Promise<MemberDetail> {
  const p = new URLSearchParams({ range: opts.range, granularity: opts.granularity });
  const r = await fetch(`/api/member/${encodeURIComponent(gitUser)}?${p}`);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}
