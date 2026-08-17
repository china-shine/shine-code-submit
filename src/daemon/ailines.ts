// AI 行集合 + 会话行数提取:从 transcript 的 tool_use(Edit/Write/MultiEdit)还原
// "AI 写过哪些内容的行"(行内容集合,供 AI 占比与 git diff 求交)与 added/deleted/modified 行数。
// 换源背景(2026-08-17):原数据源 events 表 PostToolUse structuredPatch 已随停用退场——
// 重新审视发现占比匹配按「(文件, 行内容)」而非行号(getProjectAILines 存内容字符串),
// transcript 的 new_string/old_string/content 恰好就是这些内容,整行编辑完全等价。
// 关键机制:
//   - 失败编辑延迟判定:tool_use 先挂 pending,同 id 的 tool_result 到达且 !is_error 才计入
//     (is_error 丢弃);跨 tick 由持久化 state 承载 pending。
//   - replay 去重:tool_use 按块 id 去重(最近 SEEN_CAP 个),防 transcript 重放行翻倍。
//   - 行数口径与原 countPatchLines 等价:每次编辑 plus=新内容行数、minus=旧内容行数,
//     modified=min(plus,minus)、added=plus-m、deleted=minus-m。
// 父+子代理文件都解析(consumer 逐文件喂入,合并进同一 session state)。
import { isTrivialLine } from "./lines";

const SEEN_CAP = 2000; // 已处理 tool_use id 上限(防重放翻倍;超出丢最旧,极老的重放概率≈0)

/** 未判定成败的编辑(等 tool_result 落地)。 */
interface PendingEdit {
  id: string;
  file: string; // 原始 file_path(读取时按项目 cwd normRelPath)
  plus: string[]; // 新增行内容(非平凡)
  minus: string[]; // 删除行内容(非平凡)
  plusN: number; // 行数(含平凡行,计数口径)
  minusN: number;
}

export interface AiLinesState {
  cwd: string | null; // 首条 cwd(first-wins,同 signals;cd 子目录不覆盖)
  firstAt: number;
  lastAt: number;
  lines: { added: number; deleted: number; modified: number };
  aiAdded: Record<string, string[]>; // file_path → 行内容(非平凡、去重)
  aiDeleted: Record<string, string[]>;
  pending: PendingEdit[]; // 未闭环的 tool_use(等 tool_result)
  seen: string[]; // 已处理 tool_use id(环形,防重放)
}

export function emptyAiLines(): AiLinesState {
  return { cwd: null, firstAt: 0, lastAt: 0, lines: { added: 0, deleted: 0, modified: 0 }, aiAdded: {}, aiDeleted: {}, pending: [], seen: [] };
}

/** blob → state;损坏/形状不对返回 null(调用方全量回填)。 */
export function parseAiLinesBlob(blob: string | null | undefined): AiLinesState | null {
  if (!blob) return null;
  try {
    const o = JSON.parse(blob);
    if (!o || typeof o !== "object" || typeof o.lines !== "object" || typeof o.aiAdded !== "object" || !Array.isArray(o.pending) || !Array.isArray(o.seen)) return null;
    return o as AiLinesState;
  } catch {
    return null;
  }
}

export function serializeAiLines(state: AiLinesState): string {
  return JSON.stringify(state);
}

const CODE_TOOLS = new Set(["Edit", "Write", "MultiEdit"]);

/** 行级公共前后缀裁剪:old/new 共享的整行(编辑锚点上下文)不计变更——
 *  与 structuredPatch 的 context 合并语义对齐(old/new 各自多算会把锚点行虚报成 modified)。 */
