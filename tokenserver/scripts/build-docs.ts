#!/usr/bin/env bun
// 把 数据说明.md 渲染成静态页 ui/.build/docs.html(供 /docs 路由下发)。
// 用 marked(GFM)做完整 markdown 渲染(嵌套列表/表格/引用/链接等全语法),
// 仅在 heading 渲染器上包一层:h1 跳过(与顶栏重复)、h2 开章节卡(收集目录)、
// hr 丢弃(章节已是卡片);页面复用 /ui/style.css 的主题变量(明暗两套),
// 侧栏目录风格对齐 dashboard Sidebar。
// 改 数据说明.md 后重跑 bun run scripts/build-docs.ts(或 build-ui / build 全流程)。
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Marked } from "marked";

const TS_ROOT = join(import.meta.dir, "..");

// ---------- markdown -> html(marked GFM + 章节卡/目录包装) ----------

/** 渲染:h2 前的内容包 lead 卡;每个 h2 开一张 <section id> 章节卡(目录收集);文末补闭合。 */
export function markdownToHtml(md: string): { html: string; toc: { id: string; text: string }[] } {
  const toc: { id: string; text: string }[] = [];
  const marked = new Marked({ gfm: true, breaks: false });
  marked.use({
    renderer: {
      heading(this: any, token: any) {
        const text = this.parser.parseInline(token.tokens);
        const depth = token.depth;
        if (depth === 1) return ""; // 文档 h1 与页面顶栏重复,跳过
        if (depth === 2) {
          // 开新章节卡:先闭合上一张(lead 或上一章);目录条目去掉括号补语
          const id = `sec-${toc.length}`;
          toc.push({ id, text: text.replace(/[（(].*$/, "").replace(/<[^>]+>/g, "") });
          return `</section>\n<section id="${id}"><h2>${text}</h2>`;
        }
        return `<h${depth}>${text}</h${depth}>`;
      },
      hr() {
        return ""; // 章节已拆成卡片,分隔线不再需要
      },
    },
  });
  const body = marked.parse(md, { async: false }) as string;
  // 首个 h2 渲染器输出的 </section> 闭合的是这里预开的 lead 卡;文末统一闭合最后一张卡
  const html = `<section class="lead">\n${body}\n</section>`;
  return { html, toc };
}

// ---------- 页面模板(主题变量全部来自 /ui/style.css,风格对齐 dashboard) ----------

/** 目录条目转义(标题文本进入 <a>,防 markdown 行内标记泄漏成标签)。 */
function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

const PAGE_CSS = `
* { box-sizing: border-box; }
html { scroll-behavior: smooth; }
body { margin: 0; font-family: Inter, -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif; background: var(--background); color: var(--foreground); font-size: 14px; line-height: 1.75; }
.layout { display: flex; min-height: 100vh; }

/* 侧栏:同 Sidebar.tsx(w-52 深底 + 品牌 + 导航 + 底部 dark toggle) */
aside.sidebar { width: 13rem; flex-shrink: 0; background: var(--sidebar); color: var(--sidebar-foreground); display: flex; flex-direction: column; height: 100vh; position: sticky; top: 0; }
.brand { padding: 1.25rem 1rem 1rem; display: flex; align-items: center; gap: 0.625rem; }
.brand-icon { width: 1.75rem; height: 1.75rem; border-radius: 4px; background: linear-gradient(to bottom right, #818cf8, #8b5cf6); display: flex; align-items: center; justify-content: center; flex-shrink: 0; }
.brand-name { font-size: 0.875rem; font-weight: 700; color: #fff; letter-spacing: -0.01em; }
nav.toc { flex: 1; padding: 0 0.5rem; overflow-y: auto; }
.toc-label { font-size: 0.6875rem; color: var(--sidebar-foreground); opacity: 0.45; padding: 0.375rem 0.75rem; }
nav.toc a { display: block; padding: 0.375rem 0.75rem; border-radius: 4px; font-size: 0.8125rem; color: var(--sidebar-foreground); opacity: 0.7; text-decoration: none; transition: background 0.15s, color 0.15s; }
nav.toc a:hover { background: var(--sidebar-accent); opacity: 1; color: var(--sidebar-accent-foreground); }
nav.toc a.active { background: var(--sidebar-accent); color: var(--sidebar-primary); opacity: 1; font-weight: 500; }
.sidebar-foot { padding: 0.75rem; border-top: 1px solid var(--sidebar-border); display: flex; justify-content: space-between; align-items: center; gap: 0.5rem; }
.back-link { display: flex; align-items: center; gap: 0.375rem; font-size: 0.75rem; color: var(--sidebar-foreground); opacity: 0.7; text-decoration: none; padding: 0.25rem 0.5rem; border-radius: 4px; }
.back-link:hover { background: var(--sidebar-accent); opacity: 1; }
.theme-btn { width: 1.75rem; height: 1.75rem; border: 0; border-radius: 4px; background: var(--sidebar-accent); color: var(--sidebar-primary); display: flex; align-items: center; justify-content: center; cursor: pointer; }
.theme-btn:hover { opacity: 0.8; }
.icon-sun { display: none; }
html.dark .icon-sun { display: block; }
html.dark .icon-moon { display: none; }

/* 内容区:顶栏对齐 TopBar;正文限宽居中(长行可读性),不再通栏铺满 */
main { flex: 1; min-width: 0; }
.topbar { height: 3.5rem; background: var(--card); border-bottom: 1px solid var(--border); display: flex; align-items: center; padding: 0 1.25rem; gap: 0.75rem; position: sticky; top: 0; z-index: 30; }
.topbar h1 { font-size: 1.0625rem; font-weight: 500; margin: 0; }
.topbar .sub { font-size: 0.75rem; color: var(--muted-foreground); }
article { max-width: 56rem; margin: 0 auto; padding: 2rem 1.5rem 4rem; }

/* 章节卡:卡片化 + 顶部主题色细条(h2 卡),lead 为引言横幅 */
article section { position: relative; background: var(--card); border: 1px solid var(--border); border-radius: 10px; padding: 1.75rem 2.25rem 1.875rem; margin-bottom: 1.5rem; scroll-margin-top: 4.5rem; overflow: hidden; }
article section::before { content: ""; position: absolute; top: 0; left: 0; right: 0; height: 3px; background: linear-gradient(90deg, var(--primary), transparent 65%); opacity: 0.85; }
article section.lead { background: var(--secondary); border-color: var(--border); padding: 1.375rem 1.75rem; }
article section.lead::before { background: linear-gradient(90deg, var(--primary), var(--sidebar-primary), transparent 70%); }
article section.lead blockquote { background: transparent; border-left: 0; padding: 0 0.25rem; }
article section > *:first-child { margin-top: 0; }
article section > *:last-child { margin-bottom: 0; }

/* 标题层级:h2 章名(大+底部双线)、h3 左侧主题色竖条、h4 弱化为小节标签 */
article h2 { font-size: 1.375rem; font-weight: 700; line-height: 1.4; margin: 0 0 1.25rem; padding-bottom: 0.75rem; border-bottom: 1px solid var(--border); position: relative; }
article h2::after { content: ""; position: absolute; left: 0; bottom: -1px; width: 3.5rem; height: 2px; background: var(--primary); border-radius: 1px; }
article h3 { font-size: 1.0625rem; font-weight: 600; margin: 2rem 0 0.875rem; padding-left: 0.625rem; border-left: 3px solid var(--primary); line-height: 1.5; }
article h4 { font-size: 0.875rem; font-weight: 600; margin: 1.75rem 0 0.5rem; color: var(--muted-foreground); letter-spacing: 0.02em; }
article h4::before { content: "▪ "; color: var(--primary); font-size: 0.75rem; vertical-align: 1px; }
article h5, article h6 { font-size: 0.875rem; font-weight: 600; margin: 1.25rem 0 0.5rem; }

/* 垂直节奏:内容块上下 0.875rem,h3 前拉开;正文 15px/1.85 */
article p, article ul, article ol, article table, article pre, article blockquote { margin: 0.875rem 0; }
article { font-size: 0.9375rem; line-height: 1.85; }

article p, article li, article blockquote { overflow-wrap: break-word; }
article a { color: var(--primary); text-decoration: none; border-bottom: 1px dashed color-mix(in srgb, var(--primary) 45%, transparent); }
article a:hover { border-bottom-style: solid; }
article ul, article ol { padding-left: 1.375em; }
article li { margin: 0.4375rem 0; }
article ul li::marker, article ol li::marker { color: var(--primary); font-weight: 500; }
article code { font-family: ui-monospace, SFMono-Regular, Consolas, "Courier New", monospace; font-size: 0.85em; background: var(--muted); color: var(--foreground); padding: 0.1em 0.4em; border-radius: 4px; overflow-wrap: break-word; border: 1px solid color-mix(in srgb, var(--border) 60%, transparent); }
article pre { background: var(--muted); border: 1px solid var(--border); border-radius: 8px; padding: 0.875rem 1.125rem; overflow-x: auto; width: fit-content; max-width: 100%; min-width: 50%; box-shadow: 0 1px 2px color-mix(in srgb, var(--foreground) 5%, transparent); }
article pre code { background: transparent; color: inherit; padding: 0; border: 0; font-size: 0.8125rem; }
article blockquote { padding: 0.5rem 1.125rem; border-left: 3px solid var(--primary); background: color-mix(in srgb, var(--primary) 6%, var(--card)); border-radius: 0 6px 6px 0; }
article blockquote p { margin: 0.4375rem 0; }
article strong { font-weight: 600; color: var(--foreground); }
article hr { display: none; }

/* 表格:圆角卡 + 表头 primary 调底 + 行 hover + 首列加粗 */
article table { width: 100%; border-collapse: separate; border-spacing: 0; border: 1px solid var(--border); border-radius: 8px; overflow: hidden; font-size: 0.8125rem; line-height: 1.65; }
article th, article td { border-bottom: 1px solid var(--border); padding: 0.5625rem 0.9375rem; text-align: left; vertical-align: top; overflow-wrap: anywhere; }
article th { background: color-mix(in srgb, var(--primary) 8%, var(--secondary)); color: var(--secondary-foreground); font-weight: 600; font-size: 0.7813rem; letter-spacing: 0.01em; }
article tbody tr { transition: background 0.12s; }
article tbody tr:hover { background: color-mix(in srgb, var(--primary) 4%, transparent); }
article tbody tr:last-child td { border-bottom: 0; }
article td:first-child strong { color: var(--primary); }

/* 返回顶部 */
#backTop { position: fixed; right: 1.25rem; bottom: 1.25rem; width: 2.25rem; height: 2.25rem; border: 1px solid var(--border); border-radius: 8px; background: var(--card); color: var(--muted-foreground); display: flex; align-items: center; justify-content: center; cursor: pointer; opacity: 0; pointer-events: none; transition: opacity 0.2s, color 0.15s; z-index: 40; }
#backTop.show { opacity: 1; pointer-events: auto; }
#backTop:hover { color: var(--primary); border-color: var(--primary); }

@media (max-width: 768px) {
  aside.sidebar { display: none; }
  article { padding: 1.25rem 1rem 3rem; }
  article section { padding: 1.25rem 1.125rem 1.375rem; border-radius: 8px; }
}
`;

const PAGE_JS = `
(function () {
  // 主题:localStorage 记忆,默认跟随系统
  var saved = null;
  try { saved = localStorage.getItem("docs-theme"); } catch (e) {}
  var dark = saved ? saved === "dark" : matchMedia("(prefers-color-scheme: dark)").matches;
  apply();
  var btn = document.getElementById("themeToggle");
  if (btn) btn.addEventListener("click", function () { dark = !dark; try { localStorage.setItem("docs-theme", dark ? "dark" : "light"); } catch (e) {} apply(); });
  function apply() {
    document.documentElement.classList.toggle("dark", dark);
    var t = document.getElementById("themeToggle");
    if (t) t.title = dark ? "切换亮色" : "切换暗色";
  }
  // 目录高亮:滚动时点亮当前所在小节
  var links = Array.prototype.slice.call(document.querySelectorAll("nav.toc a"));
  var byId = {};
  links.forEach(function (a) { byId[a.getAttribute("href").slice(1)] = a; });
  var obs = new IntersectionObserver(
    function (entries) {
      entries.forEach(function (en) {
        if (en.isIntersecting) {
          links.forEach(function (a) { a.classList.remove("active"); });
          var a = byId[en.target.id];
          if (a) a.classList.add("active");
        }
      });
    },
    { rootMargin: "-20% 0px -70% 0px" }
  );
  document.querySelectorAll("article section[id]").forEach(function (s) { obs.observe(s); });
  // 返回顶部:滚动超过一屏出现
  var top = document.getElementById("backTop");
  if (top) {
    top.addEventListener("click", function () { window.scrollTo({ top: 0, behavior: "smooth" }); });
    window.addEventListener("scroll", function () { top.classList.toggle("show", window.scrollY > window.innerHeight * 0.6); }, { passive: true });
  }
})();
`;

export function buildDocs(): string {
  const md = readFileSync(join(TS_ROOT, "数据说明.md"), "utf8");
  const { html, toc } = markdownToHtml(md);

  const tocNav = toc
    .map((t) => `<a href="#${t.id}">${esc(t.text)}</a>`)
    .join("");

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
<div class="layout">
  <aside class="sidebar">
    <div class="brand">
      <div class="brand-icon">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"></polygon></svg>
      </div>
      <div class="brand-name">AI效能平台</div>
    </div>
    <nav class="toc">
      <div class="toc-label">数据说明</div>
      ${tocNav}
    </nav>
    <div class="sidebar-foot">
      <a class="back-link" href="/">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="7" height="9" x="3" y="3" rx="1"></rect><rect width="7" height="5" x="14" y="3" rx="1"></rect><rect width="7" height="9" x="14" y="12" rx="1"></rect><rect width="7" height="5" x="3" y="16" rx="1"></rect></svg>
        返回看板
      </a>
      <button id="themeToggle" class="theme-btn" type="button">
        <svg class="icon-moon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"></path></svg>
        <svg class="icon-sun" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"></circle><path d="M12 2v2m0 16v2M4.93 4.93l1.41 1.41m11.32 11.32 1.41 1.41M2 12h2m16 0h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.66 1.41"></path></svg>
      </button>
    </div>
  </aside>
  <main>
    <header class="topbar">
      <h1>数据说明</h1>
      <span class="sub">Dashboard 各项数据的含义与计算口径</span>
    </header>
    <article>
${html}
    </article>
  </main>
</div>
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
  console.log("docs rendered -> " + outFile + ` (${toc.length} sections)`);
  return page;
}

if (import.meta.main) buildDocs();
