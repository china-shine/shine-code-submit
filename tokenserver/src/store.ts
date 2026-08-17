// 规范化存储:projects + sessions 两表,upsert 去重(行数稳定)。
// DATA_DIR 双模式:开发(bun run src)= tokenserver/data;编译(二进制)= 二进制旁 data/。
// (Bun 编译后 import.meta.dir 固化为编译机路径,Linux 上不存在,故编译模式用 process.execPath)
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
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
    version TEXT,
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
  CREATE TABLE IF NOT EXISTS git_changes (
    hash TEXT NOT NULL,
    gitUser TEXT NOT NULL,
    cwd TEXT NOT NULL,
    ts INTEGER NOT NULL,
    added INTEGER DEFAULT 0,
    deleted INTEGER DEFAULT 0,
    aiAdded INTEGER DEFAULT 0,
    aiDeleted INTEGER DEFAULT 0,
    PRIMARY KEY (hash)
  );
  CREATE INDEX IF NOT EXISTS idx_gitchanges_ts ON git_changes(ts);
  CREATE INDEX IF NOT EXISTS idx_gitchanges_user_cwd ON git_changes(gitUser, cwd, ts);
  CREATE TABLE IF NOT EXISTS worklogs (
    gitUser TEXT NOT NULL,
    date TEXT NOT NULL,
    sessionId TEXT NOT NULL,
    taskId INTEGER,
    subId TEXT NOT NULL DEFAULT '',
    repo TEXT,
    branch TEXT,
    cwd TEXT,
    "start" TEXT,
    "end" TEXT,
    minutes INTEGER DEFAULT 0,
    hours REAL DEFAULT 0,
    taskName TEXT,
    projectId INTEGER,
    projectName TEXT,
    work TEXT,
    status TEXT,
    zentaoUrl TEXT,
    updatedAt INTEGER DEFAULT 0,
    PRIMARY KEY (gitUser, date, sessionId, taskId, subId)
  );
  CREATE INDEX IF NOT EXISTS idx_worklogs_user_date ON worklogs(gitUser, date);
