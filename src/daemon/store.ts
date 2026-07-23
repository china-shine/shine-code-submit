// SQLite 存储：单库 + cwd 字段（按 cwd 过滤实现隔离，便于查看页跨项目聚合）。
// 幂等：PRIMARY KEY (session_id, event_id) + INSERT OR IGNORE。
import { Database } from "bun:sqlite";
import { DB_FILE } from "../shared/paths";
import { deriveStableEventId } from "../shared/id";
import type { HookEvent, HookEventType, SessionSummary, TokenUsage } from "../shared/types";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS events (
  event_id    TEXT NOT NULL,
  session_id  TEXT NOT NULL,
  type        TEXT NOT NULL,
  timestamp   INTEGER NOT NULL,
  cwd         TEXT NOT NULL,
  pid         INTEGER NOT NULL,
  payload     TEXT NOT NULL,
  ingested_at INTEGER NOT NULL,
  PRIMARY KEY (session_id, event_id)
);
CREATE INDEX IF NOT EXISTS idx_events_time ON events(timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_events_session ON events(session_id, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_events_cwd ON events(cwd, timestamp DESC);

-- transcript 文件级状态(watcher 维护 dirty,消费者消费):每个 .jsonl 一行,独立字节偏移
CREATE TABLE IF NOT EXISTS transcript_files (
  path TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  parent_path TEXT NOT NULL,
  is_subagent INTEGER NOT NULL DEFAULT 0,
  mtime_ms INTEGER NOT NULL DEFAULT 0,
  size_bytes INTEGER NOT NULL DEFAULT 0,
  read_offset INTEGER NOT NULL DEFAULT 0,
  entries_blob TEXT NOT NULL DEFAULT '[]',
  dirty INTEGER NOT NULL DEFAULT 1,
  discovered_at INTEGER NOT NULL,
  last_read_at INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_tf_session ON transcript_files(session_id);
CREATE INDEX IF NOT EXISTS idx_tf_dirty ON transcript_files(dirty, last_read_at);

-- transcript 会话级结果(消费者全量重算后写,API 直接读)
CREATE TABLE IF NOT EXISTS transcript_sessions (
  session_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  parent_path TEXT NOT NULL,
  cwd TEXT,
  title TEXT,
  last_activity INTEGER NOT NULL DEFAULT 0,
  token_input INTEGER NOT NULL DEFAULT 0,
  token_output INTEGER NOT NULL DEFAULT 0,
  token_cc INTEGER NOT NULL DEFAULT 0,
  token_cr INTEGER NOT NULL DEFAULT 0,
  active_ms INTEGER NOT NULL DEFAULT 0,
  mtime_key TEXT NOT NULL DEFAULT '',
  dirty INTEGER NOT NULL DEFAULT 1,
  last_computed_at INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_ts_dirty ON transcript_sessions(dirty);
CREATE INDEX IF NOT EXISTS idx_ts_cwd ON transcript_sessions(cwd);
CREATE INDEX IF NOT EXISTS idx_ts_project ON transcript_sessions(project_id);
CREATE INDEX IF NOT EXISTS idx_ts_activity ON transcript_sessions(last_activity DESC);
`;

const INSERT = `
INSERT OR IGNORE INTO events (event_id, session_id, type, timestamp, cwd, pid, payload, ingested_at)
VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`;

export interface QueryOpts {
  cwd?: string;
  sessionId?: string;
  type?: string;
  since?: number;
  limit?: number;
}

/** transcript_files 行(文件级,每 .jsonl 一行)。 */
export interface TranscriptFileRow {
  path: string;
  session_id: string;
  project_id: string;
  parent_path: string;
  is_subagent: number;
  mtime_ms: number;
  size_bytes: number;
  read_offset: number;
  entries_blob: string;
  dirty: number;
  discovered_at: number;
  last_read_at: number;
}

/** transcript_sessions 行(会话级聚合结果)。 */
export interface TranscriptSessionRow {
  session_id: string;
  project_id: string;
  parent_path: string;
  cwd: string | null;
  title: string | null;
  last_activity: number;
  token_input: number;
  token_output: number;
  token_cc: number;
  token_cr: number;
  active_ms: number;
  mtime_key: string;
  dirty: number;
  last_computed_at: number;
}

export class Store {
  private db: Database;

  constructor() {
    this.db = new Database(DB_FILE, { create: true });
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA synchronous = NORMAL;");
    this.db.exec(SCHEMA);
  }

  /** 幂等插入。true=新插入，false=已存在（被去重）。
   *  eventId 在此由内容派生（sessionId+type+payload），忽略客户端/hook 传入的随机 id——
   *  这样即使同一事件被多个 hook 进程采集，派生主键相同，INSERT OR IGNORE 仍能去重。
   *  入库点统一在此，HTTP 热路径与 spool 回捞共享，互为兜底。 */
  insert(ev: HookEvent): boolean {
    const id = deriveStableEventId(ev);
    const r = this.db
      .prepare(INSERT)
      .run(
        id,
        ev.sessionId,
        ev.type,
        ev.timestamp,
        ev.cwd,
        ev.pid,
        JSON.stringify(ev.payload ?? null),
        Date.now(),
      );
    return r.changes > 0;
  }

  query(opts: QueryOpts): HookEvent[] {
    const where: string[] = [];
    const params: Array<string | number> = [];
    if (opts.cwd) { where.push("cwd = ?"); params.push(opts.cwd); }
    if (opts.sessionId) { where.push("session_id = ?"); params.push(opts.sessionId); }
    if (opts.type) { where.push("type = ?"); params.push(opts.type); }
    if (typeof opts.since === "number") { where.push("timestamp >= ?"); params.push(opts.since); }
    const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const limit = Math.min(Math.max(opts.limit ?? 200, 1), 2000);
    const rows = this.db
      .prepare(
        `SELECT event_id, session_id, type, timestamp, cwd, pid, payload FROM events ${clause} ORDER BY timestamp DESC LIMIT ?`,
      )
      .all(...params, limit);
    return rows.map(rowToEvent);
  }

  sessions(): SessionSummary[] {
    const rows = this.db
      .prepare(
        `SELECT session_id, cwd, MAX(timestamp) AS last_active, COUNT(*) AS event_count,
                (SELECT type FROM events e2 WHERE e2.session_id = e.session_id ORDER BY timestamp DESC LIMIT 1) AS last_type
         FROM events e
         GROUP BY session_id, cwd
         ORDER BY last_active DESC
         LIMIT 500`,
      )
      .all() as Array<{
        session_id: string;
        cwd: string;
        last_active: number;
        event_count: number;
        last_type: HookEventType | null;
      }>;
    return rows.map((r) => ({
      sessionId: r.session_id,
      cwd: r.cwd,
      lastActive: r.last_active,
      eventCount: r.event_count,
      lastType: r.last_type,
    }));
  }

  count(): number {
    const row = this.db.prepare("SELECT COUNT(*) AS n FROM events").get() as { n: number };
    return row.n;
  }

  // ---- transcript 文件级(watcher 写 dirty,消费者读消费) ----

  /** watcher 发现/变更:不存在则插(脏,offset=0,entries='[]'),存在则标 dirty=1。幂等(ON CONFLICT 只更 dirty)。 */
  markFileDirtyOrInsert(info: {
    path: string;
    sessionId: string;
    projectId: string;
    parentPath: string;
    isSubagent: boolean;
  }): void {
    this.db
      .prepare(
        `INSERT INTO transcript_files (path, session_id, project_id, parent_path, is_subagent, dirty, discovered_at)
         VALUES (?, ?, ?, ?, ?, 1, ?)
         ON CONFLICT(path) DO UPDATE SET dirty = 1`,
      )
      .run(info.path, info.sessionId, info.projectId, info.parentPath, info.isSubagent ? 1 : 0, Date.now());
  }

  /** 消费者读完尾部:推进 offset、更新 entries/mtime/size,清 dirty。 */
  updateFileConsumed(path: string, readOffset: number, entriesBlob: string, mtimeMs: number, sizeBytes: number): void {
    this.db
      .prepare(
        `UPDATE transcript_files SET read_offset = ?, entries_blob = ?, mtime_ms = ?, size_bytes = ?, dirty = 0, last_read_at = ? WHERE path = ?`,
      )
      .run(readOffset, entriesBlob, mtimeMs, sizeBytes, Date.now(), path);
  }

  /** 某 session 的所有文件行(父+子代理),供重算聚合 entries。 */
  filesForSession(sessionId: string): TranscriptFileRow[] {
    return this.db
      .prepare(
        `SELECT path, session_id, project_id, parent_path, is_subagent, mtime_ms, size_bytes, read_offset, entries_blob, dirty, discovered_at, last_read_at
         FROM transcript_files WHERE session_id = ?`,
      )
      .all(sessionId) as TranscriptFileRow[];
  }

  /** dirty 文件(消费者处理),按 last_read_at 升序(久的先),limit 上限。 */
  dirtyFiles(limit: number): TranscriptFileRow[] {
    return this.db
      .prepare(
        `SELECT path, session_id, project_id, parent_path, is_subagent, mtime_ms, size_bytes, read_offset, entries_blob, dirty, discovered_at, last_read_at
         FROM transcript_files WHERE dirty = 1 ORDER BY last_read_at ASC LIMIT ?`,
      )
      .all(limit) as TranscriptFileRow[];
  }

  /** 某 path 在 SQLite 的 mtime_ms(消费者上次读的);null=未记录。兜底全扫比对用。 */
  getFileMtimeMs(path: string): number | null {
    const r = this.db.prepare("SELECT mtime_ms FROM transcript_files WHERE path = ?").get(path) as { mtime_ms: number } | null;
    return r?.mtime_ms ?? null;
  }

  // ---- transcript 会话级(消费者重算写,API 读) ----

  /** 标 session dirty(文件消费后调)。行不存在则插(脏)。 */
  markSessionDirty(sessionId: string, projectId: string, parentPath: string): void {
    this.db
      .prepare(
        `INSERT INTO transcript_sessions (session_id, project_id, parent_path, dirty)
         VALUES (?, ?, ?, 1)
         ON CONFLICT(session_id) DO UPDATE SET dirty = 1`,
      )
      .run(sessionId, projectId, parentPath);
  }

  /** 消费者重算后写结果(清 dirty)。 */
  updateSessionResult(sessionId: string, token: TokenUsage, activeMs: number, lastActivity: number, mtimeKey: string): void {
    this.db
      .prepare(
        `UPDATE transcript_sessions SET token_input = ?, token_output = ?, token_cc = ?, token_cr = ?, active_ms = ?, last_activity = ?, mtime_key = ?, dirty = 0, last_computed_at = ? WHERE session_id = ?`,
      )
      .run(token.input, token.output, token.cacheCreation, token.cacheRead, activeMs, lastActivity, mtimeKey, Date.now(), sessionId);
  }

  /** 父文件首读时写 title/cwd(append-only,首 64 行永不变,算一次即可)。 */
  updateSessionHead(sessionId: string, title: string | null, cwd: string | null): void {
    this.db.prepare(`UPDATE transcript_sessions SET title = ?, cwd = ? WHERE session_id = ?`).run(title, cwd, sessionId);
  }

  /** dirty session(消费者重算),limit 上限。 */
  dirtySessions(limit: number): TranscriptSessionRow[] {
    return this.db
      .prepare(
        `SELECT session_id, project_id, parent_path, cwd, title, last_activity, token_input, token_output, token_cc, token_cr, active_ms, mtime_key, dirty, last_computed_at
         FROM transcript_sessions WHERE dirty = 1 LIMIT ?`,
      )
      .all(limit) as TranscriptSessionRow[];
  }

  /** API 查询:session 列表(零 token 过滤对齐 ccusage 计数),可按 cwd/since + 分页。 */
  getTranscriptSessions(opts: { cwd?: string; since?: number; limit?: number; offset?: number }): TranscriptSessionRow[] {
    const where: string[] = ["(token_input + token_output + token_cc + token_cr) > 0"];
    const params: Array<string | number> = [];
    if (opts.cwd) { where.push("cwd = ?"); params.push(opts.cwd); }
    if (typeof opts.since === "number") { where.push("last_activity >= ?"); params.push(opts.since); }
    const limit = Math.min(Math.max(opts.limit ?? 200, 1), 2000);
    const offset = Math.max(opts.offset ?? 0, 0);
    return this.db
      .prepare(
        `SELECT session_id, project_id, parent_path, cwd, title, last_activity, token_input, token_output, token_cc, token_cr, active_ms, mtime_key, dirty, last_computed_at
         FROM transcript_sessions WHERE ${where.join(" AND ")} ORDER BY last_activity DESC LIMIT ? OFFSET ?`,
      )
      .all(...params, limit, offset) as TranscriptSessionRow[];
  }

  getTranscriptSession(sessionId: string): TranscriptSessionRow | null {
    return this.db
      .prepare(
        `SELECT session_id, project_id, parent_path, cwd, title, last_activity, token_input, token_output, token_cc, token_cr, active_ms, mtime_key, dirty, last_computed_at
         FROM transcript_sessions WHERE session_id = ?`,
      )
      .get(sessionId) as TranscriptSessionRow | null;
  }

  close(): void {
    this.db.close();
  }
}

function rowToEvent(row: unknown): HookEvent {
  const r = row as {
    event_id: string;
    session_id: string;
    type: HookEventType;
    timestamp: number;
    cwd: string;
    pid: number;
    payload: string;
  };
  let payload: unknown = null;
  try {
    payload = JSON.parse(r.payload);
  } catch {
    /* payload 损坏则置 null */
  }
  return {
    eventId: r.event_id,
    sessionId: r.session_id,
    type: r.type,
    timestamp: r.timestamp,
    cwd: r.cwd,
    pid: r.pid,
    payload,
  };
}
