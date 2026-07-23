// 解析 Claude Code transcript jsonl（~/.claude/projects/<project>/<session>.jsonl）为对话消息。
// 用于「对话视图」：完整还原用户提问 + Claude 回复 + 工具调用。
// （事件流里若 Stop 未采集，这里仍能拿到完整记录，因为 transcript 由 Claude Code 自己持续写入。）
// assistant 消息额外提取 message.usage（token 用量），供对话明细与会话级汇总。
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import type { TokenUsage, TranscriptMessage } from "../shared/types";

// TranscriptMessage 已移至 shared/types（前端 React 也复用同一契约）；此处 re-export 保持向后兼容。
export type { TranscriptMessage };

/** 读 transcript jsonl，解析成对话消息（跳过 thinking、tool_result 等非对话内容）。 */
export function parseTranscript(transcriptPath: string): TranscriptMessage[] {
  const path = transcriptPath.replace(/^~/, homedir());
  if (!existsSync(path)) throw new Error(`transcript not found: ${path}`);
  const lines = readFileSync(path, "utf8").split("\n").filter(Boolean);
  const messages: TranscriptMessage[] = [];
  const toolUseNames = new Map<string, string>(); // tool_use_id -> name，供 tool_result 关联工具名
  for (const line of lines) {
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    const message = obj.message as Record<string, unknown> | undefined;
    if (!message) continue;
    const role = message.role;
    const content = message.content;
    const ts = typeof obj.timestamp === "string"
      ? Date.parse(obj.timestamp)
      : (obj.timestamp as number | undefined);

    if (role === "user") {
      // string = 用户提问；array 多含 tool_result（作为独立「工具结果」消息）+ 可能的 text 段
      if (typeof content === "string") {
        if (content.trim()) messages.push({ role: "user", text: content, tools: [], ts });
      } else if (Array.isArray(content)) {
        const text = content
          .filter((c) => (c as Record<string, unknown>).type === "text")
          .map((c) => (c as Record<string, unknown>).text as string)
          .join("\n");
        if (text) messages.push({ role: "user", text, tools: [], ts });
        for (const c of content) {
          const ce = c as Record<string, unknown>;
          if (ce.type !== "tool_result") continue;
          const rc = ce.content;
          let rText: string;
          if (typeof rc === "string") rText = rc;
          else if (Array.isArray(rc)) {
            rText = rc
              .filter((x) => (x as Record<string, unknown>).type === "text")
              .map((x) => (x as Record<string, unknown>).text as string)
              .join("\n");
          } else rText = "";
          const id = typeof ce.tool_use_id === "string" ? ce.tool_use_id : "";
          messages.push({
            role: "tool",
            text: rText,
            tools: [],
            toolName: id ? toolUseNames.get(id) : undefined,
            isError: ce.is_error === true,
            ts,
          });
        }
      }
    } else if (role === "assistant") {
      const usage = readUsage(message.usage);
      if (Array.isArray(content)) {
        const text = content
          .filter((c) => (c as Record<string, unknown>).type === "text")
          .map((c) => (c as Record<string, unknown>).text as string)
          .join("\n");
        const thinking = content
          .filter((c) => (c as Record<string, unknown>).type === "thinking")
          .map((c) => (c as Record<string, unknown>).thinking as string)
          .join("\n\n");
        const tools = content
          .filter((c) => (c as Record<string, unknown>).type === "tool_use")
          .map((c) => {
            const ce = c as Record<string, unknown>;
            const id = typeof ce.id === "string" ? ce.id : "";
            const name = ce.name as string;
            if (id && name) toolUseNames.set(id, name);
            return { name, input: ce.input };
          });
        if (text || thinking || tools.length)
          messages.push({ role: "assistant", text, thinking, tools, ts, usage });
      }
    }
  }
  return messages;
}

/** 读 transcript,返回首条 user 消息文本(合并多行、去首尾空白、限长 200),作为「会话标题」。
 *  比 sessionId 更可读;只解析前 64 行(首条提问通常在前几行);无 user text 返回 null。 */
