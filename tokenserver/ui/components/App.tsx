// 主组件:overview = /api/stats + /api/sessions;member = stats(成员列表/团队均值)+ /api/member/:X(详情)+ /api/sessions(会话表)。
// 手动刷新(TopBar 按钮),无自动轮询。不再拉 /api/reports 全量。全局过滤(range+members+granularity)下推后端。
import { useEffect, useState } from "react";
import type { StatsPayload, SessionsPage } from "../types";
import { fetchStats, fetchSessions } from "../lib/api";
import { fmtDate } from "../lib/util";
import { Sidebar, type PageId } from "./shell/Sidebar";
import { TopBar, type Granularity, type RangeKey } from "./shell/TopBar";
import { OverviewPage } from "./overview/OverviewPage";
import { MemberPage } from "./member/MemberPage";

const PAGE_SIZE = 20;

export function App() {
  const [stats, setStats] = useState<StatsPayload | null>(null);
  const [sessionsPage, setSessionsPage] = useState<SessionsPage | null>(null);
  const [pageNum, setPageNum] = useState(1);
  const [page, setPage] = useState<PageId>("overview");
  const [dark, setDark] = useState(false);
  const [selMember, setSelMember] = useState<string | null>(null);
  const [meta, setMeta] = useState("加载中…");

  const [granularity, setGranularity] = useState<Granularity>("day");
  const [range, setRange] = useState<RangeKey>("all");
  const [selectedMembers, setSelectedMembers] = useState<string[]>([]);

  const loadOverview = async () => {
    try {
      const [s, sp] = await Promise.all([
        fetchStats({ range, members: selectedMembers, granularity }),
        fetchSessions({ range, members: selectedMembers, page: 1, pageSize: PAGE_SIZE }),
      ]);
      setStats(s);
      setSessionsPage(sp);
      setPageNum(1);
      setMeta(`${s.totals.members} 成员 · ${s.totals.sessions} 会话 · 更新于 ${fmtDate(Date.now())}`);
    } catch (e) {
      setMeta("加载失败: " + (e instanceof Error ? e.message : String(e)));
    }
  };

  const loadPage = async (n: number) => {
    try {
      const sp = await fetchSessions({ range, members: selectedMembers, page: n, pageSize: PAGE_SIZE });
      setSessionsPage(sp);
      setPageNum(n);
    } catch (e) {
      setMeta("加载失败: " + (e instanceof Error ? e.message : String(e)));
    }
  };

  // 初始 + range/members/granularity 变 → 重调 overview(回 page 1)
  useEffect(() => {
    loadOverview();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [range, selectedMembers, granularity]);

  const ar = stats ? { min: stats.activeMin, max: stats.activeMax } : { min: 0, max: 0 };
  const rangeText = ar.max > 0 ? `${fmtDate(ar.min)} — ${fmtDate(ar.max)}` : "无数据";
  const allGitUsers = stats?.allMembers ?? [];

  const pageTitle = page === "overview" ? "数据总览" : "成员分析";
  const toggleMember = (g: string) =>
    setSelectedMembers((prev) => (prev.includes(g) ? prev.filter((x) => x !== g) : [...prev, g]));

  return (
    <div
      className={dark ? "dark" : ""}
      style={{ fontFamily: "'Inter', system-ui, -apple-system, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', sans-serif" }}
    >
      <div className="min-h-screen bg-background flex text-foreground" style={{ minWidth: 1100 }}>
        <Sidebar page={page} dark={dark} onNav={(p) => setPage(p)} onToggleDark={() => setDark((d) => !d)} />

        <div className="flex-1 flex flex-col min-w-0">
          <TopBar
            granularity={granularity}
            onGranularity={setGranularity}
            range={range}
            onRange={setRange}
            members={allGitUsers}
            selectedMembers={selectedMembers}
            onToggleMember={toggleMember}
            onClearMembers={() => setSelectedMembers([])}
            rangeText={rangeText}
            onRefresh={loadOverview}
          />

          <main className="flex-1 p-5 overflow-y-auto">
            <div className="mb-5">
              <h1 className="text-lg font-semibold text-foreground">{pageTitle}</h1>
              <p className="text-xs text-muted-foreground mt-0.5">{meta}</p>
            </div>

            {page === "overview" && stats && sessionsPage && (
              <OverviewPage
                stats={stats}
                sessionsPage={sessionsPage}
                pageNum={pageNum}
                pageSize={PAGE_SIZE}
                onPageChange={loadPage}
                dark={dark}
                granularity={granularity}
                onSelectMember={(u) => {
                  setSelMember(u);
                  setPage("member");
                }}
              />
            )}
            {page === "member" && stats && (
              <MemberPage
                stats={stats}
                dark={dark}
                granularity={granularity}
                range={range}
                selected={selMember}
                setSelected={setSelMember}
              />
            )}
          </main>
        </div>
      </div>
    </div>
  );
}
