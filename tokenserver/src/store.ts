// 规范化存储:projects + sessions 两表,upsert 去重(行数稳定)。
// DATA_DIR 双模式:开发(bun run src)= tokenserver/data;编译(二进制)= 二进制旁 data/。
// (Bun 编译后 import.meta.dir 固化为编译机路径,Linux 上不存在,故编译模式用 process.execPath)
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type { LinesStat, ReportResponse, TokenUsage } from "./types";

function resolveDataDir(): string {
  if (process.env.TOKENSERVER_DATA_DIR) return process.env.TOKENSERVER_DATA_DIR;
  // 开发模式:tokenserver/data(import.meta.dir = src,旁有 package.json)
  if (existsSync(join(import.meta.dir, "..", "package.json"))) {
    return join(import.meta.dir, "..", "data");
  }
  // 编译模式:二进制旁 data/
  return join(dirname(process.execPath), "data");
}

const DATA_DIR = resolveDataDir();
mkdirSync(DATA_DIR, { recursive: true });
const db = new Database(join(DATA_DIR, "tokens.db"));
db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS projects (
    gitUser TEXT NOT NULL,
    cwd TEXT NOT NULL,
    name TEXT,
    gitRemote TEXT,
    lastActive INTEGER DEFAULT 0,
    updatedAt INTEGER DEFAULT 0,
    PRIMARY KEY (gitUser, cwd)
  );
  CREATE TABLE IF NOT EXISTS sessions (
    sessionId TEXT PRIMARY KEY,
    gitUser TEXT NOT NULL,
    cwd TEXT NOT NULL,
    lastActive INTEGER DEFAULT 0,
    input INTEGER DEFAULT 0,
    output INTEGER DEFAULT 0,
    cacheCreation INTEGER DEFAULT 0,
    cacheRead INTEGER DEFAULT 0,
    added INTEGER DEFAULT 0,
    deleted INTEGER DEFAULT 0,
    modified INTEGER DEFAULT 0,
    activeMs INTEGER DEFAULT 0,
    title TEXT,
    updatedAt INTEGER DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_sessions_user_cwd ON sessions(gitUser, cwd);
  CREATE INDEX IF NOT EXISTS idx_projects_gitUser ON projects(gitUser);
`);

// 旧库迁移:sessions 加 added/deleted/modified 列(无迁移机制,PRAGMA 检查 + ADD COLUMN)
{
  const cols = db.prepare("PRAGMA table_info(sessions)").all() as Array<{ name: string }>;
  const have = new Set(cols.map((c) => c.name));
  for (const c of ["added", "deleted", "modified"]) {
    if (!have.has(c)) db.exec(`ALTER TABLE sessions ADD COLUMN ${c} INTEGER DEFAULT 0`);
  }
  if (!have.has("title")) db.exec(`ALTER TABLE sessions ADD COLUMN title TEXT`);
  if (!have.has("activeMs")) db.exec(`ALTER TABLE sessions ADD COLUMN activeMs INTEGER DEFAULT 0`);
}

const ZERO: TokenUsage = { input: 0, output: 0, cacheCreation: 0, cacheRead: 0 };
const ZERO_LINES: LinesStat = { added: 0, deleted: 0, modified: 0 };
interface SessionRow {
  sessionId: string;
  gitUser: string;
  cwd: string;
  lastActive: number;
  input: number;
  output: number;
  cacheCreation: number;
  cacheRead: number;
  added: number;
  deleted: number;
  modified: number;
  activeMs: number;
  title: string | null;
}

const upsertProject = db.query(`
  INSERT INTO projects (gitUser, cwd, name, gitRemote, lastActive, updatedAt)
  VALUES (?, ?, ?, ?, ?, ?)
  ON CONFLICT(gitUser, cwd) DO UPDATE SET
    name = excluded.name,
    gitRemote = excluded.gitRemote,
    lastActive = MAX(projects.lastActive, excluded.lastActive),
    updatedAt = excluded.updatedAt
`);
const upsertSession = db.query(`
  INSERT INTO sessions (sessionId, gitUser, cwd, lastActive, input, output, cacheCreation, cacheRead, added, deleted, modified, activeMs, title, updatedAt)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(sessionId) DO UPDATE SET
    gitUser = excluded.gitUser,
    cwd = excluded.cwd,
    lastActive = excluded.lastActive,
    input = excluded.input,
    output = excluded.output,
    cacheCreation = excluded.cacheCreation,
    cacheRead = excluded.cacheRead,
    added = excluded.added,
    deleted = excluded.deleted,
    modified = excluded.modified,
    activeMs = excluded.activeMs,
    title = excluded.title,
    updatedAt = excluded.updatedAt
  WHERE excluded.lastActive >= sessions.lastActive OR excluded.cwd IS NOT sessions.cwd
`);

/** 存储一次上报:拆分逐条 upsert。 */
export function saveReport(raw: ReportResponse): void {
  const gitUser =
    raw.gitUser ?? raw.projects.find((p) => p.gitUser)?.gitUser ?? "未知用户";
  const now = Date.now();
  const tx = db.transaction(() => {
    for (const p of raw.projects ?? []) {
      const projLastActive = (p.sessions ?? []).reduce(
        (m, s) => Math.max(m, s.lastActive),
        0,
      );
      upsertProject.run(gitUser, p.cwd, p.name ?? null, p.gitRemote ?? null, projLastActive, now);
      for (const s of p.sessions ?? []) {
        const t = s.tokenTotal ?? ZERO;
        const l = s.linesTotal ?? ZERO_LINES;
        upsertSession.run(
          s.sessionId, gitUser, p.cwd, s.lastActive,
          t.input, t.output, t.cacheCreation, t.cacheRead,
          l.added, l.deleted, l.modified, s.activeMs ?? 0, s.title ?? null, now,
        );
      }
    }
  });
  tx();
}

// (旧的三级聚合 aggregate()/cachedUsers 已移除:前端不再拉 /api/reports 全量,
//  overview/member 全部走服务端 /api/stats + /api/member + /api/sessions。)

// ====================================================================
// 服务端聚合/分页(阶段1:overview 服务端化)。复刻 ui/lib/derive.ts 口径。
// isRealProjectCwd 仅用于 tokenRank 项目榜 + projects 计数;其余聚合用全部 session(对齐 flattenSessions/globalTotals)。
// 展示清洗(displayProjectName/cleanCwd)前端保留,后端返 cwd+name 原值。
// ====================================================================

export type Granularity = "day" | "week" | "month";

const SIZE_BUCKETS = [
  { range: "0–10K", max: 10_000 },
  { range: "10–100K", max: 100_000 },
  { range: "100K–1M", max: 1_000_000 },
  { range: "1–10M", max: 10_000_000 },
  { range: ">10M", max: Infinity },
];

/** 等价 derive.ts isRealProject:排除盘根/家目录/桌面(只看 cleanCwd 后段数)。*/
function isRealProjectCwd(cwd: string | null | undefined): boolean {
  if (!cwd) return false;
  const segs = cwd.replace(/[\\/]+/g, "/").replace(/\/+$/, "").split("/").filter(Boolean);
  if (segs.length <= 1) return false;
  if (segs.length === 3 && segs[1].toLowerCase() === "users") return false;
  if (
    segs.length === 4 &&
    segs[1].toLowerCase() === "users" &&
    ["desktop", "documents", "downloads"].includes(segs[3].toLowerCase())
  )
    return false;
  return true;
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/** 等价 derive.ts bucketTs:day / week(周一起)/ month 桶。*/
function bucketOf(ts: number, g: Granularity): { key: string; label: string } {
  const d = new Date(ts);
  if (g === "month") {
    const key = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}`;
    return { key, label: key };
  }
  if (g === "day") {
    return {
      key: `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`,
      label: `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`,
    };
  }
  // week:自然周(周一起)
  const ws = new Date(d);
  ws.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return {
    key: `${ws.getFullYear()}-${pad2(ws.getMonth() + 1)}-${pad2(ws.getDate())}`,
    label: `${pad2(ws.getMonth() + 1)}-${pad2(ws.getDate())}`,
  };
}