export function readFirstUserTextFromText(raw: string): string | null {
  for (const line of raw.split("\n").slice(0, 64)) {
    if (!line.trim()) continue;
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    const message = obj.message as Record<string, unknown> | undefined;
    if (!message || message.role !== "user") continue;
    const content = message.content;
    let text = "";
    if (typeof content === "string") text = content;
    else if (Array.isArray(content)) {
      text = content
        .filter((c) => (c as Record<string, unknown>).type === "text")
        .map((c) => (c as Record<string, unknown>).text as string)
        .join("\n");
    }
    text = text.trim();
    if (!text) continue;
    // 跳过 Claude Code 注入的系统消息(local-command-caveat / command-* 等,以 < 开头的 XML 标签)
    if (text.startsWith("<")) continue;
    return text.replace(/\s+/g, " ").slice(0, 200);
  }
  return null;
}

/** 读 transcript，返回首条 cwd 字段（Claude Code 写入的真实工作目录，无编码损失）。
 *  只解析前 64 行（cwd 通常在首行 summary）；无 cwd 字段返回 null。
 *  供扫描补真实 cwd，替代从项目目录名反推的有损解码（中文/空格/括号被编码成 - 会丢失）。 */
export function readFirstCwdFromText(raw: string): string | null {
  for (const line of raw.split("\n").slice(0, 64)) {
    if (!line.trim()) continue;
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof obj.cwd === "string" && obj.cwd) return obj.cwd;
  }
  return null;
}

/** 从 message.usage（Anthropic 扁平四字段）提取 token 用量；无任何数值字段则 undefined。 */
function readUsage(raw: unknown): TokenUsage | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const u = raw as Record<string, unknown>;
  const num = (k: string): number => {
    const v = u[k];
    return typeof v === "number" && Number.isFinite(v) ? v : 0;
  };
  const has = [
    "input_tokens",
    "output_tokens",
    "cache_creation_input_tokens",
    "cache_read_input_tokens",
  ].some((k) => typeof u[k] === "number");
  if (!has) return undefined;
  return {
    input: num("input_tokens"),
    output: num("output_tokens"),
    cacheCreation: num("cache_creation_input_tokens"),
    cacheRead: num("cache_read_input_tokens"),
  };
}

/** 累加所有 assistant 消息的 usage（会话级 token 总量）；无 usage 则全 0。 */
export function sumUsage(messages: TranscriptMessage[]): TokenUsage {
  const total: TokenUsage = { input: 0, output: 0, cacheCreation: 0, cacheRead: 0 };
  for (const m of messages) {
    if (m.usage) {
      total.input += m.usage.input;
      total.output += m.usage.output;
      total.cacheCreation += m.usage.cacheCreation;
      total.cacheRead += m.usage.cacheRead;
    }
  }
  return total;
}

// ---- 对齐 ccusage 的逐行 token 统计（校验 + message.id/requestId 去重 + cache_creation 细分归并）----
// 参考 ccusage rust/crates/ccusage/src/adapter/claude/mod.rs: read_usage_file 及配套校验/去重函数。

/** ccusage is_unsupported_nullable_field 的等价黑名单：行内这些字段若为 null，整行丢弃。 */
const UNSUPPORTED_NULLABLE_FIELDS = new Set([
  "id",
  "cwd",
  "model",
  "speed",
  "costUSD",
  "version",
  "sessionId",
  "requestId",
  "isApiErrorMessage",
  "cache_read_input_tokens",
  "cache_creation_input_tokens",
]);

/** 等价 ccusage has_unsupported_null_field：行内出现 `"字段":null`（允许 " 与 : 间空白）且字段在黑名单 → true。 */
function hasUnsupportedNullField(line: string): boolean {
  const re = /"([^"]*)"\s*:null/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line)) !== null) {
    const field = m[1];
    if (field != null && UNSUPPORTED_NULLABLE_FIELDS.has(field)) return true;
  }
  return false;
}

