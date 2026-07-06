// 目录式 spool：每事件一文件，规避多进程并发 append 的交错/截断。
// 写：tmp + rename（同分区原子）。读：扫目录。确认：unlink。
import { renameSync, writeFileSync, readdirSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { SPOOL_DIR } from "./paths";
import type { HookEvent } from "./types";

/** 生成天然唯一的 spool 文件名：{ts}-{pid}-{rand}.json。 */
export function spoolFileName(ev: HookEvent): string {
  const rand = crypto.randomUUID().slice(0, 8);
  return `${ev.timestamp}-${ev.pid}-${rand}.json`;
}

/** 原子写入一个事件到 spool 目录，返回文件名。失败会抛出（由调用方兜底）。 */
export function writeSpoolFile(ev: HookEvent): string {
  const name = spoolFileName(ev);
  const final = join(SPOOL_DIR, name);
  const tmp = `${final}.tmp`;
  writeFileSync(tmp, JSON.stringify(ev));
  renameSync(tmp, final); // 同分区原子
  return name;
}

export interface SpoolEntry {
  name: string;
  event: HookEvent;
}

/** 列出 spool 中所有事件，按时间戳升序（回捞按序处理）。解析失败的条目跳过并记录。 */
export function listSpool(onCorrupt?: (name: string, err: unknown) => void): SpoolEntry[] {
  const names = readdirSync(SPOOL_DIR).filter((f) => f.endsWith(".json"));
  const out: SpoolEntry[] = [];
  for (const name of names) {
    try {
      const event = JSON.parse(readFileSync(join(SPOOL_DIR, name), "utf8")) as HookEvent;
      out.push({ name, event });
    } catch (err) {
      onCorrupt?.(name, err);
    }
  }
  return out.sort((a, b) => a.event.timestamp - b.event.timestamp);
}

/** 处理完成后删除 spool 文件（删除即确认）。 */
export function removeSpoolFile(name: string): void {
  try {
    unlinkSync(join(SPOOL_DIR, name));
  } catch {
    /* 已不存在 */
  }
}

/** 当前 spool 积压数（用于运行指标）。 */
export function countSpool(): number {
  try {
    return readdirSync(SPOOL_DIR).filter((f) => f.endsWith(".json")).length;
  } catch {
    return 0;
  }
}
