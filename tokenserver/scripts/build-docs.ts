#!/usr/bin/env bun
// 把 数据说明.md 渲染成静态页 ui/.build/docs.html(供 /docs 路由下发)。
// 不引入 markdown 依赖,内置一个只覆盖本文档语法(标题/表格/代码块/引用/列表/加粗/行内码/链接)的
// 简易转换器;页面复用 /ui/style.css 的主题变量(明暗两套),侧栏目录风格对齐 dashboard Sidebar。
// 改 数据说明.md 后重跑 bun run scripts/build-docs.ts(或 build-ui / build 全流程)。
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const TS_ROOT = join(import.meta.dir, "..");

// ---------- markdown -> html(仅覆盖本文档用到的语法) ----------

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** 行内:行内码 → 加粗 → 链接(先转义,码内容不再吃后续替换)。 */
function inline(s: string): string {
  return esc(s)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>');
}

function isTableSep(s: string): boolean {
  return /^\|?\s*:?-{2,}[-\s:|]*\|?\s*$/.test(s.trim());
}

function splitRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((c) => c.trim());
}

export function markdownToHtml(md: string): { html: string; toc: { id: string; text: string }[] } {
  const lines = md.split(/\r?\n/);
  const out: string[] = [];
  const toc: { id: string; text: string }[] = [];
  let i = 0;
  let openSection = false; // 是否有未闭合的 <section>(h2 章节卡 / 开篇 lead 卡)

  const closeSection = () => {
    if (openSection) {
      out.push("</section>");
      openSection = false;
    }
  };

  while (i < lines.length) {
    const line = lines[i];
    const t = line.trim();

    if (!t) {
      i++;
      continue;
    }

    // 第一个 h2 之前的内容(文档引言)包成 lead 卡
    if (!openSection) {
      out.push(`<section class="lead">`);
      openSection = true;
    }

    // 围栏代码块
    if (t.startsWith("```")) {
      const buf: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith("```")) {
        buf.push(lines[i]);
        i++;
      }
      i++; // 跳过结尾 ```
      out.push(`<pre><code>${esc(buf.join("\n"))}</code></pre>`);
      continue;
    }

    // 标题:文档 h1 与页面顶栏重复,跳过;h2 开新章节卡(收集进目录)
    const h = t.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      const level = h[1].length;
      const text = h[2].trim();
      if (level === 1) {
        i++;
        continue;
      }
      if (level === 2) {
        closeSection();
        const id = `sec-${toc.length}`;
        toc.push({ id, text: text.replace(/[（(].*$/, "") });
        out.push(`<section id="${id}"><h2>${inline(text)}</h2>`);
        openSection = true;
      } else {
        out.push(`<h${level}>${inline(text)}</h${level}>`);
      }
      i++;
      continue;
    }

    // 分隔线:章节已拆成卡片,分隔线不再需要
    if (/^-{3,}$/.test(t)) {
      i++;
      continue;
    }

    // 表格:| 开头且下一行是分隔行
    if (t.startsWith("|") && i + 1 < lines.length && isTableSep(lines[i + 1])) {
      const head = splitRow(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i].trim().startsWith("|")) {
        rows.push(splitRow(lines[i]));
        i++;
      }
      out.push(
        "<table><thead><tr>" +
          head.map((c) => `<th>${inline(c)}</th>`).join("") +
          "</tr></thead><tbody>" +
          rows.map((r) => "<tr>" + r.map((c) => `<td>${inline(c)}</td>`).join("") + "</tr>").join("") +
          "</tbody></table>",
      );
      continue;
    }

    // 引用块(连续 > 行合成一个;> 空行分隔的段落各自成 <p>,段内行 <br>)
    if (t.startsWith(">")) {
      const buf: string[] = [];
      while (i < lines.length && lines[i].trim().startsWith(">")) {
        buf.push(lines[i].trim().replace(/^>\s?/, ""));
        i++;
      }
      const paras = buf
        .join("\n")
        .split(/\n\s*\n/)
        .filter((p) => p.trim())
        .map((p) => `<p>${p.split("\n").map((x) => inline(x.trim())).join("<br>")}</p>`);
      out.push(`<blockquote>${paras.join("")}</blockquote>`);
      continue;
    }

    // 无序列表
    if (/^[-*]\s+/.test(t)) {
      const items: string[] = [];
      while (i < lines.length && /^[-*]\s+/.test(lines[i].trim())) {
        items.push(lines[i].trim().replace(/^[-*]\s+/, ""));
        i++;
      }
      out.push(`<ul>${items.map((x) => `<li>${inline(x)}</li>`).join("")}</ul>`);
      continue;
    }

    // 有序列表
    if (/^\d+\.\s+/.test(t)) {
      const items: string[] = [];
      while (i < lines.length && /^\d+\.\s+/.test(lines[i].trim())) {
        items.push(lines[i].trim().replace(/^\d+\.\s+/, ""));
        i++;
      }
      out.push(`<ol>${items.map((x) => `<li>${inline(x)}</li>`).join("")}</ol>`);
      continue;
    }

    // 段落(连续普通行合并)
    const buf: string[] = [line];
    i++;
    while (
      i < lines.length &&
      lines[i].trim() &&
      !/^(#{1,6}\s|>|\||[-*]\s|\d+\.\s|```|-{3,}$)/.test(lines[i].trim())
    ) {
      buf.push(lines[i]);
      i++;
    }
    out.push(`<p>${buf.map((x) => inline(x.trim())).join("<br>")}</p>`);
  }

  closeSection();
  return { html: out.join("\n"), toc };
}