/** 等价 ccusage is_semver_prefix：必须是 `数字.数字.数字` 前缀（第二点后至少一位数字）。 */
function isSemverPrefix(value: string): boolean {
  return /^\d+\.\d+\.\d/.test(value);
}

/** 等价 ccusage parse_ts_timestamp 的接受判定：仅接受严格 ISO8601
 * (YYYY-MM-DDTHH:MM:SS[Z|±HH:MM]，或带 .sss 毫秒)，且时分秒范围与日历日合法。
 * 比 Date.parse 严格，避免接受 ccusage 会丢弃的时间戳导致计数分歧。 */
function isValidCcusageTimestamp(value: string): boolean {
  const m =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d{3})?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!m) return false;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const hour = Number(m[4]);
  const minute = Number(m[5]);
  const second = Number(m[6]);
  if (hour > 23 || minute > 59 || second > 59) return false;
  const dt = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  return (
    dt.getUTCFullYear() === year &&
    dt.getUTCMonth() === month - 1 &&
    dt.getUTCDate() === day
  );
}

/** 等价 ccusage is_valid_usage_entry：version 非 semver、或 sessionId/requestId/messageId/model 存在且为空串 → false。 */
function isValidUsageEntry(obj: Record<string, unknown>, message: Record<string, unknown>): boolean {
  const version = obj.version;
  if (version != null && !isSemverPrefix(String(version))) return false;
  if (obj.sessionId != null && obj.sessionId === "") return false;
  if (obj.requestId != null && obj.requestId === "") return false;
  if (message.id != null && message.id === "") return false;
  if (message.model != null && message.model === "") return false;
  return true;
}

