// 纯聚合函数（统计模块用）：按项目/按天分组，无副作用。
import type { SessionSummary, TokenUsage } from "../types";

export interface ProjTokenRow {
  cwd: string;
  token: TokenUsage;
  sessionCount: number;
}

/** 按项目聚合 token：group by cwd，累加 tokenTotal + 会话数，按 token 总量倒序。 */
export function aggregateTokenByProject(sessions: SessionSummary[]): ProjTokenRow[] {
  const m = new Map<string, ProjTokenRow>();
  for (const s of sessions) {
    const r =
      m.get(s.cwd) ??
      {
        cwd: s.cwd,
        token: { input: 0, output: 0, cacheCreation: 0, cacheRead: 0 },
        sessionCount: 0,
      };
    r.sessionCount++;
    if (s.tokenTotal) {
      r.token.input += s.tokenTotal.input;
      r.token.output += s.tokenTotal.output;
      r.token.cacheCreation += s.tokenTotal.cacheCreation;
      r.token.cacheRead += s.tokenTotal.cacheRead;
    }
    m.set(s.cwd, r);
  }
  return [...m.values()].sort(
    (a, b) => b.token.input + b.token.output - (a.token.input + a.token.output),
  );
}

export interface ProjCommitRow {
  cwd: string;
  count: number;
  added: number;
  deleted: number;
}

/** 按项目聚合提交：group by cwd，统计次数/新增/删除，按次数倒序。 */
export function aggregateCommitsByProject(commits: Array<{ cwd: string; added: number; deleted: number }>): ProjCommitRow[] {
  const m = new Map<string, ProjCommitRow>();
  for (const c of commits) {
    const r = m.get(c.cwd) ?? { cwd: c.cwd, count: 0, added: 0, deleted: 0 };
    r.count++;
    r.added += c.added;
    r.deleted += c.deleted;
    m.set(c.cwd, r);
  }
  return [...m.values()].sort((a, b) => b.count - a.count);
}

export interface DayBucket {
  day: string; // MM-DD
  count: number;
}

function fmtDay(ts: number): string {
  const d = new Date(ts);
  return `${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** 按天分桶（近 days 天，含今天），统计每桶 count。非近 days 内的时间忽略。 */
export function bucketByDay(times: number[], days = 7): DayBucket[] {
  const buckets: DayBucket[] = [];
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    buckets.push({ day: fmtDay(d.getTime()), count: 0 });
  }
  const map = new Map(buckets.map((b) => [b.day, b]));
  for (const t of times) {
    const b = map.get(fmtDay(t));
    if (b) b.count++;
  }
  return buckets;
}
