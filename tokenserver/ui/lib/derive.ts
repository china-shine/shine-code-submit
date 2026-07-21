// 纯格式化 + 路径清洗。聚合(时序/分布/排行/过滤)已下沉后端 /api/stats + /api/member,前端只做展示。
import type { TokenUsage, LinesStat } from "../types";

// ─── 颜色 token(与 TokenWeb App.tsx 一致) ───────────────────────────────────────
export const C = {
  input: "#3B82F6",
  output: "#8B5CF6",
  cache: "#6366F1",
  code: "#14B8A6",
  dur: "#F97316",
  total: "#4F46E5",
};

// ─── 基础数值 ──────────────────────────────────────────────────────────────────
export function rawTotal(u?: TokenUsage | null): number {
  if (!u) return 0;
  return u.input + u.output + u.cacheCreation + u.cacheRead;
}

/** 真实读写 token(input+output,不含缓存读取/写入),用作效率分母。 */
export function inoutTokens(t?: TokenUsage | null): number {
  if (!t) return 0;
  return t.input + t.output;
}

export function lineTotal(l?: LinesStat | null): number {
  if (!l) return 0;
  return l.added + l.deleted + l.modified;
}

// ─── 路径/项目名清洗 ─────────────────────────────────────────────────────────────
// daemon 的 decodeProjectCwd 把 Claude project 目录名(- 编码)解码回 cwd,
// 但 Claude 对中文/特殊字符也编码成 '-',解码后出现连续 '\'。此处合并显示。
export function cleanCwd(cwd?: string | null): string {
  if (!cwd) return "";
  return cwd
    .replace(/[\\/]+/g, "\\") // 连续 \ 或 / 合并成单个 \
    .replace(/\\+$/, "") // 去末尾反斜杠
    .replace(/^([a-z]):/i, (_m, d) => d.toUpperCase() + ":"); // 盘符统一大写
}

/** cleanCwd 后的末 N 段,用 / 连接(跨平台安全)。 */
function pathTail(cwd: string | null | undefined, depth = 1): string {
  if (!cwd) return "";
  const segs = cleanCwd(cwd).split(/[\\/]+/).filter(Boolean);
  if (segs.length === 0) return "";
  return segs.slice(-depth).join("/");
}

/** 项目名可读化:纯数字/单字符名回退到 cwd 末两段;其余原样。 */
export function displayProjectName(name?: string | null, cwd?: string | null): string {
  const base = (name && name.trim()) || pathTail(cwd, 1) || "(未知)";
  if (/^\d+$/.test(base) || base.length <= 1) {
    const two = pathTail(cwd, 2);
    if (two && two.length > 1) return two;
  }
  return base;
}

// ─── 格式化(复制 TokenWeb fmtK/fmtFull 以保视觉一致;fmtDate 沿用 util.ts) ─────────
export function fmtK(n: number): string {
  if (n >= 1_000_000_000) return (n / 1_000_000_000).toFixed(2) + "B"; // B 两位
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + "M"; // M 两位
  if (n >= 1_000) return (n / 1_000).toFixed(1) + "K"; // K 一位
  return n.toString();
}
export function fmtFull(n: number): string {
  return n.toLocaleString("zh-CN");
}

/** 时长格式化:<1min→"<1m";<1h→"Xm";≥1h→"Xh Ym"。传入的是 gap-aware 估算值(ms),非精确墙钟跨度。 */
export function fmtDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "0m";
  const totalMin = Math.floor(ms / 60000);
  if (totalMin < 1) return "<1m";
  if (totalMin < 60) return `${totalMin}m`;
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}