function numField(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

export interface UsageDedupeEntry {
  messageId?: string;
  requestId?: string;
  isSidechain: boolean;
  hasSpeed: boolean;
  total: number;
  input: number;
  output: number;
  cacheCreation: number;
  cacheRead: number;
  ts: number; // 行时间戳(Date.parse(obj.timestamp),line 344 已严格校验);供 gap-aware 时长收集
}

function matchesExactKey(
  e: UsageDedupeEntry,
  messageId: string,
  requestId: string | undefined,
): boolean {
  return e.messageId === messageId && e.requestId === requestId;
}

function matchesSidechainKey(
  e: UsageDedupeEntry,
  messageId: string,
  candidateIsSidechain: boolean,
): boolean {
  return e.messageId === messageId && (candidateIsSidechain || e.isSidechain);
}

function addDedupeIndex(map: Map<string, number[]>, key: string, idx: number): void {
  const arr = map.get(key);
  if (arr) {
    if (!arr.includes(idx)) arr.push(idx);
  } else {
    map.set(key, [idx]);
  }
}

/** 等价 ccusage should_replace_deduped_entry：非 sidechain 优先 → total 更大 → 带 speed。 */
function shouldReplaceDedupedEntry(candidate: UsageDedupeEntry, existing: UsageDedupeEntry): boolean {
  if (candidate.isSidechain !== existing.isSidechain) return existing.isSidechain;
  if (candidate.total !== existing.total) return candidate.total > existing.total;
  return candidate.hasSpeed && !existing.hasSpeed;
}

/** 等价 ccusage push_deduped_entry：按 messageId+requestId 精确键去重，sidechain 重放兜底；无 messageId 不去重。 */
function pushDedupedEntry(
  entry: UsageDedupeEntry,
  survivors: UsageDedupeEntry[],
  byExact: Map<string, number[]>,
  byMessage: Map<string, number[]>,
): void {
  const messageId = entry.messageId;
  if (!messageId) {
    survivors.push(entry);
    return;
  }
  const exactKey = messageId + " " + (entry.requestId ?? "");

  let idx = (byExact.get(exactKey) ?? []).find((i) =>
    matchesExactKey(survivors[i]!, messageId, entry.requestId),
  );
  if (idx === undefined) {
    idx = (byMessage.get(messageId) ?? []).find((i) =>
      matchesSidechainKey(survivors[i]!, messageId, entry.isSidechain),
    );
  }

  if (idx !== undefined) {
    if (shouldReplaceDedupedEntry(entry, survivors[idx]!)) {
      survivors[idx] = entry;
      addDedupeIndex(byExact, exactKey, idx);
      addDedupeIndex(byMessage, messageId, idx);
    }
    return;
  }

  const newIdx = survivors.length;
  survivors.push(entry);
  addDedupeIndex(byExact, exactKey, newIdx);
  addDedupeIndex(byMessage, messageId, newIdx);
}

/** 从已读的 transcript 文本解析 usage 条目，返回通过 ccusage 全部门（usage 标记 / null 黑名单 / 解析 /
 * 严格时间戳 / 字段校验 / cache_creation 5m+1h 归并）的条目；未去重。不读文件——调用方 readFileSync 一次后传入,避免同一文件被多字段各读一遍。 */
export function readUsageEntriesFromText(raw: string): UsageDedupeEntry[] {
  const lines = raw.split("\n").filter(Boolean);
  const entries: UsageDedupeEntry[] = [];
  for (const line of lines) {
    if (!line.includes('"usage":{')) continue;
    if (hasUnsupportedNullField(line)) continue;
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    const message = obj.message as Record<string, unknown> | undefined;
    const usage = message?.usage as Record<string, unknown> | undefined;
    if (!message || !usage) continue;
    if (typeof obj.timestamp !== "string" || !isValidCcusageTimestamp(obj.timestamp)) continue;
    if (!isValidUsageEntry(obj, message)) continue;

    const breakdown = usage.cache_creation as Record<string, unknown> | undefined;
    const cacheCreation = breakdown
      ? numField(breakdown.ephemeral_5m_input_tokens) + numField(breakdown.ephemeral_1h_input_tokens)
      : numField(usage.cache_creation_input_tokens);
    const input = numField(usage.input_tokens);
    const output = numField(usage.output_tokens);
    const cacheRead = numField(usage.cache_read_input_tokens);

    entries.push({
      messageId: typeof message.id === "string" ? message.id : undefined,
      requestId: typeof obj.requestId === "string" ? obj.requestId : undefined,
      isSidechain: obj.isSidechain === true,
      hasSpeed: usage.speed != null,
      total: input + output + cacheCreation + cacheRead,
      input,
      output,
      cacheCreation,
      cacheRead,
      ts: Date.parse(obj.timestamp as string),
    });
  }
  return entries;
}

/** survivors 求和（token 四字段）。抽出来供 token 与 activeMs 共用同一次 dedupe 的 survivors。 */
function sumSurvivors(survivors: UsageDedupeEntry[]): TokenUsage {
  const total: TokenUsage = { input: 0, output: 0, cacheCreation: 0, cacheRead: 0 };
  for (const e of survivors) {
    total.input += e.input;
    total.output += e.output;
    total.cacheCreation += e.cacheCreation;
    total.cacheRead += e.cacheRead;
  }
  return total;
}

/** 对条目集合做 ccusage 全局去重（message.id+requestId，含 sidechain 重放兜底）后求和。
 *  去重结果与插入顺序无关（偏好：非 sidechain → total 更大 → 带 speed）。 */
function dedupeAndSum(entries: UsageDedupeEntry[]): TokenUsage {
  const survivors: UsageDedupeEntry[] = [];
  const byExact = new Map<string, number[]>();
  const byMessage = new Map<string, number[]>();
  for (const entry of entries) pushDedupedEntry(entry, survivors, byExact, byMessage);
  return sumSurvivors(survivors);
}

/**
 * 单个 transcript 文件的 token 总量（去重发生在该文件内）。
 * 对齐 ccusage 逐行逻辑；不依赖对话解析，避免漏掉无 text/thinking/tool_use 的 usage 行。
 */
export function sumTranscriptUsage(transcriptPath: string): TokenUsage {
  const path = transcriptPath.replace(/^~/, homedir());
  if (!existsSync(path)) return { input: 0, output: 0, cacheCreation: 0, cacheRead: 0 };
  return dedupeAndSum(readUsageEntriesFromText(readFileSync(path, "utf8")));
}

/** 给定父 transcript 路径，返回实际存在的 [父文件, ...同目录 subagents/*.jsonl]
 *  （对齐 ccusage：subagents/ 下的 jsonl 归并到父 session）。 */
export function sessionTranscriptFiles(parentPath: string): string[] {
  const real = parentPath.replace(/^~/, homedir());
  const files: string[] = [];
  if (existsSync(real)) files.push(real);
  const subagentsDir = join(real.replace(/\.jsonl$/, ""), "subagents");
  if (existsSync(subagentsDir)) {
    let names: string[] = [];
    try {
      names = readdirSync(subagentsDir);
    } catch {
      names = [];
    }
    for (const name of names) {
      if (name.endsWith(".jsonl")) files.push(join(subagentsDir, name));
    }
  }
  return files;
}

/** 读 sessionTranscriptFiles 各文件文本（每个 readFileSync 一次）。供 sumSessionUsage/sessionActiveMs/sessionUsageAndActiveFromRaws 复用。 */
function readTranscriptRaws(parentPath: string): string[] {
  const raws: string[] = [];
  for (const file of sessionTranscriptFiles(parentPath)) {
    try {
      raws.push(readFileSync(file, "utf8"));
    } catch {
      /* 单文件读失败跳过，其余照算 */
    }
  }
  return raws;
}

/** 从已解析的全部 entries(父+子代理合并)一次性算 token + activeMs:一次 ccusage 去重 → survivors 同时求和与 burst。
 *  与 sessionUsageAndActiveFromRaws 共用同一 dedupe 链;供消费者(持久化 entries)直接调,算法逐字节等价。 */
export function sessionUsageAndActiveFromEntries(allEntries: UsageDedupeEntry[]): { tokenTotal: TokenUsage; activeMs: number } {
  const survivors = dedupedSurvivors(allEntries);
  return { tokenTotal: sumSurvivors(survivors), activeMs: activeMsFromSurvivors(survivors) };
}

/** 从已读的多个文件文本(父+子代理)一次性算 token + activeMs:合并 entries → sessionUsageAndActiveFromEntries。
 *  替代分别调 sumSessionUsage + sessionActiveMs(两者各遍历各读各 dedupe)。算法与拆分版逐字节等价。 */
export function sessionUsageAndActiveFromRaws(raws: string[]): { tokenTotal: TokenUsage; activeMs: number } {
  const entries: UsageDedupeEntry[] = [];
  for (const raw of raws) {
    for (const entry of readUsageEntriesFromText(raw)) entries.push(entry);
  }
  return sessionUsageAndActiveFromEntries(entries);
}

/** 分类 transcript 绝对路径:父 / 子代理 / 忽略(泛化 claude-scan parentSessionInfo,供 watcher 用)。
 *  父 = projects/<project>/<session>.jsonl;子代理 = projects/<project>/<session>/subagents/<x>.jsonl(归到父 session)。 */
export type TranscriptPathKind = "parent" | "subagent" | "ignore";
export interface ClassifiedTranscriptPath {
  kind: TranscriptPathKind;
  sessionId: string; // 所属父 session id(子代理→父)
  projectId: string;
  parentPath: string; // 父 transcript 路径(父=自身;子代理=父 .jsonl)
}
export function classifyTranscriptPath(absPath: string): ClassifiedTranscriptPath | null {
  const parts = absPath.split(/[/\\]/);
  const projectsIndex = parts.lastIndexOf("projects");
  if (projectsIndex < 0) return null;
  const rel = parts.slice(projectsIndex + 1);
  if (rel.length < 2) return null;
  const project = rel[0];
  if (!project) return null;
  // 父:projects/<project>/<session>.jsonl
  if (rel.length === 2) {
    const f = rel[1];
    if (f && f.endsWith(".jsonl")) {
      const sessionId = f.replace(/\.jsonl$/, "");
      if (!sessionId) return null;
      return { kind: "parent", sessionId, projectId: project, parentPath: absPath };
    }
    return null;
  }
  // 子代理:projects/<project>/<session>/subagents/<x>.jsonl
  if (rel.length === 4) {
    const sessionDir = rel[1];
    const seg2 = rel[2];
    const seg3 = rel[3];
    if (sessionDir && seg2 === "subagents" && seg3 && seg3.endsWith(".jsonl")) {
      return { kind: "subagent", sessionId: sessionDir, projectId: project, parentPath: dirname(dirname(absPath)) + ".jsonl" };
    }
  }
  return null; // ignore
}

/** 父 session 的 token 总量：父 transcript + 全部 subagents/*.jsonl，跨文件全局去重后求和。
 *  对齐 ccusage 的 session 口径（子代理 transcript 归并到父 session）。瘦封装,走 sessionUsageAndActiveFromRaws。 */
export function sumSessionUsage(parentPath: string): TokenUsage {
  return sessionUsageAndActiveFromRaws(readTranscriptRaws(parentPath)).tokenTotal;
}

// ---- gap-aware 活跃时长（「对话总时长」KPI 数据源）----
// transcript 不落盘 duration（cost.total_duration_ms 是运行时字段），用 message timestamp 序列估算：
// 相邻 gap > GAP_MS 视为用户离开、不计入；每段连续 burst 末尾 +BUFFER_MS 补读/测时间。
// 复用 readUsageEntries 的 ccusage 严格校验 + pushDedupedEntry 的 messageId 去重，口径与 token 一致。
const GAP_MS = 3600_000; // 1h：相邻 timestamp 间隔超过此值视为用户离开
const BUFFER_MS = 600_000; // 10min：每段连续 burst 末尾补的读/测时间（单点 burst 也给 10min，避免「只发一条=0」）

/** 对条目集合做 ccusage 全局去重（message.id+requestId，含 sidechain 重放兜底），返回 survivor 条目本身（未求和）。
 *  与 dedupeAndSum 同语义，但保留条目（含 ts），供 sessionActiveMs 收集时间戳。
 *  注意：必须走 messageId 去重而非 Set(ts) —— 同 messageId 的多行可能 ts 不同（重放/重试），Set 去不掉。 */
function dedupedSurvivors(entries: UsageDedupeEntry[]): UsageDedupeEntry[] {
  const survivors: UsageDedupeEntry[] = [];
  const byExact = new Map<string, number[]>();
  const byMessage = new Map<string, number[]>();
  for (const entry of entries) pushDedupedEntry(entry, survivors, byExact, byMessage);
  return survivors;
}

/** 从 survivors(已去重)算 gap-aware 活跃时长：收集 ts 升序后按 GAP_MS 切 burst 累加。与 token 共用同一次 dedupe 的 survivors。 */
function activeMsFromSurvivors(survivors: UsageDedupeEntry[]): number {
  const ts = survivors
    .map((e) => e.ts)
    .filter((t) => Number.isFinite(t))
    .sort((a, b) => a - b);
  if (ts.length === 0) return 0;
  let active = 0;
  let burstStart = ts[0]!;
  let prev = ts[0]!;
  for (let i = 1; i < ts.length; i++) {
    const cur = ts[i]!;
    if (cur - prev > GAP_MS) {
      active += prev - burstStart + BUFFER_MS;
      burstStart = cur;
    }
    prev = cur;
  }
  active += prev - burstStart + BUFFER_MS; // 末尾 burst（单点时 prev-burstStart=0，得 BUFFER_MS=10min）
  return active;
}

/** 某 session 的 gap-aware 活跃时长（ms）：父 transcript + subagents/*.jsonl 合并（与 token 同口径）。
 *  收集去重后的 timestamp，升序排序后按 GAP_MS 切 burst 累加；空 session 返回 0。瘦封装,走 sessionUsageAndActiveFromRaws。 */
export function sessionActiveMs(parentPath: string): number {
  return sessionUsageAndActiveFromRaws(readTranscriptRaws(parentPath)).activeMs;
}
