// 成员分析路由:selected 为空显示列表(用 stats.members),非空显示该成员详情(详情自己 fetchMember,团队均值复用 stats.totals)。
import type { StatsPayload } from "../../types";
import type { Granularity, RangeKey } from "../shell/TopBar";
import { MemberListPage } from "./MemberListPage";
import { MemberDetailPage } from "./MemberDetailPage";

export function MemberPage({
  stats,
  dark,
  granularity,
  range,
  selected,
  setSelected,
}: {
  stats: StatsPayload;
  dark: boolean;
  granularity: Granularity;
  range: RangeKey;
  selected: string | null;
  setSelected: (g: string | null) => void;
}) {
  if (selected) {
    return (
      <MemberDetailPage
        dark={dark}
        gitUser={selected}
        granularity={granularity}
        range={range}
        teamStats={stats.totals}
        onBack={() => setSelected(null)}
      />
    );
  }
  return <MemberListPage members={stats.members} onSelect={(g) => setSelected(g)} />;
}
