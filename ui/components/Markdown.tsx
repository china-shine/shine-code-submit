import { useMemo } from "react";
import { marked } from "marked";

marked.setOptions({ gfm: true, breaks: false });

// marked 自 v5 移除 sanitize,原始 HTML 直接透传——transcript 里夹带的恶意 HTML
// (WebFetch 抓取的页面被 Claude 引用/复述、恶意 commit subject 等)会在 dashboard 源内执行,
// 并可从 sessionStorage 读到 token 进而调全量 API。这里把 html token 转义成字面文本,
// 阻断注入;markdown 其余语法(链接/粗体/代码块)不受影响。
const escapeHtmlText = (text: string): string =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

marked.use({
  renderer: {
    html({ text }: { text: string }) {
      return escapeHtmlText(text);
    },
  },
});

/** marked 渲染(raw HTML 一律转义为文本,防注入)→ dangerouslySetInnerHTML。useMemo 按 src 缓存。 */
export function Markdown({ src }: { src: string }) {
  const html = useMemo(() => {
    const out = marked.parse(src);
    return typeof out === "string" ? out : "";
  }, [src]);
  return <div dangerouslySetInnerHTML={{ __html: html }} />;
}
