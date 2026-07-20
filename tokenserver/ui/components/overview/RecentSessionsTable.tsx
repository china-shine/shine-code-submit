// 最近会话表(9 列):flatten 全部 session,按 lastActive desc 取前 20,跳过 0 token。
// 列:最后活跃/成员/标题/项目/输入/输出/总Token/时长/代码变更。(删「路径」列:项目名已在「项目」列,完整 cwd 冗余占宽)
import type { UserAgg } from "../../types";
import { flattenSessions, rawTotal, fmtK, fmtDuration } from "../../lib/derive";
import { fmtDate } from "../../lib/util";
import { Avatar } from "../common/Avatar";

export function RecentSessionsTable({ users }: { users: UserAgg[] }) {
  const rows = flattenSessions(users)
    .filter((s) => rawTotal(s.token) > 0)
    .sort((a, b) => b.lastActive - a.lastActive)
    .slice(0, 20);

  return (
    <div className="bg-card border border-border rounded p-4">
      <h3 className="text-sm font-semibold text-foreground mb-3">最近会话</h3>
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b border-border">
              {["最后活跃", "成员", "标题", "项目", "输入", "输出", "总 Token", "时长", "代码变更"].map((h) => (
                <th key={h} className="text-left py-2 pr-3 font-medium text-muted-foreground whitespace-nowrap">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={9} className="py-6 text-center text-muted-foreground">
                  暂无会话数据
                </td>
              </tr>
            ) : (
              rows.map((s) => (
                <tr key={s.sessionId} className="border-b border-border/50 hover:bg-muted/40 transition-colors">
                  <td className="py-2.5 pr-3 font-mono text-muted-foreground whitespace-nowrap">{fmtDate(s.lastActive)}</td>
                  <td className="py-2.5 pr-3">
                    <div className="flex items-center gap-1.5">
                      <Avatar name={s.gitUser || "?"} size="sm" />
                      <span className="font-medium text-foreground">{s.gitUser || "未知"}</span>
                    </div>
                  </td>
                  <td className="py-2.5 pr-3 text-foreground max-w-[260px] truncate" title={s.sessionId}>
                    {s.title || s.sessionId.slice(0, 8)}
                  </td>
                  <td className="py-2.5 pr-3 font-mono text-foreground">{s.projectName}</td>
                  <td className="py-2.5 pr-3 font-mono text-blue-600 dark:text-blue-400">{fmtK(s.token?.input ?? 0)}</td>
                  <td className="py-2.5 pr-3 font-mono text-violet-600 dark:text-violet-400">{fmtK(s.token?.output ?? 0)}</td>
                  <td className="py-2.5 pr-3 font-mono font-medium text-foreground">{fmtK(rawTotal(s.token))}</td>
                  <td className="py-2.5 pr-3 font-mono text-orange-600 dark:text-orange-400 whitespace-nowrap">{fmtDuration(s.activeMs ?? 0)}</td>
                  <td className="py-2.5 pr-3 font-mono text-teal-600 dark:text-teal-400 whitespace-nowrap">
                    {s.lines ? `+${s.lines.added} -${s.lines.deleted} M${s.lines.modified}` : "—"}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
