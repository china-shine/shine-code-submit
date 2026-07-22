// 会话级 transcript 信息的 mtime bundle 缓存。
// /api/sessions 高频被查看页轮询，逐 session 读 transcript 汇总 usage/title/cwd/activeMs 会很重。
// 原先 token/title/cwd/activeMs 是 4 套独立缓存，同一批文件被 statSync 4 遍判命中。
// 现合并为 1 套：按 transcriptPath 缓存「复合 mtime → 4 字段 bundle」，一次 stat 判命中、miss 时一次性算全 4 字段。
// 调用方（claude-scan）对每文件只调一次 getSessionInfo 取多字段，省 3/4 stat。冷启动逐步填充，稳态全命中。异常返回 null。
import { statSync } from "node:fs";
import { homedir } from "node:os";
import { sumSessionUsage, sessionTranscriptFiles, readFirstUserText, readFirstCwd, sessionActiveMs } from "./transcript";
import type { TokenUsage } from "../shared/types";

interface SessionInfo {
  mtimeKey: string;
  tokenTotal: TokenUsage | null;
  title: string | null;
  cwd: string | null;
  activeMs: number;
}

const infoCache = new Map<string, SessionInfo>();

/** 返回某 transcript 的会话级信息 bundle：token(父+subagents 归并,对齐 ccusage session) / 首条 user 标题 / 真实 cwd / gap-aware 时长。
 *  一次 sessionTranscriptFiles + 一次 stat 拼 mtimeKey 判命中；miss 时一次性算全 4 字段入缓存(各字段失败各自为 null/0,仍入缓存避免重算)。
 *  transcript.ts 底层算法不动 → token 字节级不变。读不到(stat 失败/无文件)返回 null。 */
export function getSessionInfo(transcriptPath: string): SessionInfo | null {
  const realPath = transcriptPath.replace(/^~/, homedir());
  const files = sessionTranscriptFiles(realPath);
  if (files.length === 0) return null;
  let mtimeKey: string;
  try {
    mtimeKey = files.map((file) => `${file}:${statSync(file).mtimeMs}`).join("|");
  } catch {
    return null;
  }
  const hit = infoCache.get(transcriptPath);
  if (hit && hit.mtimeKey === mtimeKey) return hit;

  let tokenTotal: TokenUsage | null = null;
  let title: string | null = null;
  let cwd: string | null = null;
  let activeMs = 0;
  try { tokenTotal = sumSessionUsage(realPath); } catch { /* usage 算失败留 null */ }
  try { title = readFirstUserText(realPath); } catch { /* 标题读失败留 null */ }
  try { cwd = readFirstCwd(realPath); } catch { /* cwd 读失败留 null */ }
  try { activeMs = sessionActiveMs(realPath); } catch { /* 时长算失败留 0 */ }

  const info: SessionInfo = { mtimeKey, tokenTotal, title, cwd, activeMs };
  infoCache.set(transcriptPath, info);
  return info;
}

// 4 个旧导出名保留为瘦封装（向后兼容）。调用方如需多字段，请直接用 getSessionInfo 一次取，避免重复 stat 判命中。
export function getSessionTokenTotal(transcriptPath: string): TokenUsage | null {
  return getSessionInfo(transcriptPath)?.tokenTotal ?? null;
}
export function getSessionTitle(transcriptPath: string): string | null {
  return getSessionInfo(transcriptPath)?.title ?? null;
}
export function getSessionCwd(transcriptPath: string): string | null {
  return getSessionInfo(transcriptPath)?.cwd ?? null;
}
export function getSessionActiveMs(transcriptPath: string): number {
  return getSessionInfo(transcriptPath)?.activeMs ?? 0;
}
