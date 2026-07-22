// pid 文件读写：记录 Daemon pid/port/token/startedAt。
// Hook 与 CLI 读取 token 用于鉴权；Daemon 写入。
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { PID_FILE, TOKEN_FILE } from "./paths";
import type { PidFile } from "./types";

export function writePidFile(data: PidFile): void {
  // mode 在 Windows 上不生效，POSIX 下收紧到 0600（仅当前用户可读）。
  writeFileSync(PID_FILE, JSON.stringify(data), { mode: 0o600 });
}

export function readPidFile(): PidFile | null {
  try {
    const raw = readFileSync(PID_FILE, "utf8");
    return JSON.parse(raw) as PidFile;
  } catch {
    return null;
  }
}

export function removePidFile(): void {
  try {
    unlinkSync(PID_FILE);
  } catch {
    /* 已不存在 */
  }
}

/** Hook / CLI 取鉴权 token 的便捷封装。 */
export function readToken(): string | null {
  return readPidFile()?.token ?? null;
}

/**
 * 持久 token：读 TOKEN_FILE 复用；没有/损坏则生成并落盘（0600）。
 * 关键作用：daemon 每次重启（含自动升级 stopDaemon→起新进程）复用同一 token →
 * SessionStart 打印的 dashboard 链接永不失效，用户升级后不必重新拿链接。
 * pid 文件仍带此 token（main.ts 写），下游 auth/readToken 完全不变。
 */
export function readOrCreateToken(): string {
  try {
    const t = readFileSync(TOKEN_FILE, "utf8").trim();
    if (t.length >= 16) return t; // 复用持久 token（uuid v4 为 36 字符）
  } catch {
    /* 无文件：首次启动 */
  }
  const t = crypto.randomUUID();
  try {
    writeFileSync(TOKEN_FILE, t, { mode: 0o600 });
  } catch {
    /* 写失败：用本次内存 token，下次启动再尝试持久化（链接仅在本次会话内可能变） */
  }
  return t;
}
