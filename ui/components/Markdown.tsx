import { useMemo } from "react";
import { marked } from "marked";

marked.setOptions({ gfm: true, breaks: false });

/** marked 渲染（默认转义 HTML 防注入）→ dangerouslySetInnerHTML。useMemo 按 src 缓存。 */
export function Markdown({ src }: { src: string }) {
  const html = useMemo(() => {
    const out = marked.parse(src);
    return typeof out === "string" ? out : "";
  }, [src]);
  return <div dangerouslySetInnerHTML={{ __html: html }} />;
}
