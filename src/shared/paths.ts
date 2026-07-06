// 数据目录布局：%LOCALAPPDATA%/shine-code-submit/{spool,log,db} + daemon.pid
import { join } from "node:path";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";

const LOCAL =
  process.env.LOCALAPPDATA ?? join(homedir(), ".local", "share");

export const DATA_DIR = join(LOCAL, "shine-code-submit");
export const SPOOL_DIR = join(DATA_DIR, "spool");
export const LOG_DIR = join(DATA_DIR, "log");
export const DB_DIR = join(DATA_DIR, "db");

export const PID_FILE = join(DATA_DIR, "daemon.pid");
export const LOG_FILE = join(LOG_DIR, "daemon.log");
export const DB_FILE = join(DB_DIR, "events.sqlite");

/** 创建所有需要的目录。Daemon 与 Hook 启动时各调一次幂等。 */
export function ensureDirs(): void {
  for (const d of [DATA_DIR, SPOOL_DIR, LOG_DIR, DB_DIR]) {
    mkdirSync(d, { recursive: true });
  }
}
