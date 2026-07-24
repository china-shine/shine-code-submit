// 成员列表表(9 列)。数据 = stats.members(MemberAgg[],realProjects/sessionCount/activeMs 已聚合,不再前端 flatten/countRealProjects)。
// 效率 = 行/M Token(代码行 / inout Token * 1e6)。整行点击或「详情」按钮进详情。
import { Eye } from "lucide-react";
import type { MemberAgg } from "../../types";
import { rawTotal, lineTotal, inoutTokens, fmtK, fmtFull, fmtDuration } from "../../lib/derive";
import { fmtDate } from "../../lib/util";
import { Avatar } from "../common/Avatar";

export function MemberListPage({
  members,
  onSelect,
}: {
  members: MemberAgg[];
  onSelect: (gitUser: string) => void;
}) {
  return (
    <div className="bg-card border border-border rounded overflow-hidden">
      <table className="w-full text-xs">
        <thead className="border-b border-border">
          <tr>
            {["成员", "最后同步", "活跃项目", "对话次数", "对话时长", "总 Token", "代码变动行数", "效率 (行/M)", "操作"].map((h) => (
              <th key={h} className="text-left py-3 px-4 font-medium text-muted-foreground whitespace-nowrap">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {members.length === 0 ? (
            <tr>
              <td colSpan={9} className="py-6 text-center text-muted-foreground">
                暂无成员数据
              </td>
            </tr>
          ) : (
            members.map((u) => {
              const lines = lineTotal(u.totalLines);
              const token = rawTotal(u.totalTokens);
              const inout = inoutTokens(u.totalTokens);
              const eff = inout > 0 ? Math.round((lines / inout) * 1_000_000) : 0;
              return (
                <tr
                  key={u.gitUser || "?"}
                  className="border-b border-border/50 hover:bg-muted/40 transition-colors cursor-pointer"
                  onClick={() => onSelect(u.gitUser)}
                >
                  <td className="py-3 px-4">
                    <div className="flex items-center gap-2.5">
                      <Avatar name={u.gitUser || "?"} />
                      <span className="font-medium text-foreground">{u.gitUser || "未知"}</span>
                    </div>
                  </td>
                  <td className="py-3 px-4 font-mono text-muted-foreground whitespace-nowrap">{fmtDate(u.lastActive)}</td>
                  <td className="py-3 px-4 font-mono text-foreground text-center">{u.realProjects}</td>
                  <td className="py-3 px-4 font-mono text-indigo-600 dark:text-indigo-400">{u.sessionCount}</td>
                  <td className="py-3 px-4 font-mono text-orange-600 dark:text-orange-400 whitespace-nowrap">{fmtDuration(u.activeMs)}</td>
                  <td className="py-3 px-4 font-mono font-medium text-foreground">{fmtK(token)}</td>
                  <td className="py-3 px-4 font-mono text-teal-600 dark:text-teal-400">{fmtFull(lines)}</td>
                  <td className="py-3 px-4 font-mono text-muted-foreground">{eff}</td>
                  <td className="py-3 px-4">
                    <button
                      className="flex items-center gap-1 text-primary hover:underline font-medium"
                      onClick={(e) => {
                        e.stopPropagation();
                        onSelect(u.gitUser);
                      }}
                    >
                      <Eye className="w-3 h-3" /> 详情
                    </button>
                  </td>
                </tr>
              );
            })
          )}
        </tbody>
      </table>
    </div>
  );
}