function diffLines(oldS: unknown, newS: unknown): { plus: string[]; minus: string[] } {
  const a = typeof oldS === "string" && oldS ? oldS.split("\n") : [];
  const b = typeof newS === "string" && newS ? newS.split("\n") : [];
  let p = 0;
  while (p < a.length && p < b.length && a[p] === b[p]) p++;
  let s = 0;
  while (s < a.length - p && s < b.length - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++;
  return { plus: b.slice(p, b.length - s), minus: a.slice(p, a.length - s) };
}

function pushUnique(arr: string[], v: string, cap = 20_000): void {
  if (arr.length < cap && !arr.includes(v)) arr.push(v);
}

function tsOf(obj: Record<string, unknown>): number {
  const v = obj.timestamp;
  const n = typeof v === "string" ? Date.parse(v) : typeof v === "number" ? v : NaN;
  return Number.isFinite(n) ? n : 0;
}

/** 逐行更新 state(增量安全;返回同一引用)。 */
export function parseAiLinesEvents(raw: string, state: AiLinesState): AiLinesState {
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let ev: Record<string, unknown>;
    try {
      ev = JSON.parse(line);
    } catch {
      continue;
    }
    const ts = tsOf(ev);
    if (ts && !state.firstAt) state.firstAt = ts;
    if (typeof ev.cwd === "string" && ev.cwd && !state.cwd) state.cwd = ev.cwd; // first-wins

    const message = ev.message as Record<string, unknown> | undefined;
    if (!message) continue;

    // user 行:tool_result 判定 pending 成败
    if (message.role === "user" && Array.isArray(message.content)) {
      for (const b of message.content) {
        const block = b as Record<string, unknown>;
        if (!block || block.type !== "tool_result" || typeof block.tool_use_id !== "string") continue;
        const idx = state.pending.findIndex((p) => p.id === block.tool_use_id);
        if (idx < 0) continue; // 老pending(状态重建前)或非编辑工具,忽略
        const p = state.pending[idx]!;
        state.pending.splice(idx, 1);
        if (block.is_error === true) continue; // 失败编辑:丢弃
        commitEdit(state, p);
      }
      continue;
    }

    if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
    for (const b of message.content) {
      const block = b as Record<string, unknown>;
      if (!block || block.type !== "tool_use") continue;
      const name = typeof block.name === "string" ? block.name : "";
      if (!CODE_TOOLS.has(name)) continue;
      const id = typeof block.id === "string" ? block.id : "";
      if (!id || state.seen.includes(id)) continue; // 重放/重复,跳过
      state.seen.push(id);
      if (state.seen.length > SEEN_CAP) state.seen.shift();
      const input = (block.input ?? {}) as Record<string, unknown>;
      const file = typeof input.file_path === "string" ? input.file_path : "";
      if (!file) continue;
      const plus: string[] = [];
      const minus: string[] = [];
      if (name === "Write") {
        // 新建文件:content 全计 added(对齐 countNewFileLines)
        if (typeof input.content === "string" && input.content) plus.push(...input.content.split("\n"));
      } else if (name === "Edit") {
        const d = diffLines(input.old_string, input.new_string);
        plus.push(...d.plus);
        minus.push(...d.minus);
      } else if (Array.isArray(input.edits)) {
        for (const e of input.edits as Array<Record<string, unknown>>) {
          const d = diffLines(e.old_string, e.new_string);
          plus.push(...d.plus);
          minus.push(...d.minus);
        }
      }
      state.pending.push({ id, file, plus, minus, plusN: plus.length, minusN: minus.length });
    }
  }
  return state;
}

/** 成功编辑落地:行数(min 配对口径)+ 行内容集合(非平凡行)。 */
function commitEdit(state: AiLinesState, p: PendingEdit): void {
  const m = Math.min(p.plusN, p.minusN);
  state.lines.added += p.plusN - m;
  state.lines.deleted += p.minusN - m;
  state.lines.modified += m;
  let a = state.aiAdded[p.file];
  if (!a) a = state.aiAdded[p.file] = [];
  for (const l of p.plus) if (!isTrivialLine(l)) pushUnique(a, l);
  let d = state.aiDeleted[p.file];
  if (!d) d = state.aiDeleted[p.file] = [];
  for (const l of p.minus) if (!isTrivialLine(l)) pushUnique(d, l);
}

/** 是否为全空状态(不落盘,防 0 字节 transcript 产生空文件残留)。 */
export function isEmptyAiLines(state: AiLinesState): boolean {
  return (
    state.lines.added + state.lines.deleted + state.lines.modified === 0 &&
    Object.keys(state.aiAdded).length === 0 &&
    Object.keys(state.aiDeleted).length === 0 &&
    state.pending.length === 0 &&
    !state.cwd
  );
}
