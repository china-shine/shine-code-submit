import type { ReactNode } from "react";
import type { DiffLine } from "../lib/diff";

/** 渲染行级 diff（连续 >3 行 context 折叠为蓝色分隔条）。 */
export function DiffBlock({ diffs }: { diffs: DiffLine[] }) {
  const rows: ReactNode[] = [];
  let ctxBuf: DiffLine[] = [];
  let key = 0;
  const flushCtx = () => {
    if (!ctxBuf.length) return;
    if (ctxBuf.length <= 3) {
      for (const dl of ctxBuf) {
        rows.push(
          <div className="diff-line ctx" key={key++}>
            <span className="diff-text">{dl.text}</span>
          </div>,
        );
      }
    } else {
      const first = ctxBuf[0]!;
      const last = ctxBuf[ctxBuf.length - 1]!;
      rows.push(
        <div className="diff-line ctx" key={key++}>
          <span className="diff-text">{first.text}</span>
        </div>,
      );
      rows.push(
        <div className="diff-folds" key={key++}>
          ⋯ {ctxBuf.length - 2} 行未改
        </div>,
      );
      rows.push(
        <div className="diff-line ctx" key={key++}>
          <span className="diff-text">{last.text}</span>
        </div>,
      );
    }
    ctxBuf = [];
  };
  for (const dl of diffs) {
    if (dl.op === "ctx") {
      ctxBuf.push(dl);
      continue;
    }
    flushCtx();
    if (dl.op === "add") {
      rows.push(
        <div className="diff-line add" key={key++}>
          <span className="diff-sign">+</span>
          <span className="diff-text">{dl.text}</span>
        </div>,
      );
    } else {
      rows.push(
        <div className="diff-line del" key={key++}>
          <span className="diff-sign">-</span>
          <span className="diff-text">{dl.text}</span>
        </div>,
      );
    }
  }
  flushCtx();
  return <div className="diff-block">{rows}</div>;
}
