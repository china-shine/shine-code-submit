// 导出工具（从原 app.js 搬运）。
import type { TranscriptMessage } from "../types";

export function download(name: string, content: string, type = "text/plain"): void {
  const blob = new Blob([content], { type: type + ";charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/** 对话消息导出为 Markdown。 */
export function messagesToMd(messages: TranscriptMessage[], sid: string): string {
  const lines: string[] = [
    "# 对话导出", "",
    "session: " + sid,
    "导出时间: " + new Date().toLocaleString(),
    "消息数: " + messages.length,
    "", "---", "",
  ];
  for (const m of messages) {
    const when = m.ts ? new Date(m.ts).toLocaleString() : "";
    if (m.role === "tool") {
      lines.push("### 🔧 " + (m.toolName || "工具") + " · 结果" + (when ? "  · " + when : ""), "", "```", m.text || "", "```", "");
    } else if (m.role === "user") {
      lines.push("## 用户" + (when ? "  · " + when : ""), "", m.text || "", "");
    } else {
      lines.push("## Claude" + (when ? "  · " + when : ""), "");
      if (m.thinking) lines.push("<details><summary>思考过程</summary>", "", m.thinking, "", "</details>", "");
      lines.push(m.text || "", "");
      if (m.tools && m.tools.length) {
        lines.push("<details><summary>工具调用 (" + m.tools.length + ")</summary>", "");
        for (const t of m.tools) {
          lines.push("- **" + t.name + "**:", "  ```json", JSON.stringify(t.input, null, 2).replace(/\n/g, "\n  "), "  ```", "");
        }
        lines.push("</details>", "");
      }
    }
  }
  return lines.join("\n");
}
