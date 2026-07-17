// 代码产出排行(按成员):行数 + 对话次数 + 行/K Token。删组别行(tokenserver 无 team)。
import type { UserAgg } from "../../types";
import { rawTotal, lineTotal, fmtFull } from "../../lib/derive";
import { Avatar } from "../common/Avatar";

export function CodeRank({ users }: { users: UserAgg[] }) {
  const rank = users
    .map((u) => ({
      name: u.gitUser || "未知",
      code: lineTotal(u.totalLines),
      convs: u.sessionCount,
      token: rawTotal(u.totalTokens),
    }))
    .sort((a, b) => b.code - a.code);

  return (
    <div className="col-span-4 bg-card border border-border rounded p-4">
      <h3 className="text-sm font-semibold text-foreground mb-3">代码产出排行</h3>
      <div className="space-y-2">
        {rank.slice(0, 6).map((m, i) => (
          <div key={(m.name || "?") + i} className="flex items-center gap-2.5 py-1.5 border-b border-border last:border-0">
            <span className="text-xs text-muted-foreground w-4 text-right">{i + 1}</span>
            <Avatar name={m.name} />
            <div className="flex-1 min-w-0">
              <div className="flex items-center justify-between">
                <span className="text-xs font-medium text-foreground">{m.name}</span>
                <span className="text-xs font-mono text-teal-600 dark:text-teal-400">{fmtFull(m.code)} 行</span>
              </div>
              <div className="flex items-center justify-between mt-0.5">
                <span className="text-xs text-muted-foreground">{m.convs} 次对话</span>
                <span className="text-xs text-muted-foreground">{m.token > 0 ? Math.round(m.code / (m.token / 1000)) : 0} 行/K Token</span>
              </div>
            </div>
          </div>
        ))}
        {rank.length === 0 && <div className="text-xs text-muted-foreground py-4 text-center">暂无数据</div>}
      </div>
    </div>
  );
}
