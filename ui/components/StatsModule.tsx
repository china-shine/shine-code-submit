import { useMemo, useState } from "react";
import { useApi } from "../hooks/useApi";
import { useAllCommits } from "../hooks/useAllCommits";
import { useApp } from "../state/AppContext";
import { aggregateCommitsByProject, aggregateTokenByProject, bucketByDay } from "../lib/aggregate";
import { fmtUsage, shortDir } from "../lib/util";

type StatTab = "token" | "commits" | "day";

/** 统计模块：tab 切换三个维度，每个 tab 单条形列表全宽显示（空间更大）。 */
export function StatsModule() {
  const { token, sessions } = useApp();
  const api = useApi(token);
  const { commits } = useAllCommits(api, sessions, true);
  const [tab, setTab] = useState<StatTab>("token");

  const projTokens = useMemo(() => aggregateTokenByProject(sessions), [sessions]);
  const projCommits = useMemo(() => aggregateCommitsByProject(commits), [commits]);
  const commitsByDay = useMemo(() => bucketByDay(commits.map((c) => c.time), 7), [commits]);

  const maxToken = Math.max(1, ...projTokens.map((r) => r.token.input + r.token.output));
  const maxCommitCount = Math.max(1, ...projCommits.map((r) => r.count));
  const maxDayCount = Math.max(1, ...commitsByDay.map((b) => b.count));

  return (
    <div className="stats-view">
      <div className="toolbar">
        <div className="tabs">
          <button
            type="button"
            className={`tab${tab === "token" ? " active" : ""}`}
            onClick={() => setTab("token")}
          >
            Token 按项目
          </button>
          <button
            type="button"
            className={`tab${tab === "commits" ? " active" : ""}`}
            onClick={() => setTab("commits")}
          >
            提交按项目
          </button>
          <button
            type="button"
            className={`tab${tab === "day" ? " active" : ""}`}
            onClick={() => setTab("day")}
          >
            提交按天
          </button>
        </div>
      </div>
      <div className="stats-body">
        {tab === "token" && (
          <section className="sum-section">
            <div className="sum-head">
              <h3>Token 按项目</h3>
            </div>
            {projTokens.length === 0 ? (
              <div className="sum-empty">暂无 token 数据</div>
            ) : (
              <div className="bar-list">
                {projTokens.map((r) => {
                  const v = r.token.input + r.token.output;
                  return (
                    <div className="bar-row" key={r.cwd}>
                      <span className="bar-label" title={r.cwd}>
                        {shortDir(r.cwd) || "?"}
                      </span>
                      <div className="bar-track">
                        <div className="bar-fill tok" style={{ width: `${(v / maxToken) * 100}%` }} />
                      </div>
                      <span className="bar-val">{fmtUsage(r.token)}</span>
                    </div>
                  );
                })}
              </div>
            )}
          </section>
        )}
        {tab === "commits" && (
          <section className="sum-section">
            <div className="sum-head">
              <h3>提交次数按项目</h3>
            </div>
            {projCommits.length === 0 ? (
              <div className="sum-empty">暂无提交</div>
            ) : (
              <div className="bar-list">
                {projCommits.map((r) => (
                  <div className="bar-row" key={r.cwd}>
                    <span className="bar-label" title={r.cwd}>
                      {shortDir(r.cwd) || "?"}
                    </span>
                    <div className="bar-track">
                      <div
                        className="bar-fill commit"
                        style={{ width: `${(r.count / maxCommitCount) * 100}%` }}
                      />
                    </div>
                    <span className="bar-val">
                      {r.count} 次 · +{r.added}/-{r.deleted}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </section>
        )}
        {tab === "day" && (
          <section className="sum-section">
            <div className="sum-head">
              <h3>提交按天（近 7 天）</h3>
            </div>
            <div className="bar-list day">
              {commitsByDay.map((b) => (
                <div className="bar-row" key={b.day}>
                  <span className="bar-label">{b.day}</span>
                  <div className="bar-track">
                    <div
                      className="bar-fill commit"
                      style={{ width: `${(b.count / maxDayCount) * 100}%` }}
                    />
                  </div>
                  <span className="bar-val">{b.count}</span>
                </div>
              ))}
            </div>
          </section>
        )}
      </div>
    </div>
  );
}
