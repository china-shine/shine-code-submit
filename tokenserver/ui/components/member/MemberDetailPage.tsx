// 成员详情:返回 + 头像 + 6 KPI + Token 使用趋势 + 与团队均值对比 + 该用户最近会话表。
// 全部服务端化:KPI/趋势 = /api/member/:X;团队均值 = 全局 stats.totals;会话表 = /api/sessions?member=X(翻页查 DB)。
import { useEffect, useState } from "react";
import { ChevronRight } from "lucide-react";
import { AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from "recharts";
import type { MemberDetail, SessionsPage, StatsPayload } from "../../types";
import { rawTotal, lineTotal, inoutTokens, fmtK, fmtFull, fmtDuration, C } from "../../lib/derive";
import { fmtDate } from "../../lib/util";
import { fetchMember, fetchSessions } from "../../lib/api";
import { Avatar } from "../common/Avatar";
import { RecentSessionsTable } from "../overview/RecentSessionsTable";
import { chartTheme } from "../overview/chartTheme";
import type { Granularity, RangeKey } from "../shell/TopBar";

const PAGE_SIZE = 20;

export function MemberDetailPage({
  dark,
  gitUser,
  granularity,
  range,
  teamStats,
  onBack,
}: {
  dark: boolean;
  gitUser: string;
  granularity: Granularity;
  range: RangeKey;
  teamStats: StatsPayload["totals"];
  onBack: () => void;
}) {
  const [member, setMember] = useState<MemberDetail | null>(null);
  const [sessionsPage, setSessionsPage] = useState<SessionsPage | null>(null);
  const [pageNum, setPageNum] = useState(1);

  // 进详情/range/granularity 变 → 拉单成员 + 会话首页
  useEffect(() => {
    let cancelled = false;
    setMember(null);
    Promise.all([
      fetchMember(gitUser, { range, granularity }),
      fetchSessions({ range, members: [], member: gitUser, page: 1, pageSize: PAGE_SIZE }),
    ])
      .then(([m, sp]) => {
        if (!cancelled) {
          setMember(m);
          setSessionsPage(sp);
          setPageNum(1);
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [gitUser, range, granularity]);

  const loadPage = async (n: number) => {
    try {
      const sp = await fetchSessions({ range, members: [], member: gitUser, page: n, pageSize: PAGE_SIZE });
      setSessionsPage(sp);
      setPageNum(n);
    } catch {
      /* ignore */
    }
  };

  const { tooltipStyle, tickStyle, gridStroke } = chartTheme(dark);

  if (!member) {
    return (
      <div className="text-muted-foreground">
        加载中…
        <button onClick={onBack} className="text-primary hover:underline ml-2">返回</button>
      </div>
    );
  }

  const t = member.totals;
  const token = t.rawTotal;
  const lines = lineTotal(t.lines);
  const inout = inoutTokens(t.token);
  const eff = inout > 0 ? Math.round((lines / inout) * 1_000_000) : 0;
  const trend = member.trend;
  const granularityLabel = { day: "日", week: "周", month: "月" }[granularity];
  const range2 = trend.length > 0 ? `${trend[0].date} – ${trend[trend.length - 1].date}` : "—";

  // 团队均值(全局 teamStats;teamMembers 作分母)
  const teamMembers = teamStats.members;
  const teamAvg = {
    token: teamMembers > 0 ? Math.round(teamStats.rawTotal / teamMembers) : 0,
    convs: teamMembers > 0 ? Math.round(teamStats.sessions / teamMembers) : 0,
    lines: teamMembers > 0 ? Math.round(lineTotal(teamStats.lines) / teamMembers) : 0,
  };

  const kpis = [
    { label: "对话次数", value: fmtFull(t.sessions), color: "text-indigo-600 dark:text-indigo-400" },
    { label: "对话总时长", value: fmtDuration(t.activeMs), color: "text-orange-600 dark:text-orange-400" },
    { label: "总 Token", value: fmtK(token), color: "text-violet-600 dark:text-violet-400" },
    { label: "代码行数", value: fmtFull(lines), color: "text-teal-600 dark:text-teal-400" },
    { label: "活跃项目", value: fmtFull(t.realProjects), color: "text-blue-600 dark:text-blue-400" },
    { label: "Token 效率", value: `${eff} 行/M`, color: "text-foreground" },
  ];
  const compare = [
    { label: "Token 消耗", personal: token, avg: teamAvg.token },
    { label: "对话次数", personal: t.sessions, avg: teamAvg.convs },
    { label: "代码行数", personal: lines, avg: teamAvg.lines },
  ];

  return (
    <div className="space-y-5">
      <button onClick={onBack} className="flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground transition-colors">
        <ChevronRight className="w-4 h-4 rotate-180" /> 返回成员列表
      </button>

      <div className="flex items-center gap-4">
        <Avatar name={member.gitUser || "?"} size="lg" />
        <div>
          <h2 className="text-lg font-semibold text-foreground">{member.gitUser || "未知"}</h2>
          <p className="text-xs text-muted-foreground mt-0.5">最后同步 {fmtDate(member.lastActive)}</p>
        </div>
      </div>

      <div className="grid grid-cols-6 gap-4">
        {kpis.map((m) => (
          <div key={m.label} className="bg-card border border-border rounded p-4 text-center">
            <div className={`text-xl font-bold font-mono ${m.color}`}>{m.value}</div>
            <div className="text-xs text-muted-foreground mt-1">{m.label}</div>
          </div>
        ))}
      </div>

      <div className="grid grid-cols-12 gap-4">
        <div className="col-span-8 bg-card border border-border rounded p-4">
          <h3 className="text-sm font-semibold text-foreground">Token 使用趋势</h3>
          <p className="text-xs text-muted-foreground mt-0.5 mb-4">{range2} · 按会话最后活跃{granularityLabel}聚合</p>
          <ResponsiveContainer width="100%" height={200}>
            <AreaChart data={trend} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
              <defs>
                <linearGradient id="memGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor={C.input} stopOpacity={0.2} />
                  <stop offset="95%" stopColor={C.input} stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke={gridStroke} />
              <XAxis dataKey="date" tick={tickStyle} tickLine={false} axisLine={false} />
              <YAxis tickFormatter={(v) => fmtK(v)} tick={tickStyle} tickLine={false} axisLine={false} width={42} />
              <Tooltip contentStyle={tooltipStyle} formatter={(v: number) => [fmtK(v) + " tokens", "Token 消耗"]} />
              <Area type="monotone" dataKey="total" stroke={C.input} strokeWidth={2} fill="url(#memGrad)" dot={false} />
            </AreaChart>
          </ResponsiveContainer>
        </div>

        <div className="col-span-4 bg-card border border-border rounded p-4">
          <h3 className="text-sm font-semibold text-foreground mb-4">与团队均值对比</h3>
          {teamMembers <= 1 ? (
            <p className="text-xs text-muted-foreground py-4 text-center">仅 {teamMembers} 名成员,无团队对比意义(需 ≥2 名成员)</p>
          ) : (
            <div className="space-y-4">
              {compare.map((c) => {
                const max = Math.max(c.personal, c.avg, 1);
                return (
                  <div key={c.label}>
                    <p className="text-xs text-muted-foreground mb-1.5">{c.label}</p>
                    <div className="space-y-1.5">
                      <div className="flex items-center gap-2">
                        <span className="text-xs font-mono text-foreground w-14 text-right">
                          {c.personal >= 1000 ? fmtK(c.personal) : c.personal}
                        </span>
                        <div className="flex-1 h-2 bg-muted rounded-full overflow-hidden">
                          <div className="h-full bg-indigo-500 rounded-full transition-all" style={{ width: `${(c.personal / max) * 100}%` }} />
                        </div>
                        <span className="text-xs text-indigo-600 dark:text-indigo-400 w-7">本人</span>
                      </div>
                      <div className="flex items-center gap-2">
                        <span className="text-xs font-mono text-muted-foreground w-14 text-right">
                          {c.avg >= 1000 ? fmtK(c.avg) : c.avg}
                        </span>
                        <div className="flex-1 h-2 bg-muted rounded-full overflow-hidden">
                          <div className="h-full bg-muted-foreground/40 rounded-full transition-all" style={{ width: `${(c.avg / max) * 100}%` }} />
                        </div>
                        <span className="text-xs text-muted-foreground w-7">均值</span>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      <RecentSessionsTable
        rows={sessionsPage?.rows ?? []}
        total={sessionsPage?.total ?? 0}
        page={pageNum}
        pageSize={PAGE_SIZE}
        onPageChange={loadPage}
      />
    </div>
  );
}