interface FilterOpts {
  from: number;
  to: number;
  members: string[];
}

/** 查 from..to + members 过滤的 sessions(未排序,不含 isRealProject 过滤)。*/
function querySessions(opts: FilterOpts): SessionRow[] {
  let sql =
    "SELECT sessionId, gitUser, cwd, lastActive, input, output, cacheCreation, cacheRead, added, deleted, modified, activeMs, title FROM sessions WHERE lastActive >= ? AND lastActive <= ?";
  const params: (number | string)[] = [opts.from, opts.to];
  if (opts.members.length > 0) {
    sql += ` AND gitUser IN (${opts.members.map(() => "?").join(",")})`;
    params.push(...opts.members);
  }
  return db.prepare(sql).all(...params) as SessionRow[];
}

/** projects 表 (gitUser\0cwd)→name 映射(项目榜/会话表展示名 fallback,前端 displayProjectName 再清洗)。*/
function projectNameMap(): Map<string, string> {
  const rows = db.prepare("SELECT gitUser, cwd, name FROM projects").all() as Array<{
    gitUser: string;
    cwd: string;
    name: string | null;
  }>;
  const m = new Map<string, string>();
  for (const r of rows) m.set(r.gitUser + "\0" + r.cwd, r.name ?? r.cwd);
  return m;
}

