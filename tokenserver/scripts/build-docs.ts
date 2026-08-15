#!/usr/bin/env bun
// 把 数据说明.md 渲染成静态页 ui/.build/docs.html(供 /docs 路由下发)。
// marked(GFM)直接渲染 markdown,不包章节卡、无侧栏导航——就是一份干净的
// markdown 文档阅读页(GitHub README 观感),仅 h1 跳过(与顶栏重复)。
// 改 数据说明.md 后重跑 bun run scripts/build-docs.ts(或 build-ui / build 全流程)。
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Marked } from "marked";

const TS_ROOT = join(import.meta.dir, "..");

// ---------- markdown -> html(marked GFM 直出,无结构包装) ----------

export function markdownToHtml(md: string): { html: string } {
  const marked = new Marked({ gfm: true, breaks: false });
  marked.use({
    renderer: {
      heading(this: any, token: any) {
        const text = this.parser.parseInline(token.tokens);
        if (token.depth === 1) return ""; // 文档 h1 与页面顶栏重复,跳过
        return `<h${token.depth}>${text}</h${token.depth}>`;
      },
    },
  });
  return { html: marked.parse(md, { async: false }) as string };
}

// ---------- 页面模板(主题变量来自 /ui/style.css,markdown 阅读页样式) ----------

const PAGE_CSS = `
* { box-sizing: border-box; }
html { scroll-behavior: smooth; }
body { margin: 0; font-family: Inter, -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif; background: var(--background); color: var(--foreground); font-size: 15px; line-height: 1.8; }

.topbar { height: 3.5rem; background: var(--card); border-bottom: 1px solid var(--border); display: flex; align-items: center; justify-content: space-between; padding: 0 1.5rem; position: sticky; top: 0; z-index: 30; }
.topbar .left { display: flex; align-items: center; gap: 0.75rem; }
.topbar h1 { font-size: 1.0625rem; font-weight: 500; margin: 0; }
.topbar .sub { font-size: 0.75rem; color: var(--muted-foreground); }
.back-link { display: flex; align-items: center; gap: 0.375rem; font-size: 0.8125rem; color: var(--primary); text-decoration: none; padding: 0.25rem 0.625rem; border-radius: 4px; }
.back-link:hover { background: var(--secondary); }

article { max-width: 50rem; margin: 0 auto; padding: 2rem 1.5rem 5rem; }

article h2 { font-size: 1.5rem; font-weight: 600; margin: 2.5rem 0 1rem; padding-bottom: 0.5rem; border-bottom: 1px solid var(--border); }
article h3 { font-size: 1.1875rem; font-weight: 600; margin: 2rem 0 0.875rem; }
article h4 { font-size: 1rem; font-weight: 600; margin: 1.5rem 0 0.625rem; }
article h5, article h6 { font-size: 0.9375rem; font-weight: 600; margin: 1.25rem 0 0.5rem; }

article p { margin: 0.875rem 0; overflow-wrap: break-word; }
article a { color: var(--primary); text-decoration: none; }
article a:hover { text-decoration: underline; }
article ul, article ol { padding-left: 1.5em; margin: 0.875rem 0; }
article li { margin: 0.3125rem 0; }
article ul li::marker, article ol li::marker { color: var(--primary); }
article code { font-family: ui-monospace, SFMono-Regular, Consolas, "Courier New", monospace; font-size: 0.85em; background: var(--muted); padding: 0.15em 0.4em; border-radius: 4px; overflow-wrap: break-word; }
article pre { background: var(--muted); border: 1px solid var(--border); border-radius: 6px; padding: 0.875rem 1.125rem; overflow-x: auto; margin: 1rem 0; }
article pre code { background: transparent; padding: 0; font-size: 0.8125rem; }
article blockquote { margin: 1rem 0; padding: 0.25rem 1.125rem; border-left: 3px solid var(--primary); background: var(--secondary); border-radius: 0 4px 4px 0; }
article blockquote p { margin: 0.4375rem 0; }
article strong { font-weight: 600; }
article hr { border: 0; border-top: 1px solid var(--border); margin: 2rem 0; }

article table { width: 100%; border-collapse: collapse; margin: 1rem 0; font-size: 0.875rem; line-height: 1.65; }
article th, article td { border: 1px solid var(--border); padding: 0.4375rem 0.875rem; text-align: left; vertical-align: top; overflow-wrap: anywhere; }
article th { background: var(--secondary); font-weight: 600; }

#backTop { position: fixed; right: 1.25rem; bottom: 1.25rem; width: 2.25rem; height: 2.25rem; border: 1px solid var(--border); border-radius: 8px; background: var(--card); color: var(--muted-foreground); display: flex; align-items: center; justify-content: center; cursor: pointer; opacity: 0; pointer-events: none; transition: opacity 0.2s, color 0.15s; z-index: 40; }
#backTop.show { opacity: 1; pointer-events: auto; }
#backTop:hover { color: var(--primary); border-color: var(--primary); }

@media (max-width: 768px) {
  article { padding: 1.25rem 1rem 3rem; }
}
`;

const PAGE_JS = `
(function () {
  var saved = null;
  try { saved = localStorage.getItem("docs-theme"); } catch (e) {}
  var dark = saved ? saved === "dark" : matchMedia("(prefers-color-scheme: dark)").matches;
  document.documentElement.classList.toggle("dark", dark);
  var top = document.getElementById("backTop");
  if (top) {
    top.addEventListener("click", function () { window.scrollTo({ top: 0, behavior: "smooth" }); });
    window.addEventListener("scroll", function () { top.classList.toggle("show", window.scrollY > window.innerHeight * 0.6); }, { passive: true });
  }
})();
`;

export function buildDocs(): string {
  const md = readFileSync(join(TS_ROOT, "数据说明.md"), "utf8");
  const { html } = markdownToHtml(md);

  const page = `<!DOCTYPE html>
<html lang="zh">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>数据说明 · AI效能平台</title>
<link rel="stylesheet" href="/ui/style.css">
<style>${PAGE_CSS}</style>
</head>
<body>
<header class="topbar">
  <div class="left">
    <h1>数据说明</h1>
    <span class="sub">各项数据的含义与计算口径</span>
  </div>
  <a class="back-link" href="/">
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="7" height="9" x="3" y="3" rx="1"></rect><rect width="7" height="5" x="14" y="3" rx="1"></rect><rect width="7" height="9" x="14" y="12" rx="1"></rect><rect width="7" height="5" x="3" y="16" rx="1"></rect></svg>
    返回看板
  </a>
</header>
<article>
${html}
</article>
<button id="backTop" type="button" aria-label="返回顶部">
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m18 15-6-6-6 6"></path></svg>
</button>
<script>${PAGE_JS}</script>
</body>
</html>
`;

  const outDir = join(TS_ROOT, "ui", ".build");
  mkdirSync(outDir, { recursive: true });
  const outFile = join(outDir, "docs.html");
  writeFileSync(outFile, page);
  console.log("docs rendered -> " + outFile);
  return page;
}

if (import.meta.main) buildDocs();
