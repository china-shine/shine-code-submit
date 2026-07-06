// 事件摘要 / 详情 / 工具摘要等格式化（从原 app.js 搬运）。
// 返回 HTML 字符串的函数（formatDetail/jsonBlock/textBlock/section/renderContentBlock）
// 在组件里用 dangerouslySetInnerHTML 渲染：内部只产生 span/class 标记，来源数据已 escapeHtml。
import type { HookEvent, Payload } from "../types";
import { brief, escapeHtml, safeJson } from "./util";

/** 事件流一行摘要（工具名 + prompt/回复/工具输入片段）。 */
export function eventSummary(ev: HookEvent): string {
  const p = (ev.payload ?? {}) as Payload;
  const tool = typeof p.tool_name === "string" && p.tool_name ? ` ${p.tool_name}` : "";
  let extra = "";
  if (typeof p.prompt === "string") extra = " " + brief(p.prompt);
  else if (typeof p.last_assistant_message === "string") extra = " " + brief(p.last_assistant_message);
  else if (p.tool_input != null) extra = " " + brief(safeJson(p.tool_input));
  return `${tool}${extra}`;
}

/** 工具调用参数的简短摘要（用于卡片副标题）。 */
export function toolParamSummary(name: string, input: unknown): string {
  const g = (k: string): string => {
    if (input && typeof input === "object") {
      const v = (input as Record<string, unknown>)[k];
      return v != null ? String(v) : "";
    }
    return "";
  };
  switch (name) {
    case "Bash": return g("command");
    case "Read":
    case "Edit":
    case "Write": return g("file_path");
    case "Grep":
    case "Glob": return g("pattern");
    case "WebSearch": return g("query");
    case "WebFetch": return g("url");
    case "TaskCreate": return g("subject") || g("description");
    case "TaskUpdate": return "#" + g("taskId") + " → " + g("status");
    case "TaskGet": return "#" + g("taskId");
    case "TaskList": return "";
    case "Agent": return g("description");
    default: return safeJson(input).slice(0, 80);
  }
}

const TOOL_ICONS: Record<string, string> = {
  Bash: "▶", Read: "📄", Edit: "✎", Write: "✎", Grep: "🔎", Glob: "🗂",
  WebSearch: "🌐", WebFetch: "🌐", TaskCreate: "📌", TaskUpdate: "📌",
  TaskGet: "📌", TaskList: "📌", Agent: "🤖",
};

export function toolIcon(name: string): string {
  return TOOL_ICONS[name] ?? "🛠";
}

// ---- 以下返回 HTML 片段，组件用 dangerouslySetInnerHTML 渲染 ----

export function section(label: string, content: string): string {
  return `<div class="detail-section"><div class="detail-label">${label}</div><div class="detail-content">${content}</div></div>`;
}

export function textBlock(s: string): string {
  return `<div class="detail-text">${escapeHtml(s)}</div>`;
}

export function jsonBlock(v: unknown): string {
  let s = escapeHtml(safeJson(v));
  s = s.replace(/(&quot;.*?&quot;)(\s*:)/g, '<span class="j-key">$1</span>$2');
  s = s.replace(/(:\s*)(&quot;.*?&quot;)(?=[,\n]|$)/g, '$1<span class="j-str">$2</span>');
  s = s.replace(/(:\s*)(-?\d+(?:\.\d+)?)/g, '$1<span class="j-num">$2</span>');
  s = s.replace(/(:\s*)(true|false|null)/g, '$1<span class="j-bool">$2</span>');
  return `<div class="detail-json">${s}</div>`;
}

/** 事件详情面板完整 HTML。 */
export function formatDetail(payload: unknown): string {
  const p = (payload ?? {}) as Payload;
  const parts: string[] = [];
  if (typeof p.prompt === "string") parts.push(section("用户提问", textBlock(p.prompt)));
  if (typeof p.last_assistant_message === "string") parts.push(section("Claude 回复", textBlock(p.last_assistant_message)));
  if (typeof p.tool_name === "string") {
    parts.push(`<div class="detail-section"><div class="detail-label">工具</div><div class="detail-content"><code class="tool-name">${escapeHtml(p.tool_name)}</code></div></div>`);
  }
  if (p.tool_input != null) parts.push(section("工具输入", jsonBlock(p.tool_input)));
  if (p.tool_response != null) parts.push(section("工具结果", jsonBlock(p.tool_response)));
  if (typeof p.reason === "string") parts.push(section("原因", textBlock(p.reason)));
  if (typeof p.source === "string") parts.push(section("来源", textBlock(p.source)));
  if (!parts.length) parts.push(section("原始数据", jsonBlock(payload)));
  return parts.join("");
}

/** Write 工具内容预览（前 50 行）。 */
export function renderContentBlock(content: unknown): string {
  const all = String(content || "").split("\n");
  const shown = all.slice(0, 50);
  const rows = shown.map((l) => `<div class="diff-line ctx"><span class="diff-text">${escapeHtml(l)}</span></div>`);
  if (all.length > shown.length) {
    rows.push(`<div class="diff-folds">⋯ 共 ${all.length} 行，前 ${shown.length} 行</div>`);
  }
  return `<div class="diff-block">${rows.join("")}</div>`;
}
