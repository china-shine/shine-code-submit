// 纯函数派生层:从 ReportsResponse 现场聚合时序/分布/排行/过滤。
// 不依赖、不修改上报数据。所有时序/分布/过滤都从 SessionAgg.lastActive 现派生(合法聚合)。
// 注意:lastActive 是「最后活跃时间」非「创建时间」,长会话会算到最近一日(趋势图副标题已标注)。
import type { UserAgg, ProjectAgg, TokenUsage, LinesStat } from "../types";

// ─── 颜色 token(与 TokenWeb App.tsx 一致) ───────────────────────────────────────
export const C = {
  input: "#3B82F6",
  output: "#8B5CF6",
  cache: "#6366F1",
  code: "#14B8A6",
  dur: "#F97316",
  total: "#4F46E5",
};

// ─── 基础聚合 ──────────────────────────────────────────────────────────────────
export function rawTotal(u?: TokenUsage | null): number {
  if (!u) return 0;
  return u.input + u.output + u.cacheCreation + u.cacheRead;
}

export function sumTokens(list: (TokenUsage | null | undefined)[]): TokenUsage {
  return list.reduce(
    (a, t) => ({
      input: a.input + (t?.input ?? 0),
      output: a.output + (t?.output ?? 0),
      cacheCreation: a.cacheCreation + (t?.cacheCreation ?? 0),
      cacheRead: a.cacheRead + (t?.cacheRead ?? 0),
    }),
    { input: 0, output: 0, cacheCreation: 0, cacheRead: 0 }
  );
}

export function sumLines(list: (LinesStat | null | undefined)[]): LinesStat {
  return list.reduce(
    (a, l) => ({
      added: a.added + (l?.added ?? 0),
      deleted: a.deleted + (l?.deleted ?? 0),
      modified: a.modified + (l?.modified ?? 0),
    }),
    { added: 0, deleted: 0, modified: 0 }
  );
}

export function lineTotal(l?: LinesStat | null): number {
  if (!l) return 0;
  return l.added + l.deleted + l.modified;
}

// ─── 路径/项目名清洗(治标) ─────────────────────────────────────────────────────
// daemon 的 decodeProjectCwd 把 Claude project 目录名(- 编码)解码回 cwd,
// 但 Claude 对中文/特殊字符也编码成 '-',解码后出现连续 '\'。此处合并显示。
export function cleanCwd(cwd?: string | null): string {
  if (!cwd) return "";
  return cwd
    .replace(/[\\/]+/g, "\\") // 连续 \ 或 / 合并成单个 \
    .replace(/\\+$/, "") // 去末尾反斜杠
    .replace(/^([a-z]):/i, (_m, d) => d.toUpperCase() + ":"); // 盘符统一大写
}

/** cleanCwd 后的末 N 段,用 / 连接(跨平台安全)。 */
function pathTail(cwd: string | null | undefined, depth = 1): string {
  if (!cwd) return "";
  const segs = cleanCwd(cwd).split(/[\\/]+/).filter(Boolean);
  if (segs.length === 0) return "";
  return segs.slice(-depth).join("/");
}

/** 项目名可读化:纯数字/单字符名(如 test\2\5 → "5")回退到 cwd 末两段("2/5");其余原样。 */
export function displayProjectName(name?: string | null, cwd?: string | null): string {
  const base = (name && name.trim()) || pathTail(cwd, 1) || "(未知)";
  if (/^\d+$/.test(base) || base.length <= 1) {
    const two = pathTail(cwd, 2);
    if (two && two.length > 1) return two;
  }
  return base;
}

/** 判断 cwd 是否"真项目":排除盘根/用户家目录/桌面等显然不是项目的路径。
 *  规则:cleanCwd 后按段数判断 —— 1 段=盘根;X:\Users\<name>=家目录;
 *  X:\Users\<name>\{Desktop,Documents,Downloads}=家目录常用子目录。其余算项目。 */
