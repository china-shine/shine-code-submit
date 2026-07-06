import { useMemo } from "react";
import type { ReactNode } from "react";
import { computeLineDiff } from "../lib/diff";
import { renderContentBlock, toolIcon, toolParamSummary } from "../lib/format";
import { safeJson } from "../lib/util";
import { Icon } from "./Icon";
import { DiffBlock } from "./DiffBlock";

interface ToolT {
  name: string;
  input: unknown;
}

/** 工具调用卡片：图标 + 标题 + 副标题 + stat，折叠看 diff / 内容 / json。 */
export function ToolCard({ t }: { t: ToolT }) {
  const name = t.name || "?";
  const input = t.input && typeof t.input === "object" ? (t.input as Record<string, unknown>) : {};
  const g = (k: string): string => (input[k] != null ? String(input[k]) : "");
  const sub = toolParamSummary(name, input).slice(0, 100);

  const { body, stat } = useMemo<{ body: ReactNode; stat: { add: number; del: number } | null }>(() => {
    if (name === "Edit") {
      const diffs = computeLineDiff(g("old_string"), g("new_string"));
      let add = 0;
      let del = 0;
      for (const x of diffs) {
        if (x.op === "add") add++;
        else if (x.op === "del") del++;
      }
      return { body: <DiffBlock diffs={diffs} />, stat: { add, del } };
    }
    if (name === "Write") {
      return {
        body: <div dangerouslySetInnerHTML={{ __html: renderContentBlock(g("content")) }} />,
        stat: null,
      };
    }
    return { body: <pre className="card-output">{safeJson(input)}</pre>, stat: null };
  }, [name, input]);

  return (
    <details className="tool-card">
      <summary className="card-trigger">
        <span className="card-chev"><Icon name="chevron" size={12} /></span>
        <span className="tool-icon">{toolIcon(name)}</span>
        <span className="tool-title">{name}</span>
        <span className="tool-sub">{sub}</span>
        {stat && (
          <span className="tool-stat">
            <span className="s-add">+{stat.add}</span> <span className="s-del">-{stat.del}</span>
          </span>
        )}
      </summary>
      <div className="tool-content">{body}</div>
    </details>
  );
}
