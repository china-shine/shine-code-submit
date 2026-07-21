// JSON 安全读写:读损坏时备份后用默认值(绝不覆盖);写时 tmp+rename 原子,首次写备份。
// 改用户 ~/.claude 下的 JSON 全走这套,防止 install 脚本 bug 损坏 claude 配置。
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { warn } from "./log";

/** 读 JSON;文件不存在/读失败返回默认;JSON 损坏则备份后返回默认(绝不覆盖原文件)。 */
export function readJsonDefault<T>(file: string, def: T): T {
  if (!existsSync(file)) return def;
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return def;
  }
  try {
    return JSON.parse(raw) as T;
  } catch {
    const bak = `${file}.bak-corrupt-${Date.now()}`;
    try {
      copyFileSync(file, bak);
      warn(`[shine-code-submit] WARNING: ${file} JSON 损坏,已备份到 ${bak},用默认值继续`);
    } catch {
      /* 备份失败也继续 */
    }
    return def;
  }
}

/** 原子写 JSON:首次写时把原文件备份到 .bak-pre-install,写 .tmp 再 rename(同卷 rename 原子)。 */
export function writeJsonAtomicWithBackup(file: string, data: unknown): void {
  const bak = `${file}.bak-pre-install`;
  if (existsSync(file) && !existsSync(bak)) {
    try {
      copyFileSync(file, bak);
    } catch {
      /* 备份失败不阻塞写 */
    }
  }
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(data, null, 2), "utf8");
  renameSync(tmp, file);
}
