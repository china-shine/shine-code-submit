// 会话级代码变更行数统计 + 项目 AI 行集合。
// 数据源(2026-08-17 终局):DATA_DIR/ailines 文件(transcript 的 Edit/Write/MultiEdit 提取,见 ailines.ts/
// ailines-store.ts)——原 events 表 PostToolUse structuredPatch 已停用;行数口径等价(min(plus,minus) 配对),
// AI 集合按 (文件, 行内容) 匹配(与 git diff 内容求交,非行号)。
// 按 sessionId + lastActive 缓存(仿 token-cache),lastActive 不变命中,避免查看页轮询重复读文件。
import { relative } from "node:path";
import { GIT_CACHE_TTL_MS } from "../shared/config";
import type { Store } from "./store";
import type { LinesStat } from "../shared/types";
import { readSessionAiLines, readProjectAiLines } from "./ailines-store";

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
 * 读会话的 ailines 文件(transcript 提取;父+子代理全量,口径=原 structuredPatch 的 min 配对)。
 * 查不到(未回填的老会话/纯沟通会话)返回 **null**——"无数据"≠"零行",
 * 上报 null 让 tokenserver COALESCE 保留旧值,防全量校准清零历史(2026-08-17)。
 */
export function getSessionLines(store: Store, sessionId: string, lastActive: number): LinesStat | null {
  const hit = cache.get(sessionId);
  if (hit && hit.lastActive === lastActive) return hit.stat;
  try {
    const row = store.getTranscriptSession(sessionId);
    if (!row) return null;
    const st = readSessionAiLines(row.project_id, sessionId);
    if (!st) return null;
    cache.set(sessionId, { lastActive, stat: st.lines });
    return st.lines;
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
 *  读该 cwd 全部会话的 ailines 文件(transcript 提取,父+子代理),union 新增行(+ 新内容)与
 *  删除行(- 旧内容)为同一集合——与原 events 版语义一致(addedLines/deletedLines 各自对该集合求交)。
 *  项目级 TTL 缓存(GIT_CACHE_TTL_MS)。 */
export function getProjectAILines(store: Store, cwd: string): Map<string, Set<string>> {
  const hit = aiLinesCache.get(cwd);
  if (hit && Date.now() - hit.at < GIT_CACHE_TTL_MS) return hit.lines;
  const { added, deleted } = readProjectAiLines(cwd);
  for (const [k, s] of deleted) {
    const t = added.get(k);
    if (t) for (const l of s) t.add(l);
    else added.set(k, s);
  }
  aiLinesCache.set(cwd, { at: Date.now(), lines: added });
  return added;
}
