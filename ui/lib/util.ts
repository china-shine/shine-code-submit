// 字符串 / 格式工具（从原 app.js 搬运，改 TS 签名）。
import type { TokenUsage, TranscriptMessage } from "../types";

const HTML_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

export function escapeHtml(s: unknown): string {
  return String(s).replace(/[&<>"']/g, (c) => HTML_ESCAPES[c] ?? c);
}

export function fmtTime(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleTimeString() + "." + String(d.getMilliseconds()).padStart(3, "0");
}

/** 带日期的时间（提交跨天，需日期）：MM-DD HH:MM。 */
export function fmtDateTime(ts: number): string {
  const d = new Date(ts);
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const mi = String(d.getMinutes()).padStart(2, "0");
  return `${mm}-${dd} ${hh}:${mi}`;
}

export function brief(s: unknown, n = 80): string {
  const t = String(s).replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n) + "…" : t;
}

export function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}

/** 紧凑数字：1234 → "1.2k"，1234567 → "1.2M"，1.03e9 → "1B"，<1000 原样。 */
export function fmtTokens(n: number): string {
  if (!Number.isFinite(n) || n < 1000) return String(n);
  if (n < 1_000_000) return trimZero((n / 1_000).toFixed(1)) + "k";
  if (n < 1_000_000_000) return trimZero((n / 1_000_000).toFixed(1)) + "M";
  if (n < 1_000_000_000_000) return trimZero((n / 1_000_000_000).toFixed(2)) + "B";
  return trimZero((n / 1_000_000_000_000).toFixed(2)) + "T";
}

/** 原始 token 总量 = input + output + cacheCreation + cacheRead（= ccusage totalTokens，四字段原始全量，不加权）。 */
export function rawTotal(u?: TokenUsage | null): number {
  if (!u) return 0;
  return u.input + u.output + u.cacheCreation + u.cacheRead;
}

/** token 用量简写：↑输入 ↓输出（原始值）。无值返回空串。 */
export function fmtUsage(u?: TokenUsage | null): string {
  if (!u) return "";
  return `↑${fmtTokens(u.input)} ↓${fmtTokens(u.output)}`;
}

/** token 用量三段式：↑输入 ↓输出 · 总数(原始四字段和)。报表/会话导航与详情用。 */
export function fmtUsageTotal(u?: TokenUsage | null): string {
  if (!u) return "";
  return `↑${fmtTokens(u.input)} ↓${fmtTokens(u.output)} · ${fmtTokens(rawTotal(u))}`;
}

/** 完整 token 用量，用于 title 提示：总数 + 输入/输出 + 缓存写/缓存读（均原始值）。 */
export function fmtUsageFull(u?: TokenUsage | null): string {
  if (!u) return "";
  return `总数 ${rawTotal(u)} · 输入 ${u.input} · 输出 ${u.output} · 缓存写 ${u.cacheCreation} · 缓存读 ${u.cacheRead}`;
}

/** token 用量带标签：输入 X · 输出 Y · 总数 Z(原始四字段和)。会话详情/报表标题用。 */
export function fmtUsageLabeled(u?: TokenUsage | null): string {
  if (!u) return "";
  return `输入 ${fmtTokens(u.input)} · 输出 ${fmtTokens(u.output)} · 总数 ${fmtTokens(rawTotal(u))}`;
}

function trimZero(s: string): string {
  return s.replace(/\.?0+$/, "");
}

/** 累加 assistant 消息的 usage（对话视图会话级汇总）。 */
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

/** 累加若干 TokenUsage（可为 null/undefined，如未被 enrich 的旧会话），返回总量与有效条数。
 *  顶栏全局 token 用：sessions 里仅最近 N 个有 tokenTotal，count 反映实际覆盖的会话数。 */
export function sumTokenUsage(
  usages: (TokenUsage | null | undefined)[],
): { total: TokenUsage; count: number } {
  const total: TokenUsage = { input: 0, output: 0, cacheCreation: 0, cacheRead: 0 };
  let count = 0;
  for (const u of usages) {
    if (u) {
      total.input += u.input;
      total.output += u.output;
      total.cacheCreation += u.cacheCreation;
      total.cacheRead += u.cacheRead;
      count++;
    }
  }
  return { total, count };
}

/** 路径取末段作项目名（汇总页显示用）："/a/b/shine-code-submit" → "shine-code-submit"。 */
export function shortDir(p: string): string {
  if (!p) return "";
  const t = p.replace(/[\\/]+$/, "");
  const i = Math.max(t.lastIndexOf("/"), t.lastIndexOf("\\"));
  return i >= 0 ? t.slice(i + 1) : t;
}
