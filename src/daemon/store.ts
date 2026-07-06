// SQLite 存储：单库 + cwd 字段（按 cwd 过滤实现隔离，便于查看页跨项目聚合）。
// 幂等：PRIMARY KEY (session_id, event_id) + INSERT OR IGNORE。
import { Database } from "bun:sqlite";
import { DB_FILE } from "../shared/paths";
import { deriveStableEventId } from "../shared/id";
import type { HookEvent, HookEventType, SessionSummary } from "../shared/types";

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
