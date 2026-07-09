// token 格式化（与 shine-code-submit ui/lib/util.ts 同口径,原始总量 + B 级两位小数）。
import type { TokenUsage } from "../types";

/** 原始 token 总量 = input + output + cacheCreation + cacheRead（= ccusage totalTokens，四字段原始全量）。 */
export function rawTotal(u?: TokenUsage | null): number {
  if (!u) return 0;
  return u.input + u.output + u.cacheCreation + u.cacheRead;
}

function trimZero(s: string): string {
  return s.replace(/\.?0+$/, "");
}

/** 紧凑数字:k/M 一位小数,B/T 两位小数。 */
export function fmtTokens(n: number): string {
  if (!Number.isFinite(n) || n < 1000) return String(n);
  if (n < 1e6) return trimZero((n / 1e3).toFixed(1)) + "k";
  if (n < 1e9) return trimZero((n / 1e6).toFixed(1)) + "M";
  if (n < 1e12) return trimZero((n / 1e9).toFixed(2)) + "B";
  return trimZero((n / 1e12).toFixed(2)) + "T";
}

/** 带标签三段式:输入 X · 输出 Y · 总数 Z(原始四字段和)。 */
export function fmtLabeled(u?: TokenUsage | null): string {
  if (!u) return "—";
  return `输入 ${fmtTokens(u.input)} · 输出 ${fmtTokens(u.output)} · 总数 ${fmtTokens(rawTotal(u))}`;
}

export function fmtTotal(u?: TokenUsage | null): string {
  return u ? fmtTokens(rawTotal(u)) : "0";
}

export function fmtDate(ts: number): string {
  const d = new Date(ts);
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const mi = String(d.getMinutes()).padStart(2, "0");
  return `${mm}-${dd} ${hh}:${mi}`;
}
