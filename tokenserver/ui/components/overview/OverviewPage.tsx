// 数据总览:6 KPI(含 sparkline) + (趋势|构成饼图) + (Token排行|代码排行|会话规模分布) + 最近会话表。
// granularity 透传给趋势图(日/周/月聚合)。users 已经过 App 层时间范围+成员过滤。
import type { UserAgg } from "../../types";
import type { Granularity } from "../shell/TopBar";
import { KpiCards } from "./KpiCards";
import { TokenTrendChart } from "./TokenTrendChart";
import { TokenCompositionPie } from "./TokenCompositionPie";
import { TokenRank } from "./TokenRank";
import { CodeRank } from "./CodeRank";
import { SessionSizeBar } from "./SessionSizeBar";
import { RecentSessionsTable } from "./RecentSessionsTable";

export function OverviewPage({
  users,
  dark,
  granularity,
  onSelectMember,
}: {
  users: UserAgg[];
  dark: boolean;
  granularity: Granularity;
  onSelectMember: (gitUser: string) => void;
}) {
  return (
    <div className="space-y-5">
      <KpiCards users={users} />

      <div className="grid grid-cols-12 gap-4">
        <TokenTrendChart users={users} dark={dark} granularity={granularity} />
        <TokenCompositionPie users={users} dark={dark} />
      </div>

      <div className="grid grid-cols-12 gap-4">
        <TokenRank users={users} onSelectMember={onSelectMember} />
        <CodeRank users={users} />
        <SessionSizeBar users={users} dark={dark} />
      </div>

      <RecentSessionsTable users={users} />
    </div>
  );
}
