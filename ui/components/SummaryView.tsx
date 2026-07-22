import { useMemo } from "react";
import { useApi } from "../hooks/useApi";
import { useAllCommits } from "../hooks/useAllCommits";
import { useApp } from "../state/AppContext";
import { fmtDateTime, fmtUsage, fmtUsageFull, rawTotal, shortDir, sumTokenUsage } from "../lib/util";

/** 汇总视图（system 模块临时占位，Step 5 替换为 SystemModule）：
 *  Token 按会话 + 代码提交按时间。提交拉取改用 useAllCommits（与 Overview/Stats 共用）。 */
export function SummaryView() {
  const { sessions, token } = useApp();
  const api = useApi(token);

  const tokenRows = useMemo(
    () =>
      sessions
        .filter((s) => s.tokenTotal && rawTotal(s.tokenTotal) > 0)
        .slice()
        .sort((a, b) => b.lastActive - a.lastActive),
    [sessions],
  );
  const tokenSum = useMemo(() => sumTokenUsage(sessions.map((s) => s.tokenTotal)), [sessions]);
  const { commits, loading } = useAllCommits(api, sessions.map((s) => s.cwd), true);

  const commitCount = commits.length;
  const added = commits.reduce((n, c) => n + (c.added || 0), 0);
  const deleted = commits.reduce((n, c) => n + (c.deleted || 0), 0);
  const hasTokens = rawTotal(tokenSum.total) > 0;

  return (
    <div id="summary-view" className="summary-view">
      <section className="sum-section">
        <div className="sum-head">
          <h3>Token 消耗（按会话）</h3>
          <span className="sum-total" title={fmtUsageFull(tokenSum.total)}>
            总计 {hasTokens ? fmtUsage(tokenSum.total) : "—"}
          </span>
        </div>
        {tokenRows.length === 0 ? (
          <div className="sum-empty">暂无 token 数据（启动 Claude Code 会话后产生）</div>
        ) : (
          <ul className="sum-list sum-token-list">
            {tokenRows.map((s) => (
              <li key={s.sessionId} title={fmtUsageFull(s.tokenTotal)}>
                <span className="sum-ts">{fmtDateTime(s.lastActive)}</span>
                <span className="sum-cwd" title={s.cwd}>
                  {shortDir(s.cwd) || "?"}
                </span>
                <span className="sum-tok">{fmtUsage(s.tokenTotal)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="sum-section">
        <div className="sum-head">
          <h3>代码提交（按时间）</h3>
          <span className="sum-total">
            {commitCount} 次 · <span className="sum-add">+{added}</span> /{" "}
            <span className="sum-del">-{deleted}</span>
          </span>
        </div>
        {loading ? (
          <div className="sum-empty">拉取各项目提交…</div>
        ) : commits.length === 0 ? (
          <div className="sum-empty">暂无提交</div>
        ) : (
          <ul className="sum-list sum-commit-list">
            {commits.map((c) => (
              <li key={`${c.cwd}:${c.hash}`} title={c.cwd}>
                <span className="sum-ts">{fmtDateTime(c.time)}</span>
                <span className="sum-add">+{c.added}</span>
                <span className="sum-del">-{c.deleted}</span>
                <span className="sum-cwd">{shortDir(c.cwd)}</span>
                <span className="sum-subject">{c.subject || "(无说明)"}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