export function isRealProject(cwd?: string | null): boolean {
  if (!cwd) return false;
  const segs = cleanCwd(cwd).split(/[\\/]+/).filter(Boolean);
  if (segs.length === 0) return false;
  if (segs.length === 1) return false; // 盘根 X:
  if (segs.length === 3 && segs[1].toLowerCase() === "users") return false; // 家目录
  if (
    segs.length === 4 &&
    segs[1].toLowerCase() === "users" &&
    ["desktop", "documents", "downloads"].includes(segs[3].toLowerCase())
  )
    return false; // 家目录下的桌面/文档/下载
  return true;
}

/** 该成员的"真项目"数(用于 KPI/列表/详情,替代后端给的 projectCount 全量数)。 */
export function countRealProjects(u: UserAgg): number {
  return u.projects.filter((p) => isRealProject(p.cwd)).length;
}

// ─── 格式化(复制 TokenWeb fmtK/fmtFull 以保视觉一致;fmtDate 沿用 util.ts) ─────────
export function fmtK(n: number): string {
  if (n >= 1_000_000_000) return (n / 1_000_000_000).toFixed(2) + "B"; // B 两位
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + "M"; // M 两位
  if (n >= 1_000) return (n / 1_000).toFixed(1) + "K"; // K 一位
  return n.toString();
}
export function fmtFull(n: number): string {
  return n.toLocaleString("zh-CN");
}

// ─── session 展平(带成员/项目上下文,供最近会话表/规模分布) ───────────────────────
export interface FlatSession {
  sessionId: string;
  lastActive: number;
  token: TokenUsage | null;
  lines: LinesStat | null;
  gitUser: string;
  projectName: string;
  cwd: string;
}

export function flattenSessions(users: UserAgg[]): FlatSession[] {
  const out: FlatSession[] = [];
  for (const u of users) {
    for (const p of u.projects) {
      for (const s of p.sessions) {
        out.push({
          sessionId: s.sessionId,
          lastActive: s.lastActive,
          token: s.tokenTotal,
          lines: s.linesTotal,
          gitUser: u.gitUser,
          projectName: displayProjectName(p.name, p.cwd),
          cwd: p.cwd,
        });
      }
    }
  }
  return out;
}

// ─── 按天聚合(趋势图;按 lastActive 当日归并) ─────────────────────────────────────
export interface DayBucket {
  date: string; // 标签(MM-DD 或 YYYY-MM)
  ts: number;
  input: number;
  output: number;
  cache: number;
  total: number;
}

