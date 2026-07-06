// 文件日志 + 按大小轮转 + tail。detached Daemon 同时写文件与 stdout
// （stdout 由启动者重定向到同一文件或控制台）。
import { appendFileSync, statSync, renameSync, readFileSync, existsSync } from "node:fs";
import { LOG_FILE } from "../shared/paths";
import { LOG_ROTATE_BYTES } from "../shared/config";

export class Logger {
  constructor(private tag = "daemon") {}

  private write(level: string, msg: string, extra?: unknown): void {
    const line = `[${localIso()}] [${level}] [${this.tag}] ${msg}${extra !== undefined ? " " + safeStringify(extra) : ""}\n`;
    this.maybeRotate();
    try {
      appendFileSync(LOG_FILE, line);
    } catch {
      /* 磁盘满等：跳过文件，避免抛出影响主流程 */
    }
    process.stdout.write(line);
  }

  info(m: string, e?: unknown) { this.write("INFO", m, e); }
  warn(m: string, e?: unknown) { this.write("WARN", m, e); }
  error(m: string, e?: unknown) { this.write("ERROR", m, e); }
  debug(m: string, e?: unknown) { if (process.env.SHINE_CODE_SUBMIT_DEBUG) this.write("DEBUG", m, e); }

  private maybeRotate(): void {
    try {
      if (existsSync(LOG_FILE) && statSync(LOG_FILE).size > LOG_ROTATE_BYTES) {
        renameSync(LOG_FILE, `${LOG_FILE}.${Date.now()}`);
      }
    } catch {
      /* ignore */
    }
  }

  tail(lines: number): string[] {
    try {
      const raw = readFileSync(LOG_FILE, "utf8");
      return raw.split("\n").filter(Boolean).slice(-lines);
    } catch {
      return [];
    }
  }
}

function safeStringify(v: unknown): string {
  if (v instanceof Error) return JSON.stringify({ name: v.name, message: v.message, stack: v.stack });
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

/** 本地时间 ISO 风格（带本地时区偏移）。toISOString() 恒为 UTC（Z），日志会与本地差 8 小时，故用此。 */
function localIso(d = new Date()): string {
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  const off = -d.getTimezoneOffset(); // 分钟；东八区为 +480
  const sign = off >= 0 ? "+" : "-";
  const abs = Math.abs(off);
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}` +
    `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
  );
}
