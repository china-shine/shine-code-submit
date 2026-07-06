// 解析 Claude Code transcript jsonl（~/.claude/projects/<project>/<session>.jsonl）为对话消息。
// 用于「对话视图」：完整还原用户提问 + Claude 回复 + 工具调用。
// （事件流里若 Stop 未采集，这里仍能拿到完整记录，因为 transcript 由 Claude Code 自己持续写入。）
// assistant 消息额外提取 message.usage（token 用量），供对话明细与会话级汇总。
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
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
