// 会话级代码变更行数统计:从 PostToolUse 事件的 tool_response.structuredPatch 数 +/- 行。
// added 纯增 / deleted 纯删 / modified 一删一加配对(min(plus,minus)),三者不重复。
// 按 sessionId + lastActive 缓存(仿 token-cache),lastActive 不变命中,避免查看页轮询重复查 DB。
import type { Store } from "./store";
import type { LinesStat } from "../shared/types";

/** structuredPatch 是 hunk 数组,每个 hunk.lines 是带 +/-/空格 前缀的行(JSdiff 格式)。 */
type Patch = Array<{ lines?: unknown[] }> | null | undefined;

const CODE_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
const ZERO: LinesStat = { added: 0, deleted: 0, modified: 0 };

/** 数一个 structuredPatch 的 added/deleted/modified。 */
export function countPatchLines(patch: Patch): LinesStat {
  if (!Array.isArray(patch)) return { ...ZERO };
  let plus = 0;
  let minus = 0;
  for (const hunk of patch) {
    const lines = hunk?.lines;
    if (!Array.isArray(lines)) continue;
    for (const l of lines) {
      if (typeof l !== "string" || !l) continue;
      if (l.startsWith("+")) plus++;
      else if (l.startsWith("-")) minus++;
    }
  }
  const modified = Math.min(plus, minus);
  return { added: plus - modified, deleted: minus - modified, modified };
}

/** 新建文件(structuredPatch 空)回退:用 tool_input.content 行数全计 added。 */
function countNewFileLines(content: unknown): LinesStat {
  if (typeof content !== "string" || !content) return { ...ZERO };
  return { added: content.split("\n").length, deleted: 0, modified: 0 };
}

interface CacheEntry { lastActive: number; stat: LinesStat; }
const cache = new Map<string, CacheEntry>();

/**
 * 返回某 session 的代码变更行数(带 lastActive 缓存)。
 * 查 PostToolUse 事件,遍历 payload.tool_response.structuredPatch 累加(仅 Edit/Write/MultiEdit/NotebookEdit)。
 * 新建文件(structuredPatch 空)回退 tool_input.content 行数。无事件/解析失败返回 null。
 */
export function getSessionLines(store: Store, sessionId: string, lastActive: number): LinesStat | null {
  const hit = cache.get(sessionId);
  if (hit && hit.lastActive === lastActive) return hit.stat;
  try {
    const events = store.query({ sessionId, type: "PostToolUse", limit: 2000 });
    const total: LinesStat = { added: 0, deleted: 0, modified: 0 };
    for (const ev of events) {
      const p = ev.payload as Record<string, unknown> | null;
      if (!p) continue;
      const toolName = typeof p.tool_name === "string" ? p.tool_name : "";
      if (!CODE_TOOLS.has(toolName)) continue;
      const resp = p.tool_response as Record<string, unknown> | null | undefined;
      const patch = resp?.structuredPatch as Patch;
      const stat = Array.isArray(patch) && patch.length > 0
        ? countPatchLines(patch)
        : countNewFileLines((p.tool_input as Record<string, unknown> | null | undefined)?.content);
      total.added += stat.added;
      total.deleted += stat.deleted;
      total.modified += stat.modified;
    }
    cache.set(sessionId, { lastActive, stat: total });
    return total;
  } catch {
    return null;
  }
}

/** 累加若干 LinesStat(可 null/undefined),返回合计。 */
export function sumLines(arr: Array<LinesStat | null | undefined>): LinesStat {
  const t: LinesStat = { added: 0, deleted: 0, modified: 0 };
  for (const u of arr) {
    if (u) {
      t.added += u.added;
      t.deleted += u.deleted;
      t.modified += u.modified;
    }
  }
  return t;
}