export interface DayBucket {
  date: string;
  ts: number;
  input: number;
  output: number;
  cache: number;
  total: number;
}
export interface DailyStat {
  date: string;
  ts: number;
  total: number;
  sessions: number;
  lines: number;
  dur: number;
}
export interface MemberAgg {
  gitUser: string;
  lastActive: number;
  realProjects: number;
  sessionCount: number;
  activeMs: number;
  totalTokens: TokenUsage;
  totalLines: LinesStat;
}
export interface StatsPayload {
  totals: {
    token: TokenUsage;
    rawTotal: number;
    lines: LinesStat;
    activeMs: number;
    sessions: number;
    members: number;
    projects: number;
  };
  activeMin: number; // 过滤后 lastActive min(范围徽章)
  activeMax: number; // 过滤后 lastActive max
  dataMin: number; // 全量数据最早 lastActive(重置范围用,不受日期/members 过滤)
  dataMax: number; // 全量数据最新 lastActive
  allMembers: string[]; // 全量 gitUser(成员下拉,不受 members 过滤)
  trend: DayBucket[]; // 按 granularity(TokenTrendChart)
  daily: DailyStat[]; // 固定 day(KpiCards sparkline)
  composition: { input: number; output: number; cache: number };
  tokenRank: {
    member: Array<{ gitUser: string; token: number }>;
    project: Array<{ cwd: string; name: string; token: number }>;
  };
  codeRank: Array<{ gitUser: string; lines: number; convs: number; token: number }>;
  sizeBuckets: Array<{ range: string; count: number }>;
  members: MemberAgg[];
}

interface MemberAcc {
  input: number;
  output: number;
  cc: number;
  cr: number;
  added: number;
  deleted: number;
  modified: number;
  activeMs: number;
  convs: number;
  lastActive: number;
  cwds: Set<string>; // 仅真项目
}

