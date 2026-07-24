// 会话表(9 列)。纯服务端分页:rows + total + page + pageSize + onPageChange(翻页查 DB)。
// 列:最后活跃/成员/标题/项目/输入/输出/总Token/时长/代码变更。
import type { SessionRowOut } from "../../types";
import { fmtK, fmtDuration, displayProjectName } from "../../lib/derive";
import { fmtDateFull } from "../../lib/util";
import { Avatar } from "../common/Avatar";

interface NormRow {
  sessionId: string;
  lastActive: number;
  gitUser: string;
  title: string | null;
  projectName: string;
  input: number;
  output: number;
  tokenTotal: number;
  activeMs: number;
  lines: { added: number; deleted: number; modified: number };
}

/** 生成分页页码项:总页数 ≤ window 全显示;否则首尾 + 当前页附近窗口 + 省略号。 */
function pageItems(cur: number, total: number, window = 10): (number | "...")[] {
  if (total <= window) return Array.from({ length: total }, (_, i) => i + 1);
  const half = Math.floor(window / 2);
  let start = Math.max(1, cur - half);
  let end = Math.min(total, start + window - 1);
  start = Math.max(1, end - window + 1);
  const items: (number | "...")[] = [];
  if (start > 1) {
    items.push(1);
    if (start > 2) items.push("...");
  }
  for (let i = start; i <= end; i++) items.push(i);
  if (end < total) {
    if (end < total - 1) items.push("...");
    items.push(total);
  }
  return items;
}

export function RecentSessionsTable({
  rows,
  total,
  page,
  pageSize,
  onPageChange,
}: {
  rows: SessionRowOut[];
  total: number;
  page: number;
  pageSize: number;
  onPageChange: (n: number) => void;
}) {
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const cur = Math.min(page, totalPages);
  const items = pageItems(cur, totalPages, 10);

  const norm: NormRow[] = rows.map((r) => ({
    sessionId: r.sessionId,
    lastActive: r.lastActive,
    gitUser: r.gitUser,
    title: r.title,
    projectName: displayProjectName(r.name, r.cwd),
    input: r.input,
    output: r.output,
    tokenTotal: r.input + r.output + r.cacheCreation + r.cacheRead,
    activeMs: r.activeMs,
    lines: { added: r.added, deleted: r.deleted, modified: r.modified },
  }));

  const btn =
    "min-w-[28px] h-7 px-2 rounded border border-border text-foreground hover:bg-muted/50 disabled:opacity-40 disabled:cursor-not-allowed transition-colors font-mono text-xs";
  const btnActive = "bg-indigo-500 text-white border-indigo-500 hover:bg-indigo-500";

  return (
    <div className="bg-card border border-border rounded p-4">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-semibold text-foreground">最近会话</h3>
        <span className="text-xs text-muted-foreground">共 {total} 条 · 每页 {pageSize}</span>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-xs table-fixed">
          <colgroup>
            <col className="w-[150px]" />
            <col className="w-[120px]" />
            <col className="w-[260px]" />
            <col className="w-[200px]" />
            <col className="w-[70px]" />
            <col className="w-[70px]" />
            <col className="w-[85px]" />
            <col className="w-[85px]" />
            <col className="w-[110px]" />
          </colgroup>
          <thead>
            <tr className="border-b border-border">
              {["最后活跃", "成员", "标题", "项目", "输入", "输出", "总 Token", "时长", "代码变动"].map((h) => (
                <th key={h} className={`text-left py-2 pr-3 font-medium text-muted-foreground whitespace-nowrap${h === "标题" ? " w-[260px]" : ""}`}>
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {norm.length === 0 ? (
              <tr>
                <td colSpan={9} className="py-6 text-center text-muted-foreground">
                  暂无会话数据
                </td>
              </tr>
            ) : (
              norm.map((s) => (
                <tr key={s.sessionId} className="border-b border-border/50 hover:bg-muted/40 transition-colors">
                  <td className="py-2.5 pr-3 font-mono text-muted-foreground whitespace-nowrap">{fmtDateFull(s.lastActive)}</td>
                  <td className="py-2.5 pr-3">
                    <div className="flex items-center gap-1.5">
                      <Avatar name={s.gitUser || "?"} size="sm" />
                      <span className="font-medium text-foreground">{s.gitUser || "未知"}</span>
                    </div>
                  </td>
                  <td className="py-2.5 pr-3 text-foreground w-[260px] max-w-[260px] truncate" title={s.sessionId}>
                    {s.title || s.sessionId.slice(0, 8)}
                  </td>
                  <td className="py-2.5 pr-3 font-mono text-foreground truncate" title={s.projectName}>{s.projectName}</td>
                  <td className="py-2.5 pr-3 font-mono text-blue-600 dark:text-blue-400">{fmtK(s.input)}</td>
                  <td className="py-2.5 pr-3 font-mono text-violet-600 dark:text-violet-400">{fmtK(s.output)}</td>
                  <td className="py-2.5 pr-3 font-mono font-medium text-foreground">{fmtK(s.tokenTotal)}</td>
                  <td className="py-2.5 pr-3 font-mono text-orange-600 dark:text-orange-400 whitespace-nowrap">{fmtDuration(s.activeMs)}</td>
                  <td className="py-2.5 pr-3 font-mono text-teal-600 dark:text-teal-400 whitespace-nowrap">
                    {`+${s.lines.added} -${s.lines.deleted} M${s.lines.modified}`}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
      {totalPages > 1 && (
        <div className="flex items-center justify-center gap-4 mt-3 text-xs text-muted-foreground">
          <button disabled={cur <= 1} onClick={() => onPageChange(Math.max(1, cur - 1))} className={btn} aria-label="上一页">
            ‹
          </button>
          <div className="flex items-center gap-1">
            {items.map((it, i) =>
              it === "..." ? (
                <span key={`e${i}`} className="px-1 text-muted-foreground">
                  …
                </span>
              ) : (
                <button key={it} onClick={() => onPageChange(it)} className={cur === it ? `${btn} ${btnActive}` : btn}>
                  {it}
                </button>
              ),
            )}
          </div>
          <button disabled={cur >= totalPages} onClick={() => onPageChange(Math.min(totalPages, cur + 1))} className={btn} aria-label="下一页">
            ›
          </button>
        </div>
      )}
    </div>
  );
}
