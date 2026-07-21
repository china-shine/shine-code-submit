// 数据总览:6 KPI(含 sparkline) + (趋势|构成饼图) + (Token排行|代码排行|会话规模分布) + 最近会话表。
// 数据 = stats(全局聚合,后端 SQL)+ sessionsPage(分页),不再吃全量 users。granularity 透传给趋势图。
import type { StatsPayload, SessionsPage } from "../../types";
import type { Granularity } from "../shell/TopBar";
import { KpiCards } from "./KpiCards";
import { TokenTrendChart } from "./TokenTrendChart";
import { TokenCompositionPie } from "./TokenCompositionPie";
import { TokenRank } from "./TokenRank";
import { CodeRank } from "./CodeRank";
import { SessionSizeBar } from "./SessionSizeBar";
import { RecentSessionsTable } from "./RecentSessionsTable";

export function OverviewPage({
  stats,
  sessionsPage,
  pageNum,
  pageSize,
  onPageChange,
  dark,
  granularity,
  onSelectMember,
}: {
  stats: StatsPayload;
  sessionsPage: SessionsPage;
  pageNum: number;
  pageSize: number;
  onPageChange: (n: number) => void;
  dark: boolean;
  granularity: Granularity;
  onSelectMember: (gitUser: string) => void;
}) {
  return (
    <div className="space-y-5">
      <KpiCards stats={stats} />

      <div className="grid grid-cols-12 gap-4">
        <TokenTrendChart trend={stats.trend} dark={dark} granularity={granularity} />
        <TokenCompositionPie composition={stats.composition} dark={dark} />
      </div>

      <div className="grid grid-cols-12 gap-4">
        <TokenRank tokenRank={stats.tokenRank} onSelectMember={onSelectMember} />
        <CodeRank codeRank={stats.codeRank} />
        <SessionSizeBar sizeBuckets={stats.sizeBuckets} dark={dark} />
      </div>

      <RecentSessionsTable
        rows={sessionsPage.rows}
        total={sessionsPage.total}
        page={pageNum}
        pageSize={pageSize}
        onPageChange={onPageChange}
      />
    </div>
  );
}
