// 成员分析路由:selected 为空显示列表,非空显示该成员详情。
import type { UserAgg } from "../../types";
import { MemberListPage } from "./MemberListPage";
import { MemberDetailPage } from "./MemberDetailPage";

export function MemberPage({
  users,
  dark,
  selected,
  setSelected,
}: {
  users: UserAgg[];
  dark: boolean;
  selected: string | null;
  setSelected: (g: string | null) => void;
}) {
  if (selected) {
    return <MemberDetailPage users={users} dark={dark} gitUser={selected} onBack={() => setSelected(null)} />;
  }
  return <MemberListPage users={users} onSelect={(g) => setSelected(g)} />;
}
