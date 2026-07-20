// 会话级 token 总量的 mtime 缓存。
// /api/sessions 每 2s 被查看页轮询，逐 session 读 transcript 汇总 usage 会很重。
// 这里按 transcriptPath 缓存「复合 mtime → tokenTotal」：父 transcript + 同目录 subagents/*.jsonl
// 任一文件没变就直接返回，变了才重读重算。冷启动逐步填充，稳态全命中。异常返回 null。
import { statSync } from "node:fs";
import { homedir } from "node:os";
import { sumSessionUsage, sessionTranscriptFiles, readFirstUserText, sessionActiveMs } from "./transcript";
import type { TokenUsage } from "../shared/types";

interface Entry {
  mtimeKey: string;
  total: TokenUsage;
}

const cache = new Map<string, Entry>();

/** 返回某 transcript 的会话级 token 总量（父 + subagents/*.jsonl 归并，对齐 ccusage session 口径）；
 *  带复合 mtime 缓存；读不到/解析失败返回 null。 */
export function getSessionTokenTotal(transcriptPath: string): TokenUsage | null {
  const realPath = transcriptPath.replace(/^~/, homedir());
  const files = sessionTranscriptFiles(realPath);
  if (files.length === 0) return null;
  let mtimeKey: string;
  try {
    mtimeKey = files.map((file) => `${file}:${statSync(file).mtimeMs}`).join("|");
  } catch {
    return null;
  }
  const hit = cache.get(transcriptPath);
  if (hit && hit.mtimeKey === mtimeKey) return hit.total;
  try {
    const total = sumSessionUsage(realPath);
    cache.set(transcriptPath, { mtimeKey, total });
    return total;
  } catch {
    return null;
  }
}

interface TitleEntry {
  mtimeKey: string;
  title: string | null;
}
const titleCache = new Map<string, TitleEntry>();

/** 返回某 transcript 父会话的首条 user 消息(会话标题);带复合 mtime 缓存;读不到返回 null。
 *  只读父 transcript(subagents 不参与标题),与 getSessionTokenTotal 同缓存策略。 */
export function getSessionTitle(transcriptPath: string): string | null {
  const realPath = transcriptPath.replace(/^~/, homedir());
  const files = sessionTranscriptFiles(realPath);
  if (files.length === 0) return null;
  let mtimeKey: string;
  try {
    mtimeKey = files.map((file) => `${file}:${statSync(file).mtimeMs}`).join("|");
  } catch {
    return null;
  }
  const hit = titleCache.get(transcriptPath);
  if (hit && hit.mtimeKey === mtimeKey) return hit.title;
  let title: string | null = null;
  try {
    title = readFirstUserText(realPath);
  } catch {
    title = null;
  }
  titleCache.set(transcriptPath, { mtimeKey, title });
  return title;
}

interface ActiveEntry {
  mtimeKey: string;
  activeMs: number;
}
const activeCache = new Map<string, ActiveEntry>();

/** 返回某 transcript 的会话级 gap-aware 活跃时长（父 + subagents/*.jsonl，对齐 ccusage session 口径）；
 *  带复合 mtime 缓存（与 getSessionTokenTotal 同策略）；读不到/解析失败返回 0。 */
export function getSessionActiveMs(transcriptPath: string): number {
  const realPath = transcriptPath.replace(/^~/, homedir());
  const files = sessionTranscriptFiles(realPath);
  if (files.length === 0) return 0;
  let mtimeKey: string;
  try {
    mtimeKey = files.map((file) => `${file}:${statSync(file).mtimeMs}`).join("|");
  } catch {
    return 0;
  }
  const hit = activeCache.get(transcriptPath);
  if (hit && hit.mtimeKey === mtimeKey) return hit.activeMs;
  let activeMs = 0;
  try {
    activeMs = sessionActiveMs(realPath);
  } catch {
    activeMs = 0;
  }
  activeCache.set(transcriptPath, { mtimeKey, activeMs });
  return activeMs;
}
