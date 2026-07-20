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

export interface SessionAgg {
  sessionId: string;
  lastActive: number;
  tokenTotal: TokenUsage | null;
  linesTotal: LinesStat | null;
  activeMs: number;
  title?: string | null;
}
export interface ProjectAgg {
  cwd: string;
  name: string;
  gitRemote: string | null;
  lastActive: number;
  sessionCount: number;
  totalTokens: TokenUsage;
  totalLines: LinesStat;
  sessions: SessionAgg[];
}
export interface UserAgg {
  gitUser: string;
  lastActive: number;
  projectCount: number;
  sessionCount: number;
  totalTokens: TokenUsage;
  totalLines: LinesStat;
  projects: ProjectAgg[];
}

const ZERO: TokenUsage = { input: 0, output: 0, cacheCreation: 0, cacheRead: 0 };
const ZERO_LINES: LinesStat = { added: 0, deleted: 0, modified: 0 };

function rawTotal(u: TokenUsage): number {
  return u.input + u.output + u.cacheCreation + u.cacheRead;
}
function sumTokens(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    cacheCreation: a.cacheCreation + b.cacheCreation,
    cacheRead: a.cacheRead + b.cacheRead,
  };
}
function sumLines(a: LinesStat, b: LinesStat): LinesStat {
  return {
    added: a.added + b.added,
    deleted: a.deleted + b.deleted,
    modified: a.modified + b.modified,
  };
}

interface ProjectRow {
  gitUser: string;
  cwd: string;
  name: string | null;
  gitRemote: string | null;
  lastActive: number;
}
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
  cachedUsers = null;
}

let cachedUsers: UserAgg[] | null = null;

/** 查询三级聚合(内存缓存,saveReport 时失效)。 */
export function aggregate(): UserAgg[] {
  if (cachedUsers) return cachedUsers;

  const projs = db
    .query<ProjectRow>("SELECT gitUser, cwd, name, gitRemote, lastActive FROM projects")
    .all();
  const sess = db
    .query<SessionRow>(
      "SELECT sessionId, gitUser, cwd, lastActive, input, output, cacheCreation, cacheRead, added, deleted, modified, activeMs, title FROM sessions",
    )
    .all();

  const sessByProj = new Map<string, SessionAgg[]>();
  for (const s of sess) {
    const key = s.gitUser + "\0" + s.cwd;
    let arr = sessByProj.get(key);
    if (!arr) {
      arr = [];
      sessByProj.set(key, arr);
    }
    arr.push({
      sessionId: s.sessionId,
      lastActive: s.lastActive,
      tokenTotal: {
        input: s.input,
        output: s.output,
        cacheCreation: s.cacheCreation,
        cacheRead: s.cacheRead,
      },
      linesTotal: { added: s.added, deleted: s.deleted, modified: s.modified },
      activeMs: s.activeMs,
      title: s.title,
    });
  }
  for (const arr of sessByProj.values()) arr.sort((a, b) => b.lastActive - a.lastActive);

  const projByUser = new Map<string, ProjectAgg[]>();
  for (const p of projs) {
    let arr = projByUser.get(p.gitUser);
    if (!arr) {
      arr = [];
      projByUser.set(p.gitUser, arr);
    }
    const sessions = sessByProj.get(p.gitUser + "\0" + p.cwd) ?? [];
    const totalTokens = sessions.reduce(
      (acc, s) => sumTokens(acc, s.tokenTotal ?? ZERO),
      { ...ZERO },
    );
    const totalLines = sessions.reduce(
      (acc, s) => sumLines(acc, s.linesTotal ?? ZERO_LINES),
      { ...ZERO_LINES },
    );
    arr.push({
      cwd: p.cwd,
      name: p.name ?? p.cwd,
      gitRemote: p.gitRemote,
      lastActive: p.lastActive,
      sessionCount: sessions.length,
      totalTokens,
      totalLines,
      sessions,
    });
  }
  for (const arr of projByUser.values()) {
    arr.sort((a, b) => rawTotal(b.totalTokens) - rawTotal(a.totalTokens));
  }

  const users: UserAgg[] = [];
  for (const [gitUser, projects] of projByUser) {
    const totalTokens = projects.reduce(
      (acc, p) => sumTokens(acc, p.totalTokens),
      { ...ZERO },
    );
    const totalLines = projects.reduce(
      (acc, p) => sumLines(acc, p.totalLines),
      { ...ZERO_LINES },
    );
    const sessionCount = projects.reduce((a, p) => a + p.sessionCount, 0);
    const lastActive = projects.reduce((a, p) => Math.max(a, p.lastActive), 0);
    users.push({
      gitUser,
      lastActive,
      projectCount: projects.length,
      sessionCount,
      totalTokens,
      totalLines,
      projects,
    });
  }
  users.sort((a, b) => rawTotal(b.totalTokens) - rawTotal(a.totalTokens));
  cachedUsers = users;
  return users;
}