`);

// 旧库迁移:git_changes 加 aiAdded/aiDeleted 列(行级 AI 占比分子:该 commit added/deleted 行中 AI 写删的行数)
{
  const gcCols = db.prepare("PRAGMA table_info(git_changes)").all() as Array<{ name: string }>;
  if (!gcCols.some((c) => c.name === "aiAdded")) db.exec("ALTER TABLE git_changes ADD COLUMN aiAdded INTEGER DEFAULT 0");
  if (!gcCols.some((c) => c.name === "aiDeleted")) db.exec("ALTER TABLE git_changes ADD COLUMN aiDeleted INTEGER DEFAULT 0");
}

// 旧库迁移:worklogs 加 subId 列(提交流水号)并纳入主键——旧 PK (gitUser,date,sessionId,taskId)
// 同会话同任务多笔提交会顶替,镜像不了禅道逐笔记录。SQLite 改不了主键 → 重建表;
// 旧行 subId='' 与旧上报路径(daemon 无 subId 字段)一致,PK 语义不变。
{
  const wlCols = db.prepare("PRAGMA table_info(worklogs)").all() as Array<{ name: string }>;
  if (wlCols.length && !wlCols.some((c) => c.name === "subId")) {
    // 单事务原子完成 rename→rebuild→copy→drop,中途崩溃不会留下「worklogs 不存在」的半迁移状态
    db.transaction(() => {
      db.exec("ALTER TABLE worklogs RENAME TO worklogs_old");
      db.exec(`CREATE TABLE worklogs (
        gitUser TEXT NOT NULL,
        date TEXT NOT NULL,
        sessionId TEXT NOT NULL,
        taskId INTEGER,
        subId TEXT NOT NULL DEFAULT '',
        repo TEXT,
        branch TEXT,
        cwd TEXT,
        "start" TEXT,
        "end" TEXT,
        minutes INTEGER DEFAULT 0,
        hours REAL DEFAULT 0,
        taskName TEXT,
        projectId INTEGER,
        projectName TEXT,
        work TEXT,
        status TEXT,
        zentaoUrl TEXT,
        updatedAt INTEGER DEFAULT 0,
        PRIMARY KEY (gitUser, date, sessionId, taskId, subId)
      )`);
      db.exec(`INSERT INTO worklogs (gitUser, date, sessionId, taskId, subId, repo, branch, cwd, "start", "end", minutes, hours, taskName, projectId, projectName, work, status, zentaoUrl, updatedAt)
        SELECT gitUser, date, sessionId, taskId, '', repo, branch, cwd, "start", "end", minutes, hours, taskName, projectId, projectName, work, status, zentaoUrl, updatedAt FROM worklogs_old`);
      db.exec("DROP TABLE worklogs_old"); // 旧索引随表销毁,下方重建
      db.exec("CREATE INDEX IF NOT EXISTS idx_worklogs_user_date ON worklogs(gitUser, date)");
    })();
  }
}

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
// 旧库迁移:projects 加 version 列(daemon 上报版本号)
{
  const pcols = db.prepare("PRAGMA table_info(projects)").all() as Array<{ name: string }>;
  const phave = new Set(pcols.map((c) => c.name));
  if (!phave.has("version")) db.exec(`ALTER TABLE projects ADD COLUMN version TEXT`);
}

const ZERO: TokenUsage = { input: 0, output: 0, cacheCreation: 0, cacheRead: 0 };
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
  INSERT INTO projects (gitUser, cwd, name, gitRemote, lastActive, updatedAt, version)
  VALUES (?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(gitUser, cwd) DO UPDATE SET
    name = excluded.name,
    gitRemote = excluded.gitRemote,
    lastActive = MAX(projects.lastActive, excluded.lastActive),
    updatedAt = excluded.updatedAt,
    version = excluded.version
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
    added = COALESCE(excluded.added, sessions.added),
    deleted = COALESCE(excluded.deleted, sessions.deleted),
    modified = COALESCE(excluded.modified, sessions.modified),
    activeMs = excluded.activeMs,
    title = excluded.title,
    updatedAt = excluded.updatedAt
  WHERE excluded.lastActive >= sessions.lastActive OR excluded.cwd IS NOT sessions.cwd
`);
// 行数三列 COALESCE(2026-08-17):daemon 侧 events 7 天滚动修剪后,老会话行数上报 null(无数据≠零行),
// null 时保留平台旧值,防全量校准把历史行数清零;git_changes 用 MAX 天然防降级无需处理。
const upsertGitChange = db.query(`
  INSERT INTO git_changes (hash, gitUser, cwd, ts, added, deleted, aiAdded, aiDeleted)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(hash) DO UPDATE SET aiAdded = MAX(git_changes.aiAdded, excluded.aiAdded), aiDeleted = MAX(git_changes.aiDeleted, excluded.aiDeleted)
`);
// 禅道工时 upsert:PK(gitUser,date,sessionId,taskId,subId)幂等累积;taskId null→0 兜底(NULL 在 SQLite 唯一约束里互异会导致重复插入)。
// subId=提交流水号("<date>:<行号>"),同会话同任务多笔提交各占一行(镜像禅道逐笔);旧上报无 subId→'' 走旧语义。
// start/end/work 是 SQLite 保留字,INSERT 列表与 ON CONFLICT 引用都加双引号。
const upsertWorklog = db.query(`
  INSERT INTO worklogs (gitUser, date, sessionId, taskId, subId, repo, branch, cwd, "start", "end", minutes, hours, taskName, projectId, projectName, work, status, zentaoUrl, updatedAt)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(gitUser, date, sessionId, taskId, subId) DO UPDATE SET
    repo = excluded.repo,
    branch = excluded.branch,
    cwd = excluded.cwd,
    "start" = excluded."start",
    "end" = excluded."end",
    minutes = excluded.minutes,
    hours = excluded.hours,
    taskName = excluded.taskName,
    projectId = excluded.projectId,
    projectName = excluded.projectName,
    work = excluded.work,
    status = excluded.status,
    zentaoUrl = excluded.zentaoUrl,
    updatedAt = excluded.updatedAt
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
      upsertProject.run(gitUser, p.cwd, p.name ?? null, p.gitRemote ?? null, projLastActive, now, raw.version ?? null);
      for (const s of p.sessions ?? []) {
        const t = s.tokenTotal ?? ZERO;
        // linesTotal 为 null(无数据≠零行)时三列传 null → upsert COALESCE 保留旧值
        // (daemon events 7 天修剪后老会话行数报 null,防全量校准清零平台历史)。
        const l = s.linesTotal;
        upsertSession.run(
          s.sessionId, gitUser, p.cwd, s.lastActive,
          t.input, t.output, t.cacheCreation, t.cacheRead,
          l?.added ?? null, l?.deleted ?? null, l?.modified ?? null, s.activeMs ?? 0, s.title ?? null, now,
        );
      }
      // 该项目该窗口所有 commit 的代码变化行(AI 占比分母);hash 幂等,全量重扫不重
      for (const c of p.gitCommits ?? []) {
        upsertGitChange.run(c.hash, gitUser, p.cwd, c.ts, c.added, c.deleted, c.aiAdded ?? 0, c.aiDeleted ?? 0);
      }
    }
    // 禅道工时(daemon 忽略 since 全量上报;PK 复合 upsert 累积,taskId null→0 兜底幂等)
    for (const w of raw.worklogs ?? []) {
      upsertWorklog.run(
        gitUser, w.date, w.sessionId, w.taskId ?? 0, w.subId ?? "",
        w.repo ?? null, w.branch ?? null, w.cwd ?? null,
        w.start ?? null, w.end ?? null, w.minutes ?? 0, w.hours ?? 0,
        w.taskName ?? null, w.projectId ?? null, w.projectName ?? null,
        w.work ?? null, w.status ?? null, w.zentaoUrl ?? null, now,
      );
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

interface GitChangeRow {
  ts: number;
  gitUser: string;
  cwd: string;
  added: number;
  deleted: number;
  aiAdded: number;
  aiDeleted: number;
}

/** 读配置(DATA_DIR/config.json,用户手编辑):aiStatsHosts = AI 占比只统计的仓库 host 白名单(空/缺=不过滤=全部)。*/
function readConfig(): { aiStatsHosts?: string[] } {
  try {
    const f = join(DATA_DIR, "config.json");
    if (!existsSync(f)) return {};
    return JSON.parse(readFileSync(f, "utf8")) as { aiStatsHosts?: string[] };
  } catch {
    return {};
  }
}

/** 从 git remote URL 提取 host(AI 占比 host 白名单等值比较用):
 *  https://host/...、ssh://git@host:22/...、git@host:owner/repo;解析失败返回 null。
 *  替代原先的 LIKE '%host%' 子串匹配——那会把配置 github.com 误命中 my-github.company.cn
 *  或 evil.com/github.com/x,且未转义 LIKE 通配符(_ 匹配任意字符)。 */
function extractGitHost(remote: string | null | undefined): string | null {
  if (!remote) return null;
  const m = /^(?:ssh|https?):\/\/(?:[^@/@]+@)?([^\/:]+)(?::\d+)?[\/]/.exec(remote);
  if (m?.[1]) return m[1].toLowerCase();
  const s = /^git@([^:]+):/.exec(remote);
  return s?.[1] ? s[1].toLowerCase() : null;
}

/** host 白名单命中:提取 remote 的 host 后等值比较(大小写不敏感);白名单空 = 不过滤。 */
function hostAllowed(remote: string | null | undefined, hosts: string[]): boolean {
  if (hosts.length === 0) return true;
  const h = extractGitHost(remote);
  return h !== null && hosts.some((x) => x.trim().toLowerCase() === h);
}

/** projects 表 (gitUser\0cwd)→gitRemote 映射(host 过滤查表用)。 */
function projectRemoteMap(): Map<string, string | null> {
  const rows = db.prepare("SELECT gitUser, cwd, gitRemote FROM projects").all() as Array<{
    gitUser: string;
    cwd: string;
    gitRemote: string | null;
  }>;
  const m = new Map<string, string | null>();
  for (const r of rows) m.set(r.gitUser + "\0" + r.cwd, r.gitRemote ?? null);
  return m;
}

/** 查 from..to + members 过滤的 git_changes(commit 代码变化行,AI 占比分母;与 querySessions 同过滤口径)。
 *  host 白名单非空时,按 projects.gitRemote 提取 host 等值过滤(无 remote/解析失败/不命中 → 排除)。*/
function queryGitChanges(opts: FilterOpts): GitChangeRow[] {
  const hosts = readConfig().aiStatsHosts ?? [];
  const params: (number | string)[] = [];
  let sql =
    "SELECT g.ts AS ts, g.gitUser AS gitUser, g.cwd AS cwd, g.added AS added, g.deleted AS deleted, g.aiAdded AS aiAdded, g.aiDeleted AS aiDeleted FROM git_changes g";
  sql += " WHERE g.ts >= ? AND g.ts <= ?";
  params.push(opts.from, opts.to);
  if (opts.members.length > 0) {
    sql += ` AND g.gitUser IN (${opts.members.map(() => "?").join(",")})`;
    params.push(...opts.members);
  }
  let rows = db.prepare(sql).all(...params) as GitChangeRow[];
  if (hosts.length > 0) {
    const remotes = projectRemoteMap();
    rows = rows.filter((g) => hostAllowed(remotes.get(g.gitUser + "\0" + g.cwd), hosts));
  }
  return rows;
}

/** AI 占比「分母构成」:按 cwd + 按有无 AI 覆盖,拆分 git_changes 的分母(added+deleted)。
 *  过滤口径同 queryGitChanges(from/to/members/host);member(单成员,成员详情页用)优先于 members。
 *  让 dashboard 看清分母里有多少真实 AI 项目、多少是无 transcript 覆盖的 commit——
 *  原实现 base 里固定 AND aiAdded>0,no-ai 桶是死分支永远为空;现 JS 聚合含全部 commit。 */
export function getDenominatorBreakdown(opts: FilterOpts & { member?: string }): {
  byCwd: Array<{ cwd: string; denom: number; ai: number; commits: number }>;
  byAi: Array<{ bucket: "ai" | "no-ai"; denom: number; ai: number; commits: number }>;
  total: { denom: number; ai: number; commits: number };
} {
  const rows = queryGitChanges(opts).filter((g) => (opts.member ? g.gitUser === opts.member : true));
  const byCwdMap = new Map<string, { cwd: string; denom: number; ai: number; commits: number }>();
  const aiB = { denom: 0, ai: 0, commits: 0 }; // 有 AI 覆盖(aiAdded/aiDeleted 任一 >0)
  const noB = { denom: 0, ai: 0, commits: 0 }; // 无覆盖(纯手写 commit)
  for (const g of rows) {
    const denom = g.added + g.deleted;
    const ai = g.aiAdded + g.aiDeleted;
    const hasAi = g.aiAdded > 0 || g.aiDeleted > 0;
    const b = hasAi ? aiB : noB;
    b.denom += denom;
    b.ai += ai;
    b.commits += 1;
    const c = byCwdMap.get(g.cwd) ?? { cwd: g.cwd, denom: 0, ai: 0, commits: 0 };
    c.denom += denom;
    c.ai += ai;
    c.commits += 1;
    byCwdMap.set(g.cwd, c);
  }
  const byCwd = [...byCwdMap.values()].sort((a, b) => b.denom - a.denom);
  const byAi: Array<{ bucket: "ai" | "no-ai"; denom: number; ai: number; commits: number }> = [
    { bucket: "ai", ...aiB },
    { bucket: "no-ai", ...noB },
  ];
  const total = {
    denom: byCwd.reduce((s, r) => s + r.denom, 0),
    ai: byCwd.reduce((s, r) => s + r.ai, 0),
    commits: byCwd.reduce((s, r) => s + r.commits, 0),
  };
  return { byCwd, byAi, total };
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
  gitAdded: number; // git_changes 分母(commit 新增行,AI 占比 sparkline)
  gitDeleted: number; // git_changes 分母(commit 删除行)
  aiGitAdded: number; // isAI commit 行(commit 粒度 AI 占比分子)
  aiGitDeleted: number; // isAI commit 行(分子)
}
export interface MemberAgg {
  gitUser: string;
  lastActive: number;
  realProjects: number;
  sessionCount: number;
  activeMs: number;
  totalTokens: TokenUsage;
  totalLines: LinesStat;
  codeLines: { added: number; deleted: number }; // git_changes 分母(AI 占比)
  aiCodeLines: { added: number; deleted: number }; // isAI commit 行(成员级分子)
  version: string; // 该成员最新上报的 daemon 版本
}
export interface StatsPayload {
  totals: {
    token: TokenUsage;
    rawTotal: number;
    lines: LinesStat;
    codeLines: { added: number; deleted: number }; // git_changes 分母(AI 占比)
    aiCodeLines: { added: number; deleted: number }; // isAI commit 行(commit 粒度 AI 占比分子)
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
  codeRank: Array<{ gitUser: string; lines: number; added: number; deleted: number; modified: number; convs: number; token: number }>;
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
  gitAdded: number; // git_changes 分母(commit 新增行)
  gitDeleted: number; // git_changes 分母(commit 删除行)
  gitAiAdded: number; // isAI commit 行(成员级 AI 占比分子)
  gitAiDeleted: number; // isAI commit 行(分子)
}

/** 全局聚合(复刻 derive.ts globalTotals/dailyStats/bucketByGranularity/tokenRank/codeRank/sessionSizeBuckets/countRealProjects)。*/
export function getStats(opts: FilterOpts & { granularity: Granularity }): StatsPayload {
  const rows = querySessions(opts);
  const gitRows = queryGitChanges(opts);
  const names = projectNameMap();
  // 每成员最近上报的 daemon 版本:取 projects.updatedAt 最新一行的 version。
  // ⚠️ 不能用 MAX(version)——version 是 semver 字符串,SQLite TEXT MAX 走字典序,
  //    "1.3.11" < "1.3.4"(第 4 位 '1'<'4'),新版本号会被算成"更小",永远取到旧的 1.3.4。
  const projVersions = new Map<string, string>();
  const verRows = db.prepare(`
    SELECT p.gitUser, p.version
    FROM projects p
    INNER JOIN (
      SELECT gitUser, MAX(updatedAt) AS mx
      FROM projects
      WHERE version IS NOT NULL AND version <> ''
      GROUP BY gitUser
    ) m ON m.gitUser = p.gitUser AND p.updatedAt = m.mx
    WHERE p.version IS NOT NULL AND p.version <> ''
  `).all() as Array<{ gitUser: string; version: string }>;
  for (const r of verRows) {
    if (r.version) projVersions.set(r.gitUser, r.version);
  }
  // 全量数据范围(不受 from/to/members 过滤,重置按钮用)
  const dataRange = (db.prepare("SELECT MIN(lastActive) AS min, MAX(lastActive) AS max FROM sessions").get() as { min: number; max: number }) ?? { min: 0, max: 0 };

  let tInput = 0,
    tOutput = 0,
    tCC = 0,
    tCR = 0,
    tActive = 0,
    tAdded = 0,
    tDeleted = 0,
    tModified = 0,
    tGitAdded = 0,
    tGitDeleted = 0,
    tGitAiAdded = 0,
    tGitAiDeleted = 0;
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
    const ds = dailyMap.get(dk.key) ?? { date: dk.label, ts: r.lastActive, total: 0, sessions: 0, lines: 0, dur: 0, gitAdded: 0, gitDeleted: 0, aiGitAdded: 0, aiGitDeleted: 0 };
    ds.total += t;
    ds.sessions += 1;
    ds.lines += r.added + r.deleted + r.modified;
    ds.dur += r.activeMs;
    ds.ts = r.lastActive;
    dailyMap.set(dk.key, ds);

    // member 累加(全部 session)
    let m = memberAcc.get(r.gitUser);
    if (!m) {
      m = { input: 0, output: 0, cc: 0, cr: 0, added: 0, deleted: 0, modified: 0, activeMs: 0, convs: 0, lastActive: 0, cwds: new Set(), gitAdded: 0, gitDeleted: 0, gitAiAdded: 0, gitAiDeleted: 0 };
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

  // git_changes 分母累加(全局 + 按 member + 按日,与 sessions 同 from/to/members 口径)
  for (const g of gitRows) {
    if (g.aiAdded <= 0 && g.aiDeleted <= 0) continue; // 只统计有 transcript 覆盖(aiAdded/aiDeleted 任一>0)的 commit;无覆盖不进分母(避免拉低占比)。纯删除型 AI commit(aiAdded=0,aiDeleted>0)不再被整条丢弃——其 AI 删除行此前既不进分子也不进分母,占比系统性低估
    tGitAdded += g.added;
    tGitDeleted += g.deleted;
    tGitAiAdded += g.aiAdded;
    tGitAiDeleted += g.aiDeleted;
    // 按日桶累加分母(只累加到已有 session 的日桶,不新建 → 避免给 token/会话等 sparkline 插 0 谷)
    const gk = bucketOf(g.ts, "day");
    const gds = dailyMap.get(gk.key);
    if (gds) {
      gds.gitAdded += g.added;
      gds.gitDeleted += g.deleted;
      gds.aiGitAdded += g.aiAdded;
      gds.aiGitDeleted += g.aiDeleted;
    }
    let m = memberAcc.get(g.gitUser);
    if (!m) {
      m = { input: 0, output: 0, cc: 0, cr: 0, added: 0, deleted: 0, modified: 0, activeMs: 0, convs: 0, lastActive: 0, cwds: new Set(), gitAdded: 0, gitDeleted: 0, gitAiAdded: 0, gitAiDeleted: 0 };
      memberAcc.set(g.gitUser, m);
    }
    m.gitAdded += g.added;
    m.gitDeleted += g.deleted;
    m.gitAiAdded += g.aiAdded;
    m.gitAiDeleted += g.aiDeleted;
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
      codeLines: { added: mm.gitAdded, deleted: mm.gitDeleted },
      aiCodeLines: { added: mm.gitAiAdded, deleted: mm.gitAiDeleted },
      version: projVersions.get(gitUser) ?? "",
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
      added: m.totalLines.added,
      deleted: m.totalLines.deleted,
      modified: m.totalLines.modified,
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
      codeLines: { added: tGitAdded, deleted: tGitDeleted },
      aiCodeLines: { added: tGitAiAdded, deleted: tGitAiDeleted },
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
    codeLines: { added: number; deleted: number }; // git_changes 分母(AI 占比)
    aiCodeLines: { added: number; deleted: number }; // isAI commit 行(commit 粒度 AI 占比分子)
    activeMs: number;
    sessions: number;
    realProjects: number;
  };
  trend: DayBucket[];
  daily: DailyStat[]; // 固定 day(AI 占比 sparkline)
}

/** 单成员 KPI + 趋势(给 MemberDetailPage;团队均值复用全局 getStats.totals)。*/
export function getMember(gitUser: string, opts: { from: number; to: number; granularity: Granularity }): MemberDetail {
  const rows = querySessions({ from: opts.from, to: opts.to, members: [gitUser] });
  const gitRows = queryGitChanges({ from: opts.from, to: opts.to, members: [gitUser] });
  let tInput = 0,
    tOutput = 0,
    tCC = 0,
    tCR = 0,
    tActive = 0,
    tAdded = 0,
    tDeleted = 0,
    tModified = 0,
    tGitAdded = 0,
    tGitDeleted = 0,
    tGitAiAdded = 0,
    tGitAiDeleted = 0;
  let lastActive = 0;
  const realCwds = new Set<string>();
  const trendMap = new Map<string, DayBucket>();
  const dailyMap = new Map<string, DailyStat>();
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

    // daily(固定 day,AI 占比 sparkline 分子)
    const dk = bucketOf(r.lastActive, "day");
    const ds = dailyMap.get(dk.key) ?? { date: dk.label, ts: r.lastActive, total: 0, sessions: 0, lines: 0, dur: 0, gitAdded: 0, gitDeleted: 0, aiGitAdded: 0, aiGitDeleted: 0 };
    ds.total += t;
    ds.sessions += 1;
    ds.lines += r.added + r.deleted + r.modified;
    ds.dur += r.activeMs;
    ds.ts = r.lastActive;
    dailyMap.set(dk.key, ds);
  }
  for (const g of gitRows) {
    if (g.aiAdded <= 0 && g.aiDeleted <= 0) continue; // 只统计有 transcript 覆盖(aiAdded/aiDeleted 任一>0)的 commit;无覆盖不进分母(避免拉低占比)。纯删除型 AI commit(aiAdded=0,aiDeleted>0)不再被整条丢弃——其 AI 删除行此前既不进分子也不进分母,占比系统性低估
    tGitAdded += g.added;
    tGitDeleted += g.deleted;
    tGitAiAdded += g.aiAdded;
    tGitAiDeleted += g.aiDeleted;
    // 按日桶累加分母(只累加到已有 session 的日桶,不新建 → 避免给 token sparkline 插 0 谷)
    const gk = bucketOf(g.ts, "day");
    const gds = dailyMap.get(gk.key);
    if (gds) {
      gds.gitAdded += g.added;
      gds.gitDeleted += g.deleted;
      gds.aiGitAdded += g.aiAdded;
      gds.aiGitDeleted += g.aiDeleted;
    }
  }
  return {
    gitUser,
    lastActive,
    totals: {
      token: { input: tInput, output: tOutput, cacheCreation: tCC, cacheRead: tCR },
      rawTotal: tInput + tOutput + tCC + tCR,
      lines: { added: tAdded, deleted: tDeleted, modified: tModified },
      codeLines: { added: tGitAdded, deleted: tGitDeleted },
      aiCodeLines: { added: tGitAiAdded, deleted: tGitAiDeleted },
      activeMs: tActive,
      sessions: rows.length,
      realProjects: realCwds.size,
    },
    trend: [...trendMap.values()].sort((a, b) => a.ts - b.ts),
    daily: [...dailyMap.values()].sort((a, b) => a.ts - b.ts),
  };
}

export interface WorklogRowOut {
  date: string;
  sessionId: string;
  repo: string | null;
  branch: string | null;
  start: string | null;
  end: string | null;
  minutes: number;
  hours: number;
  taskId: number | null;
  taskName: string | null;
  projectId: number | null;
  projectName: string | null;
  work: string | null;
  zentaoUrl: string | null;
}

/** 成员禅道工时分页(已提交 resolved;date YYYY-MM-DD 字符串比较过滤,词法序正确)。
 *  按 date DESC, sessionId 排序;taskId=0(无任务兜底)前端按空显示。 */
export function getMemberWorklogs(
  gitUser: string,
  opts: { start: string; end: string },
  page: number,
  pageSize: number,
): { rows: WorklogRowOut[]; total: number; page: number; pageSize: number } {
  let sql = `SELECT date, sessionId, repo, branch, "start", "end", minutes, hours, taskId, taskName, projectId, projectName, work, zentaoUrl FROM worklogs WHERE gitUser = ?`;
  const params: (string | number)[] = [gitUser];
  if (opts.start) {
    sql += ` AND date >= ?`;
    params.push(opts.start);
  }
  if (opts.end) {
    sql += ` AND date <= ?`;
    params.push(opts.end);
  }
  sql += ` ORDER BY date DESC, sessionId`;
  const all = db.prepare(sql).all(...params) as WorklogRowOut[];
  const total = all.length;
  const totalHours = all.reduce((s, r) => s + (r.hours || 0), 0); // 全量总工时(给前端合计行,非当前页)
  const startIdx = (page - 1) * pageSize;
  return { rows: all.slice(startIdx, startIdx + pageSize), total, totalHours, page, pageSize };
}