// ---------- 页面模板(主题变量全部来自 /ui/style.css,风格对齐 dashboard) ----------

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

/* 内容区:顶栏对齐 TopBar(h-14 卡片底 + 下边框);内容铺满宽度,章节按卡片拆分(同 dashboard 卡风格) */
main { flex: 1; min-width: 0; }
.topbar { height: 3.5rem; background: var(--card); border-bottom: 1px solid var(--border); display: flex; align-items: center; padding: 0 1.25rem; gap: 0.75rem; position: sticky; top: 0; z-index: 30; }
.topbar h1 { font-size: 1.0625rem; font-weight: 500; margin: 0; }
.topbar .sub { font-size: 0.75rem; color: var(--muted-foreground); }
article { max-width: 104rem; margin: 0 auto; padding: 1.5rem 1.5rem 3rem; }

/* 章节卡:card 底 + 边框,对齐看板 KPI 卡/表卡;lead 为文档引言 banner */
article section { background: var(--card); border: 1px solid var(--border); border-radius: 6px; padding: 1.5rem 2rem; margin-bottom: 1.25rem; scroll-margin-top: 4.5rem; }
article section.lead { background: var(--secondary); }
article section.lead blockquote { background: transparent; border-left: 0; padding: 0 0.25rem; }
article section > *:first-child { margin-top: 0; }
article section > *:last-child { margin-bottom: 0; }

article h2 { font-size: 1.25rem; font-weight: 500; line-height: 1.5; margin: 0 0 1rem; padding-bottom: 0.625rem; border-bottom: 1px solid var(--border); }
article h3 { font-size: 1.0625rem; font-weight: 600; margin: 2rem 0 0.875rem; }
article h4, article h5, article h6 { font-size: 0.9375rem; font-weight: 600; margin: 1.5rem 0 0.625rem; }

/* 统一垂直节奏:所有内容块上下 1rem,标题负责拉开层级行距 */
article p, article ul, article ol, article table, article pre, article blockquote { margin: 1rem 0; }

/* 正文与卡片同宽铺满(不限行宽);仅长 token 可断行 */
article p, article li, article blockquote { overflow-wrap: break-word; }
article a { color: var(--primary); text-decoration: none; }
article a:hover { text-decoration: underline; }
article ul, article ol { padding-left: 1.375em; }
article li { margin: 0.375rem 0; }
article ul li::marker, article ol li::marker { color: var(--primary); font-weight: 500; }
article code { font-family: ui-monospace, SFMono-Regular, Consolas, "Courier New", monospace; font-size: 0.85em; background: var(--muted); color: var(--foreground); padding: 0.1em 0.4em; border-radius: 4px; overflow-wrap: break-word; }
article pre { background: var(--muted); border: 1px solid var(--border); border-radius: 6px; padding: 0.75rem 1rem; overflow-x: auto; width: fit-content; max-width: 100%; min-width: 50%; }
article pre code { background: transparent; color: inherit; padding: 0; font-size: 0.8125rem; }
article blockquote { padding: 0.375rem 1rem; border-left: 3px solid var(--primary); background: var(--secondary); border-radius: 0 4px 4px 0; }
article blockquote p { margin: 0.375rem 0; }
article strong { font-weight: 600; }

/* 表格:同看板表风格——外框圆角 + 表头 secondary 底 + 仅行分隔线,去掉竖线和斑马纹 */
article table { width: 100%; border-collapse: separate; border-spacing: 0; border: 1px solid var(--border); border-radius: 6px; overflow: hidden; font-size: 0.8125rem; line-height: 1.6; }
article th, article td { border-bottom: 1px solid var(--border); padding: 0.5rem 0.875rem; text-align: left; vertical-align: top; overflow-wrap: anywhere; }
article th { background: var(--secondary); color: var(--secondary-foreground); font-weight: 500; }
article tbody tr:last-child td { border-bottom: 0; }

@media (max-width: 768px) {
  aside.sidebar { display: none; }
  article { padding: 1.25rem 1rem 3rem; }
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