/** 全局聚合(复刻 derive.ts globalTotals/dailyStats/bucketByGranularity/tokenRank/codeRank/sessionSizeBuckets/countRealProjects)。*/
export function getStats(opts: FilterOpts & { granularity: Granularity }): StatsPayload {
  const rows = querySessions(opts);
  const names = projectNameMap();
  // 全量数据范围(不受 from/to/members 过滤,重置按钮用)
  const dataRange = (db.prepare("SELECT MIN(lastActive) AS min, MAX(lastActive) AS max FROM sessions").get() as { min: number; max: number }) ?? { min: 0, max: 0 };

  let tInput = 0,
    tOutput = 0,
    tCC = 0,
    tCR = 0,
    tActive = 0,
    tAdded = 0,
    tDeleted = 0,
    tModified = 0;
  let activeMin = Infinity,
    activeMax = -Infinity;
  const trendMap = new Map<string, DayBucket>();
  const dailyMap = new Map<string, DailyStat>();
  const memberAcc = new Map<string, MemberAcc>();
  const projTok = new Map<string, number>(); // gitUser\0cwd → token(仅真项目)
  const realProjKeys = new Set<string>();
  const sizes = SIZE_BUCKETS.map((b) => ({ range: b.range, count: 0 }));

  for (const r of rows) {
    const t = r.input + r.output + r.cacheCreation + r.cacheRead;
    tInput += r.input;
    tOutput += r.output;
    tCC += r.cacheCreation;
    tCR += r.cacheRead;
    tActive += r.activeMs;
    tAdded += r.added;
    tDeleted += r.deleted;
    tModified += r.modified;
    if (r.lastActive < activeMin) activeMin = r.lastActive;
    if (r.lastActive > activeMax) activeMax = r.lastActive;

    // trend(按 granularity)
    const tb = bucketOf(r.lastActive, opts.granularity);
    const tr =
      trendMap.get(tb.key) ?? { date: tb.label, ts: r.lastActive, input: 0, output: 0, cache: 0, total: 0 };
    tr.input += r.input;
    tr.output += r.output;
    tr.cache += r.cacheCreation + r.cacheRead;
    tr.total += t;
    tr.ts = r.lastActive;
    trendMap.set(tb.key, tr);

    // daily(固定 day,KpiCards sparkline)
    const dk = bucketOf(r.lastActive, "day");
    const ds = dailyMap.get(dk.key) ?? { date: dk.label, ts: r.lastActive, total: 0, sessions: 0, lines: 0, dur: 0 };
    ds.total += t;
    ds.sessions += 1;
    ds.lines += r.added + r.deleted + r.modified;
    ds.dur += r.activeMs;
    ds.ts = r.lastActive;
    dailyMap.set(dk.key, ds);

    // member 累加(全部 session)
    let m = memberAcc.get(r.gitUser);
    if (!m) {
      m = { input: 0, output: 0, cc: 0, cr: 0, added: 0, deleted: 0, modified: 0, activeMs: 0, convs: 0, lastActive: 0, cwds: new Set() };
      memberAcc.set(r.gitUser, m);
    }
    m.input += r.input;
    m.output += r.output;
    m.cc += r.cacheCreation;
    m.cr += r.cacheRead;
    m.added += r.added;
    m.deleted += r.deleted;
    m.modified += r.modified;
    m.activeMs += r.activeMs;
    m.convs += 1;
    if (r.lastActive > m.lastActive) m.lastActive = r.lastActive;

    // 仅真项目:项目榜 + realProjects 计数
    if (isRealProjectCwd(r.cwd)) {
      const pk = r.gitUser + "\0" + r.cwd;
      projTok.set(pk, (projTok.get(pk) ?? 0) + t);
      realProjKeys.add(pk);
      m.cwds.add(r.cwd);
    }

    // sizeBuckets(跳过 0 token,等价 sessionSizeBuckets)
    if (t > 0) {
      for (let i = 0; i < SIZE_BUCKETS.length; i++) {
        if (t <= SIZE_BUCKETS[i].max) {
          sizes[i].count++;
          break;
        }
      }
    }
  }

  const token: TokenUsage = { input: tInput, output: tOutput, cacheCreation: tCC, cacheRead: tCR };
  const lines: LinesStat = { added: tAdded, deleted: tDeleted, modified: tModified };

  const membersRaw = [...memberAcc.entries()].map(([gitUser, mm]) => {
    const raw = mm.input + mm.output + mm.cc + mm.cr;
    return {
      gitUser,
      lastActive: mm.lastActive,
      realProjects: mm.cwds.size,
      sessionCount: mm.convs,
      activeMs: mm.activeMs,
      totalTokens: { input: mm.input, output: mm.output, cacheCreation: mm.cc, cacheRead: mm.cr },
      totalLines: { added: mm.added, deleted: mm.deleted, modified: mm.modified },
      _raw: raw,
    };
  });
  membersRaw.sort((a, b) => b._raw - a._raw);

  const tokenRankMember = membersRaw
    .map((m) => ({ gitUser: m.gitUser, token: m._raw }))
    .sort((a, b) => b.token - a.token);
  const codeRank = membersRaw
    .map((m) => ({
      gitUser: m.gitUser,
      lines: m.totalLines.added + m.totalLines.deleted + m.totalLines.modified,
      convs: m.sessionCount,
      token: m.totalTokens.input + m.totalTokens.output,
    }))
    .sort((a, b) => b.lines - a.lines);
  const members: MemberAgg[] = membersRaw.map(({ _raw, ...rest }) => rest);

  const tokenRankProject = [...projTok.entries()]
    .map(([pk, tok]) => {
      const [gitUser, cwd] = pk.split("\0");
      return { cwd, name: names.get(pk) ?? cwd, token: tok };
    })
    .sort((a, b) => b.token - a.token);

  return {
    totals: {
      token,
      rawTotal: tInput + tOutput + tCC + tCR,
      lines,
      activeMs: tActive,
      sessions: rows.length,
      members: memberAcc.size,
      projects: realProjKeys.size,
    },
    activeMin: rows.length ? activeMin : 0,
    activeMax: rows.length ? activeMax : 0,
    dataMin: dataRange.min ?? 0,
    dataMax: dataRange.max ?? 0,
    allMembers: (db.prepare("SELECT DISTINCT gitUser FROM sessions").all() as Array<{ gitUser: string }>)
      .map((r) => r.gitUser)
      .sort(),
    trend: [...trendMap.values()].sort((a, b) => a.ts - b.ts),
    daily: [...dailyMap.values()].sort((a, b) => a.ts - b.ts),
    composition: { input: tInput, output: tOutput, cache: tCC + tCR },
    tokenRank: { member: tokenRankMember, project: tokenRankProject },
    codeRank,
    sizeBuckets: sizes,
    members,
  };
}

