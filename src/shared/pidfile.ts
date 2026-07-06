// pid 文件读写：记录 Daemon pid/port/token/startedAt。
// Hook 与 CLI 读取 token 用于鉴权；Daemon 写入。
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { PID_FILE } from "./paths";
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
