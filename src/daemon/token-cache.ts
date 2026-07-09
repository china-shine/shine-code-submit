// 会话级 token 总量的 mtime 缓存。
// /api/sessions 每 2s 被查看页轮询，逐 session 读 transcript 汇总 usage 会很重。
// 这里按 transcriptPath 缓存「mtime → tokenTotal」：文件没变就直接返回，变了才重读重算。
// 冷启动逐步填充，稳态全命中。任何异常返回 null（不影响 sessions 列表渲染）。
import { statSync } from "node:fs";
import { homedir } from "node:os";
import { sumTranscriptUsage } from "./transcript";
import type { TokenUsage } from "../shared/types";

interface Entry {
  mtimeMs: number;
  total: TokenUsage;
}

const cache = new Map<string, Entry>();

/** 返回某 transcript 的会话级 token 总量（带 mtime 缓存）；读不到/解析失败返回 null。 */
export function getSessionTokenTotal(transcriptPath: string): TokenUsage | null {
  const realPath = transcriptPath.replace(/^~/, homedir());
  let mtimeMs: number;
  try {
    mtimeMs = statSync(realPath).mtimeMs;
  } catch {
    return null;
  }
  const hit = cache.get(transcriptPath);
  if (hit && hit.mtimeMs === mtimeMs) return hit.total;
  try {
    const total = sumTranscriptUsage(transcriptPath);
    cache.set(transcriptPath, { mtimeMs, total });
    return total;
  } catch {
    return null;
  }
}
