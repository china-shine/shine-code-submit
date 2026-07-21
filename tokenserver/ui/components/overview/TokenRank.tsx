// Token 消耗排行:成员/项目两 tab。数据 = stats.tokenRank(后端聚合,isRealProject 过滤已在后端)。
// 成员项可点击 → onSelectMember 跳转成员详情。进度条宽度相对榜首。
import { useState } from "react";
import { Cpu } from "lucide-react";
import { fmtK, displayProjectName } from "../../lib/derive";
import { Avatar } from "../common/Avatar";

export function TokenRank({
  tokenRank,
  onSelectMember,
}: {
  tokenRank: {
    member: Array<{ gitUser: string; token: number }>;
    project: Array<{ cwd: string; name: string; token: number }>;
  };
  onSelectMember?: (gitUser: string) => void;
}) {
  const [rankBy, setRankBy] = useState<"member" | "project">("member");

  const memberRank = tokenRank.member.map((m) => ({ name: m.gitUser || "未知", gitUser: m.gitUser, token: m.token }));
  const projectRank = tokenRank.project.map((p) => ({ name: displayProjectName(p.name, p.cwd), token: p.token }));
  const list = rankBy === "member" ? memberRank : projectRank;
  const max = list[0]?.token || 1;

  return (
    <div className="col-span-4 bg-card border border-border rounded p-4">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-semibold text-foreground">Token 消耗排行</h3>
        <div className="flex items-center gap-1 bg-muted rounded-sm p-0.5">
          {(["member", "project"] as const).map((k) => (
            <button
              key={k}
              onClick={() => setRankBy(k)}
              className={`px-2 py-0.5 rounded-md text-xs font-medium transition-colors ${
                rankBy === k ? "bg-card shadow-sm text-foreground" : "text-muted-foreground hover:text-foreground"
              }`}
            >
              {{ member: "成员", project: "项目" }[k]}
            </button>
          ))}
        </div>
      </div>
      <div className="space-y-2.5">
        {list.slice(0, 6).map((m, i) => {
          const pct = max > 0 ? (m.token / max) * 100 : 0;
          return (
            <div
              key={(m.name || "?") + i}
              className={`flex items-center gap-2.5 ${rankBy === "member" && onSelectMember ? "cursor-pointer hover:bg-muted/40 -mx-1 px-1 rounded" : ""}`}
              onClick={() => {
                if (rankBy === "member" && onSelectMember) onSelectMember((m as { gitUser?: string }).gitUser ?? m.name);
              }}
            >
              <span className="text-xs text-muted-foreground w-4 text-right">{i + 1}</span>
              {rankBy === "member" ? (
                <Avatar name={m.name} />
              ) : (
                <div className="w-7 h-7 bg-indigo-50 dark:bg-indigo-900/30 rounded-sm flex items-center justify-center flex-shrink-0">
                  <Cpu className="w-3.5 h-3.5 text-indigo-600 dark:text-indigo-400" />
                </div>
              )}
              <div className="flex-1 min-w-0">
                <div className="flex items-center justify-between mb-0.5">
                  <span className={`text-xs font-medium text-foreground truncate ${rankBy === "project" ? "font-mono" : ""}`}>
                    {m.name}
                  </span>
                  <span className="text-xs font-mono text-foreground ml-2">{fmtK(m.token)}</span>
                </div>
                <div className="h-1.5 bg-muted rounded-full overflow-hidden">
                  <div
                    className={`h-full rounded-full ${
                      rankBy === "member" ? "bg-gradient-to-r from-indigo-500 to-violet-500" : "bg-gradient-to-r from-blue-500 to-indigo-500"
                    }`}
                    style={{ width: `${pct}%` }}
                  />
                </div>
              </div>
            </div>
          );
        })}
        {list.length === 0 && <div className="text-xs text-muted-foreground py-4 text-center">暂无数据</div>}
      </div>
    </div>
  );
}
