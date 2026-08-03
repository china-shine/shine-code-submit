// 禅道工时表(4 列,纯明细,无合并/合计)。纯服务端分页:rows + total + page + pageSize + onPageChange。
// 列:日期 / 任务(#ID,可点跳禅道任务页) / 工时 / 工作内容。每条提交记录独立一行,不合并同名任务。
import type { WorklogRow } from "../../types";

/** 生成分页页码项:总页数 ≤ window 全显示;否则首尾 + 当前页附近窗口 + 省略号。(同 RecentSessionsTable,组件自包含) */
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

/** 工时格式化:整数显示 Nh,小数(0.5)显示 1 位小数。 */
function fmtHours(h: number): string {
  return `${Number.isInteger(h) ? h : h.toFixed(1)}h`;
}

export function WorklogTable({
  rows,
  total,
  page,
  pageSize,
  onPageChange,
}: {
  rows: WorklogRow[];
  total: number;
  page: number;
  pageSize: number;
  onPageChange: (n: number) => void;
}) {
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const cur = Math.min(page, totalPages);
  const items = pageItems(cur, totalPages, 10);

  const btn =
    "min-w-[28px] h-7 px-2 rounded border border-border text-foreground hover:bg-muted/50 disabled:opacity-40 disabled:cursor-not-allowed transition-colors font-mono text-xs";
  const btnActive = "bg-indigo-500 text-white border-indigo-500 hover:bg-indigo-500";

  return (
    <div className="bg-card border border-border rounded p-4">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-semibold text-foreground">禅道工时</h3>
        <span className="text-xs text-muted-foreground">共 {total} 条 · 每页 {pageSize}</span>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-xs table-fixed">
          <colgroup>
            <col className="w-[110px]" />
            <col className="w-[220px]" />
            <col className="w-[70px]" />
            <col />
          </colgroup>
          <thead>
            <tr className="border-b border-border">
              {["日期", "任务", "工时", "工作内容"].map((h) => (
                <th key={h} className="text-left py-2 pr-3 font-medium text-muted-foreground whitespace-nowrap">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={4} className="py-6 text-center text-muted-foreground">
                  暂无禅道工时记录
                </td>
              </tr>
            ) : (
              rows.map((r, i) => {
                const taskUrl =
                  r.taskId && r.zentaoUrl
                    ? `${r.zentaoUrl}/index.php?m=task&f=view&taskID=${r.taskId}`
                    : null;
                return (
                  <tr
                    key={`${r.sessionId}-${r.taskId ?? 0}-${i}`}
                    className="border-b border-border/50 hover:bg-muted/40 transition-colors align-top"
                  >
                    <td className="py-2.5 pr-3 font-mono text-muted-foreground whitespace-nowrap">{r.date}</td>
                    <td className="py-2.5 pr-3 text-foreground">
                      {taskUrl ? (
                        <a
                          href={taskUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-foreground hover:text-indigo-600 dark:hover:text-indigo-400 hover:underline"
                        >
                          {r.taskName || "(未命名)"}
                        </a>
                      ) : (
                        <span className="text-foreground">{r.taskName || "(未命名)"}</span>
                      )}
                      {r.taskId ? <span className="text-muted-foreground font-mono ml-1">#{r.taskId}</span> : null}
                    </td>
                    <td className="py-2.5 pr-3 font-mono text-violet-600 dark:text-violet-400 whitespace-nowrap">
                      {fmtHours(r.hours)}
                    </td>
                    <td className="py-2.5 pr-3 text-foreground whitespace-pre-line break-all" title={r.work ?? ""}>
                      {r.work || "—"}
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
      {total > 0 && (
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
