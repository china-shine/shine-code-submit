// 三级内容:选中项目的 session 表格（与报表表格结构一致）。
// 列:# / Session / 时间 / 输入 token / 输出 token / 总数。隐藏 0 token 会话。
import type { ProjectAgg } from "../types";
import { fmtDate, fmtLabeled, fmtTokens, fmtTotal, rawTotal } from "../lib/util";

export function SessionTable({ project }: { project: ProjectAgg | null }) {
  if (!project) {
    return (
      <main className="main">
        <div className="empty">选左侧项目查看会话明细</div>
      </main>
    );
  }
  const rows = project.sessions.filter((s) => s.tokenTotal && rawTotal(s.tokenTotal) > 0);
  return (
    <main className="main">
      <div className="main-head">
        {project.gitRemote ? (
          <span className="rt-sum" title={project.gitRemote}>🔗 {project.gitRemote}</span>
        ) : (
          <span className="rt-sum" />
        )}
        <span className="rt-tok" title={fmtLabeled(project.totalTokens)}>
          {fmtLabeled(project.totalTokens)}
        </span>
      </div>
      <div className="table-wrap">
        {rows.length === 0 ? (
          <div className="empty">无有效会话(均已隐藏 0 token)</div>
        ) : (
          <table className="report-table">
            <thead>
              <tr>
                <th className="rt-idx">#</th>
                <th>Session</th>
                <th>时间</th>
                <th className="num">输入 token</th>
                <th className="num">输出 token</th>
                <th className="num">总数</th>
                <th className="num">代码变更</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((s, i) => (
                <tr key={s.sessionId}>
                  <td className="rt-idx">{i + 1}</td>
                  <td className="sid" title={s.sessionId}>{s.sessionId.slice(0, 8)}</td>
                  <td>{fmtDate(s.lastActive)}</td>
                  <td className="num">{fmtTokens(s.tokenTotal!.input)}</td>
                  <td className="num">{fmtTokens(s.tokenTotal!.output)}</td>
                  <td className="num">{fmtTotal(s.tokenTotal)}</td>
                  <td className="num" title={s.linesTotal ? `+${s.linesTotal.added} -${s.linesTotal.deleted} M${s.linesTotal.modified}` : ""}>
                    {s.linesTotal ? `+${s.linesTotal.added} -${s.linesTotal.deleted} M${s.linesTotal.modified}` : "-"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </main>
  );
}
