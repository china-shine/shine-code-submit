import { useSplitter } from "../hooks/useSplitter";

export function Splitter({
  orient,
  hidden,
  varName,
}: {
  orient: "v" | "h";
  hidden?: boolean;
  varName?: string;
}) {
  const { ref, onMouseDown } = useSplitter(orient, varName);
  const cls = `splitter splitter-${orient}${hidden ? " hidden" : ""}`;
  return (
    <div
      ref={ref}
      className={cls}
      data-orient={orient}
      onMouseDown={onMouseDown}
      title={orient === "v" ? "拖拽调整宽度" : "拖拽调整高度"}
    />
  );
}
