// 主组件:数据加载(10s 轮询 /api/reports) + dark wrapper + 侧栏/顶栏 + 视图路由。
// 全局过滤(时间范围+成员多选)在 App 层做,viewUsers 下传给所有页面/图表,保证口径一致。
// 过滤后 user/project 的 totalTokens 等全量快照不准,filterUsersByRange 会从 session 重算。
import { useEffect, useMemo, useState } from "react";
import type { UserAgg } from "../types";
import { fetchReports } from "../lib/api";
import { fmtDate } from "../lib/util";
import { filterUsersByRange, activeRange } from "../lib/derive";
import { Sidebar, type PageId } from "./shell/Sidebar";
import { TopBar, type Granularity, type RangeKey } from "./shell/TopBar";
import { OverviewPage } from "./overview/OverviewPage";
import { MemberPage } from "./member/MemberPage";

const DAY_MS = 86_400_000;
const RANGE_DAYS: Record<RangeKey, number> = { "7d": 7, "15d": 15, "30d": 30, all: 0 };

export function App() {
  const [users, setUsers] = useState<UserAgg[]>([]);
  const [page, setPage] = useState<PageId>("overview");
  const [dark, setDark] = useState(false); // 默认亮色(与 TokenWeb 参考页一致:亮主体 + 深色侧栏)
  const [selMember, setSelMember] = useState<string | null>(null); // 成员详情所选 gitUser
  const [meta, setMeta] = useState("加载中…");

  // 顶栏查询控件
  const [granularity, setGranularity] = useState<Granularity>("day");
  const [range, setRange] = useState<RangeKey>("all");
  const [selectedMembers, setSelectedMembers] = useState<string[]>([]);

  const load = async () => {
    try {
      const d = await fetchReports();
      setUsers(d.users);
      const totalSessions = d.users.reduce((a, u) => a + u.sessionCount, 0);
      setMeta(`${d.users.length} 用户 · ${totalSessions} 会话 · 更新于 ${fmtDate(Date.now())}`);
    } catch (e) {
      setMeta("加载失败: " + (e instanceof Error ? e.message : String(e)));
    }
  };

  useEffect(() => {
    load();
    const t = setInterval(load, 10000);
    return () => clearInterval(t);
  }, []);

  // 全局过滤:时间范围(重聚合 totals) + 成员多选
  const viewUsers = useMemo(() => {
    const days = RANGE_DAYS[range];
    const from = days > 0 ? Date.now() - days * DAY_MS : 0;
    let r = filterUsersByRange(users, from);
    if (selectedMembers.length > 0) r = r.filter((u) => selectedMembers.includes(u.gitUser));
    return r;
  }, [users, range, selectedMembers]);

  // 成员下拉用全量用户名(非 viewUsers,否则选中后自己会从列表消失)
  const allGitUsers = useMemo(() => users.map((u) => u.gitUser), [users]);

  const ar = activeRange(viewUsers);
  const rangeText = ar.max > 0 ? `${fmtDate(ar.min)} — ${fmtDate(ar.max)}` : "无数据";

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
            onRefresh={load}
          />

          <main className="flex-1 p-5 overflow-y-auto">
            <div className="mb-5">
              <h1 className="text-lg font-semibold text-foreground">{pageTitle}</h1>
              <p className="text-xs text-muted-foreground mt-0.5">{meta}</p>
            </div>

            {page === "overview" && (
              <OverviewPage
                users={viewUsers}
                dark={dark}
                granularity={granularity}
                onSelectMember={(u) => {
                  setSelMember(u);
                  setPage("member");
                }}
              />
            )}
            {page === "member" && (
              <MemberPage users={viewUsers} dark={dark} selected={selMember} setSelected={setSelMember} />
            )}
          </main>
        </div>
      </div>
    </div>
  );
}
