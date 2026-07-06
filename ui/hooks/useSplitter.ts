import { useCallback, useRef } from "react";
import type { MouseEvent as ReactMouseEvent } from "react";

/** 可拖拽分隔条：mousedown 后改 CSS 变量。
 *  orient=v 改 varName（默认 --nav-w 导航宽）；会话/事件树传 "--tree-w"。
 *  orient=h 改 --footer-h（底部日志高，已弃用但保留兼容）。 */
export function useSplitter(orient: "v" | "h", varName?: string) {
  const ref = useRef<HTMLDivElement>(null);
  const onMouseDown = useCallback(
    (e: ReactMouseEvent<HTMLDivElement>) => {
      e.preventDefault();
      const el = ref.current;
      if (!el) return;
      el.classList.add("dragging");
      document.body.style.cursor = orient === "v" ? "col-resize" : "row-resize";
      document.body.style.userSelect = "none";
      const startX = e.clientX;
      const startY = e.clientY;
      const root = document.documentElement;
      const wVar = orient === "v" ? varName ?? "--nav-w" : "--footer-h";
      const startW = parseFloat(getComputedStyle(root).getPropertyValue(wVar)) || 200;
      const startH = parseFloat(getComputedStyle(root).getPropertyValue("--footer-h")) || 170;
      const onMove = (ev: MouseEvent) => {
        if (orient === "v") {
          root.style.setProperty(wVar, Math.max(140, startW + (ev.clientX - startX)) + "px");
        } else {
          root.style.setProperty("--footer-h", Math.max(60, startH - (ev.clientY - startY)) + "px");
        }
      };
      const onUp = () => {
        el.classList.remove("dragging");
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
      };
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
    },
    [orient, varName],
  );
  return { ref, onMouseDown };
}
