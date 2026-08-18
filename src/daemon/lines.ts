// 会话级代码变更行数统计:从 PostToolUse 事件的 tool_response.structuredPatch 数 +/- 行。
// added 纯增 / deleted 纯删 / modified 一删一加配对(min(plus,minus)),三者不重复。
// 按 sessionId + lastActive 缓存(仿 token-cache),lastActive 不变命中,避免查看页轮询重复查 DB。
import { relative } from "node:path";
import { GIT_CACHE_TTL_MS } from "../shared/config";
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
 * 新建文件(structuredPatch 空)回退 tool_input.content 行数。
 * 查不到事件(被 7 天修剪的老会话/纯沟通会话)返回 **null**——"无数据"≠"零行",
 * 上报 null 让 tokenserver COALESCE 保留旧值,防全量校准清零历史(2026-08-17)。
 */
export function getSessionLines(store: Store, sessionId: string, lastActive: number): LinesStat | null {
  const hit = cache.get(sessionId);
  if (hit && hit.lastActive === lastActive) return hit.stat;
  try {
    const events = store.query({ sessionId, type: "PostToolUse", limit: 2000 });
    if (events.length === 0) return null; // 无事件=无数据,不计为零
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

/** 规范化文件路径:绝对路径转相对 cwd,统一分隔符为 /,小写(Win 大小写不敏感)。
 *  用于对齐 AI 的 tool_input.file_path(绝对)与 git 的 path(相对 cwd),供行级匹配查表。 */
export function normRelPath(cwd: string, p: string): string {
  let rel = p;
  if (/^(?:[A-Za-z]:[\\/]|[\\/])/.test(p)) {
    try {
      const r = relative(cwd, p);
      if (r) rel = r;
    } catch {
      /* relative 失败保留原值 */
    }
  }
  return rel.split(/[\\/]/).join("/").toLowerCase();
}

interface AiLinesCacheEntry { at: number; lines: Map<string, Set<string>>; }
const aiLinesCache = new Map<string, AiLinesCacheEntry>();

/** 无信息量行(空行/纯括号分号等):不含任何字母/数字/中文。
 *  行级 AI 匹配把这些行排除在 AI 行集合外——否则任何 commit 里的空行/惯用行(`}` `);`)都会
 *  命中 set.has(l),aiAdded 系统性虚高、占比失真。 */
export function isTrivialLine(l: string): boolean {
  return !/[\p{L}\p{N}]/u.test(l);
}

/** 提取某项目"AI 写过的所有行内容"(按规范化文件路径分组),供 buildProjectDetail 行级匹配 commit added 行。
 *  全量扫描 PostToolUse(Edit/Write/MultiEdit/NotebookEdit),**不限事件 cwd**——会话在子目录里跑时 hook
 *  记录的 cwd 是子目录,按项目 cwd 精确等值查会整段漏掉这些编辑(2026-08-18 实测吃掉 ~40 个百分点占比);
 *  改为按 file_path 是否落在项目内(normRelPath 不逃逸 ../)判定归属。取 structuredPatch 的 + 行(去前缀);
 *  Write 新建文件(patch 空)fallback tool_input.content 全文行。分页突破 query 的 2000 cap。
 *  项目级 TTL 缓存(GIT_CACHE_TTL_MS)。 */
export function getProjectAILines(store: Store, cwd: string): Map<string, Set<string>> {
  const hit = aiLinesCache.get(cwd);
  if (hit && Date.now() - hit.at < GIT_CACHE_TTL_MS) return hit.lines;
  const aiLines = new Map<string, Set<string>>();
  const PAGE = 2000;
  let offset = 0;
  for (;;) {
    const events = store.query({ type: "PostToolUse", limit: PAGE, offset });
    if (events.length === 0) break;
    for (const ev of events) {
      const p = ev.payload as Record<string, unknown> | null;
      if (!p) continue;
      const toolName = typeof p.tool_name === "string" ? p.tool_name : "";
      if (!CODE_TOOLS.has(toolName)) continue;
      const input = (p.tool_input as Record<string, unknown> | null | undefined) ?? undefined;
      const fp = input?.file_path ?? input?.notebook_path;
      if (typeof fp !== "string" || !fp) continue;
      const np = normRelPath(cwd, fp);
      if (np === ".." || np.startsWith("../")) continue; // file_path 在项目外(其它仓库/无关目录),不入集合
      let set = aiLines.get(np);
      if (!set) {
        set = new Set();
        aiLines.set(np, set);
      }
      const resp = p.tool_response as Record<string, unknown> | null | undefined;
      const patch = resp?.structuredPatch as Patch;
      if (Array.isArray(patch) && patch.length > 0) {
        for (const hunk of patch) {
          const ls = hunk?.lines;
          if (!Array.isArray(ls)) continue;
          for (const l of ls) {
            if (typeof l === "string") {
              if (l.startsWith("+") && !l.startsWith("+++")) {
                const c = l.slice(1);
                if (!isTrivialLine(c)) set.add(c); // 空行/纯括号等无信息量行不入集合(防 aiAdded 虚高)
              } else if (l.startsWith("-") && !l.startsWith("---")) {
                const c = l.slice(1);
                if (!isTrivialLine(c)) set.add(c);
              }
            }
          }
        }
      } else if (typeof input?.content === "string") {
        // Write 新建文件:patch 空,fallback content 全文行
        for (const l of input.content.split("\n")) {
          if (!isTrivialLine(l)) set.add(l);
        }
      }
    }
    if (events.length < PAGE) break;
    offset += PAGE;
  }
  aiLinesCache.set(cwd, { at: Date.now(), lines: aiLines });
  return aiLines;
}
