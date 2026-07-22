// 通用服务端分页表格 + 序号列 + 可点击行尾箭头(▸ 钻取提示)。
// L1 项目表 / L2 session 表共用(钻取导航)。fetchPage(page) 返回当前页 rows + total;复用 report-table/report-pager 样式。
// 可点击行(onRowClick):hover 高亮(report-table 自带) + cursor pointer + 行尾 ▸ 提示"点这进入下一级"。
import { useEffect, useRef, useState, type ReactNode } from "react";

export interface Column<T> {
  key: string;
  header: string;
  render: (row: T) => ReactNode;
  thClassName?: string;
  tdClassName?: string;
}

export function PagedTable<T>({
  columns,
  fetchPage,
  pageSize,
  rowKey,
  onRowClick,
  emptyText = "暂无数据",
  refreshKey = 0,
}: {
  columns: Column<T>[];
  fetchPage: (page: number) => Promise<{ rows: T[]; total: number }>;
  pageSize: number;
  rowKey: (row: T) => string;
  onRowClick?: (row: T) => void;
  emptyText?: string;
  refreshKey?: number;
}) {
  const [page, setPage] = useState(1);
  const [rows, setRows] = useState<T[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const fetchRef = useRef(fetchPage);
  fetchRef.current = fetchPage;

  useEffect(() => {
    let alive = true;
    setLoading(true);
    fetchRef
      .current(page)
      .then(({ rows, total }) => {
        if (!alive) return;
        setRows(rows);
        setTotal(total);
        setLoading(false);
      })
      .catch(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [page, refreshKey]);

  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const cur = Math.min(page, totalPages);
  const colCount = columns.length + 1 + (onRowClick ? 1 : 0); // +序号 +▸(可点击行)

  return (
    <div style={{ display: "flex", flexDirection: "column", flex: "1 1 0", minHeight: 0 }}>
      <div style={{ overflow: "auto", flex: "1 1 0", minHeight: 0 }}>
        <table className="report-table">
          <thead>
            <tr>
              <th className="rt-idx">#</th>
              {columns.map((c) => (
                <th key={c.key} className={c.thClassName}>
                  {c.header}
                </th>
              ))}
              {onRowClick && <th style={{ width: 28 }} />}
            </tr>
          </thead>
          <tbody>
            {loading
              ? Array.from({ length: 6 }).map((_, i) => (
                  <tr key={`sk${i}`}>
                    {Array.from({ length: colCount }).map((_, j) => (
                      <td key={j}>
                        <div
                          style={{
                            height: 10,
                            background: "var(--hover)",
                            borderRadius: 3,
                            width: j === 0 ? "40%" : "75%",
                          }}
                        />
                      </td>
                    ))}
                  </tr>
                ))
              : rows.length === 0
                ? (
                  <tr>
                    <td colSpan={colCount}>{emptyText}</td>
                  </tr>
                )
                : rows.map((r, idx) => (
                    <tr
                      key={rowKey(r)}
                      className={onRowClick ? "clickable" : undefined}
                      onClick={onRowClick ? () => onRowClick(r) : undefined}
                      style={onRowClick ? { cursor: "pointer" } : undefined}
                    >
                      <td className="rt-idx">{(page - 1) * pageSize + idx + 1}</td>
                      {columns.map((c) => (
                        <td key={c.key} className={c.tdClassName}>
                          {c.render(r)}
                        </td>
                      ))}
                      {onRowClick && (
                        <td style={{ color: "var(--muted)", textAlign: "center" }}>▸</td>
                      )}
                    </tr>
                  ))}
          </tbody>
        </table>
      </div>
      {totalPages > 1 && (
        <div className="report-pager">
          <button type="button" disabled={cur <= 1} onClick={() => setPage(cur - 1)}>
            ‹ 上一页
          </button>
          <span>
            第 {cur} / {totalPages} 页
          </span>
          <button type="button" disabled={cur >= totalPages} onClick={() => setPage(cur + 1)}>
            下一页 ›
          </button>
          <span style={{ marginLeft: "auto" }}>共 {total} 条</span>
        </div>
      )}
    </div>
  );
}