export interface SessionRowOut extends SessionRow {
  name: string;
}

/** 会话明细分页(等价 RecentSessionsTable 的 flattenSessions.filter(token>0).sort(lastActive desc))。*/
export function getSessions(
  opts: FilterOpts & { member?: string },
  page: number,
  pageSize: number,
): { rows: SessionRowOut[]; total: number; page: number; pageSize: number } {
  const o: FilterOpts = opts.member ? { from: opts.from, to: opts.to, members: [opts.member] } : opts;
  const rows = querySessions(o)
    .filter((r) => r.input + r.output + r.cacheCreation + r.cacheRead > 0)
    .sort((a, b) => b.lastActive - a.lastActive);
  const names = projectNameMap();
  const total = rows.length;
  const start = (page - 1) * pageSize;
  const sliced = rows.slice(start, start + pageSize).map((r) => ({
    ...r,
    name: names.get(r.gitUser + "\0" + r.cwd) ?? r.cwd,
  }));
  return { rows: sliced, total, page, pageSize };
}

export interface MemberDetail {
  gitUser: string;
  lastActive: number;
  totals: {
    token: TokenUsage;
    rawTotal: number;
    lines: LinesStat;
    activeMs: number;
    sessions: number;
    realProjects: number;
  };
  trend: DayBucket[];
}

/** 单成员 KPI + 趋势(给 MemberDetailPage;团队均值复用全局 getStats.totals)。*/
export function getMember(gitUser: string, opts: { from: number; to: number; granularity: Granularity }): MemberDetail {
  const rows = querySessions({ from: opts.from, to: opts.to, members: [gitUser] });
  let tInput = 0,
    tOutput = 0,
    tCC = 0,
    tCR = 0,
    tActive = 0,
    tAdded = 0,
    tDeleted = 0,
    tModified = 0;
  let lastActive = 0;
  const realCwds = new Set<string>();
  const trendMap = new Map<string, DayBucket>();
  for (const r of rows) {
    const t = r.input + r.output + r.cacheCreation + r.cacheRead;
    tInput += r.input;
    tOutput += r.output;
    tCC += r.cacheCreation;
    tCR += r.cacheRead;
    tActive += r.activeMs;
    tAdded += r.added;
    tDeleted += r.deleted;
    tModified += r.modified;
    if (r.lastActive > lastActive) lastActive = r.lastActive;
    if (isRealProjectCwd(r.cwd)) realCwds.add(r.cwd);
    const tb = bucketOf(r.lastActive, opts.granularity);
    const tr = trendMap.get(tb.key) ?? { date: tb.label, ts: r.lastActive, input: 0, output: 0, cache: 0, total: 0 };
    tr.input += r.input;
    tr.output += r.output;
    tr.cache += r.cacheCreation + r.cacheRead;
    tr.total += t;
    tr.ts = r.lastActive;
    trendMap.set(tb.key, tr);
  }
  return {
    gitUser,
    lastActive,
    totals: {
      token: { input: tInput, output: tOutput, cacheCreation: tCC, cacheRead: tCR },
      rawTotal: tInput + tOutput + tCC + tCR,
      lines: { added: tAdded, deleted: tDeleted, modified: tModified },
      activeMs: tActive,
      sessions: rows.length,
      realProjects: realCwds.size,
    },
    trend: [...trendMap.values()].sort((a, b) => a.ts - b.ts),
  };
}
