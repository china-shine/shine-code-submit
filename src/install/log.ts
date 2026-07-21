// 安装器统一日志：支持 --silent（自动更新后台升级用）。
// info = 进度提示，silent 时整体丢弃（不进窗、不进文件）。
// warn = 诊断信息（非致命警告 / 致命错误），silent 时改写 LOG_DIR/install.log 保留诊断、不抛窗；
//        非 silent 时正常打 stderr/stdout。
// 设计目的：自动更新 spawn 起的安装器即使意外拿到控制台，也不会再喷一坨日志（error.png 那样）。
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { LOG_DIR } from "../shared/paths";

let SILENT = false;

export function setSilent(b: boolean): void {
  SILENT = b;
}

export function isSilent(): boolean {
  return SILENT;
}

/** 进度提示。silent 时直接丢弃。 */
export function info(msg: string): void {
  if (SILENT) return;
  console.log(msg);
}

/** 诊断（警告 / 致命错误）。silent 时落 install.log，否则打 stderr。 */
export function warn(msg: string): void {
  if (!SILENT) {
    console.error(msg);
    return;
  }
  try {
    mkdirSync(LOG_DIR, { recursive: true });
    appendFileSync(join(LOG_DIR, "install.log"), `[${new Date().toISOString()}] ${msg}\n`, "utf8");
  } catch {
    /* 连日志都写不进去就彻底静默——绝不抛窗 */
  }
}
