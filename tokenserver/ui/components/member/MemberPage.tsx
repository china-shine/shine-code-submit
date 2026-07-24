// 成员分析路由:selected 为空显示列表(用 stats.members),非空显示该成员详情(详情自己 fetchMember,团队均值复用 stats.totals)。
import type { StatsPayload } from "../../types";
import { MemberListPage } from "./MemberListPage";
import { MemberDetailPage } from "./MemberDetailPage";

export function MemberPage({
  stats,
  dark,
  startDate,
  endDate,
  selected,
  setSelected,
}: {
  stats: StatsPayload;
  dark: boolean;
  startDate: string;
  endDate: string;
  selected: string | null;
  setSelected: (g: string | null) => void;
}) {
  if (selected) {
    return (
      <MemberDetailPage
        dark={dark}
        gitUser={selected}
        startDate={startDate}
        endDate={endDate}
        teamStats={stats.totals}
        onBack={() => setSelected(null)}
      />
    );
  }
  return <MemberListPage members={stats.members} onSelect={(g) => setSelected(g)} />;
}