function dayLabel(ts: number): { key: string; label: string } {
  const d = new Date(ts);
  const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const label = `${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  return { key, label };
}

function bucketTs(
  ts: number,
  g: "day" | "week" | "month"
): { key: string; label: string } {
  if (g === "day") return dayLabel(ts);
  const d = new Date(ts);
  if (g === "month") {
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    return { key, label: key };
  }
  // week: 自然周(周一起)
  const ws = new Date(d);
  ws.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  const key = `${ws.getFullYear()}-${String(ws.getMonth() + 1).padStart(2, "0")}-${String(ws.getDate()).padStart(2, "0")}`;
  const label = `${String(ws.getMonth() + 1).padStart(2, "0")}-${String(ws.getDate()).padStart(2, "0")}`;
  return { key, label };
}

export function bucketByDay(sessions: { lastActive: number; token: TokenUsage | null }[]): DayBucket[] {
  return bucketByGranularity(sessions, "day");
}

export function bucketByGranularity(
  sessions: { lastActive: number; token: TokenUsage | null }[],
  g: "day" | "week" | "month"
): DayBucket[] {
  const map = new Map<string, DayBucket>();
  for (const s of sessions) {
    const { key, label } = bucketTs(s.lastActive, g);
    const b = map.get(key) ?? { date: label, ts: s.lastActive, input: 0, output: 0, cache: 0, total: 0 };
    const t = s.token;
    b.input += t?.input ?? 0;
    b.output += t?.output ?? 0;
    b.cache += (t?.cacheCreation ?? 0) + (t?.cacheRead ?? 0);
    b.total += rawTotal(t);
    b.ts = s.lastActive;
    map.set(key, b);
  }
  return [...map.values()].sort((a, b) => a.ts - b.ts);
}

// ─── 按日多指标(供 KPI sparkline:total/sessions/lines 三序列) ─────────────────────
export interface DailyStat {
  date: string;
  ts: number;
  total: number;
  sessions: number;
  lines: number;
}

export function dailyStats(users: UserAgg[]): DailyStat[] {
  const map = new Map<string, DailyStat>();
  for (const s of flattenSessions(users)) {
    const { key, label } = dayLabel(s.lastActive);
    const b = map.get(key) ?? { date: label, ts: s.lastActive, total: 0, sessions: 0, lines: 0 };
    b.total += rawTotal(s.token);
    b.sessions += 1;
    b.lines += lineTotal(s.lines);
    b.ts = s.lastActive;
    map.set(key, b);
  }
  return [...map.values()].sort((a, b) => a.ts - b.ts);
}

// ─── 全局汇总 ──────────────────────────────────────────────────────────────────
export interface GlobalTotals {
  token: TokenUsage;
  rawTotal: number;
  lines: LinesStat;
  sessions: number;
  members: number;
  projects: number;
}

export function globalTotals(users: UserAgg[]): GlobalTotals {
  const token = sumTokens(users.map((u) => u.totalTokens));
  const lines = sumLines(users.map((u) => u.totalLines));
  return {
    token,
    rawTotal: rawTotal(token),
    lines,
    sessions: users.reduce((a, u) => a + u.sessionCount, 0),
    members: users.length,
    projects: users.reduce((a, u) => a + countRealProjects(u), 0),
  };
}

// ─── 时间范围过滤:只保留 lastActive>=from 的 session,并重算 user/project 聚合 ──────
// (上报的 totalTokens/totalLines 是全量快照,过滤后必须从 session 重算才准)
export function filterUsersByRange(users: UserAgg[], from: number): UserAgg[] {
  const out: UserAgg[] = [];
  for (const u of users) {
    const projects: ProjectAgg[] = [];
    for (const p of u.projects) {
      const sessions = p.sessions.filter((s) => s.lastActive >= from);
      if (sessions.length === 0) continue;
      projects.push({
        ...p,
        sessions,
        sessionCount: sessions.length,
        totalTokens: sumTokens(sessions.map((s) => s.tokenTotal)),
        totalLines: sumLines(sessions.map((s) => s.linesTotal)),
        lastActive: sessions.reduce((m, s) => Math.max(m, s.lastActive), 0),
      });
    }
    if (projects.length === 0) continue;
    out.push({
      ...u,
      projects,
      projectCount: projects.length,
      sessionCount: projects.reduce((a, p) => a + p.sessionCount, 0),
      totalTokens: sumTokens(projects.map((p) => p.totalTokens)),
      totalLines: sumLines(projects.map((p) => p.totalLines)),
      lastActive: projects.reduce((m, p) => Math.max(m, p.lastActive), 0),
    });
  }
  return out;
}

// ─── 时间范围(min/max lastActive,供顶栏徽章) ────────────────────────────────────
export function activeRange(users: UserAgg[]): { min: number; max: number } {
  let min = Infinity;
  let max = -Infinity;
  for (const u of users) {
    for (const p of u.projects) {
      for (const s of p.sessions) {
        if (s.lastActive < min) min = s.lastActive;
        if (s.lastActive > max) max = s.lastActive;
      }
    }
  }
  if (!isFinite(min)) return { min: 0, max: 0 };
  return { min, max };
}

// ─── 会话规模分布(替代时长分布:按 rawTotal 分桶;跳过 0 token 会话) ──────────────
export const SESSION_SIZE_BUCKETS = [
  { range: "0–10K", max: 10_000 },
  { range: "10–100K", max: 100_000 },
  { range: "100K–1M", max: 1_000_000 },
  { range: "1–10M", max: 10_000_000 },
  { range: ">10M", max: Infinity },
];

export function sessionSizeBuckets(users: UserAgg[]): { range: string; count: number }[] {
  const counts = SESSION_SIZE_BUCKETS.map((b) => ({ range: b.range, count: 0 }));
  for (const s of flattenSessions(users)) {
    const tot = rawTotal(s.token);
    if (tot <= 0) continue;
    for (let i = 0; i < SESSION_SIZE_BUCKETS.length; i++) {
      if (tot <= SESSION_SIZE_BUCKETS[i].max) {
        counts[i].count++;
        break;
      }
    }
  }
  return counts;
}
