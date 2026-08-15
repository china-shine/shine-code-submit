// HTTP 路由:API(health/report/reports) + 静态资源。
// 静态资源双模式:开发(bun run src)读文件(改 HTML/CSS 直接刷新);
// 编译(二进制)用内联 ui-assets(因二进制内无 ui/ 文件)。
// /docs 例外:**运行时**读 数据说明.md → marked 渲染(改 md 刷新即生效,不需重新 build;
// 二进制旁有 md 优先读,否则用 build 时内嵌的备份)。
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { gzipSync, gunzipSync } from "node:zlib";
import { createHash } from "node:crypto";
import { saveReport, getStats, getSessions, getMember, getMemberWorklogs, getDenominatorBreakdown, type Granularity } from "./store";
import type { ReportResponse } from "./types";
import { APP_JS, DOCS_MD, INDEX_HTML, STYLE_CSS } from "./ui-assets";
import { Marked } from "marked";

const PORT = Number(process.env.PORT ?? 36667);
const HOST = "0.0.0.0";

const UI_DIR = join(import.meta.dir, "..", "ui");

const ASSETS: Record<string, { file: string; inline: string; type: string }> = {
  "/": { file: "index.html", inline: INDEX_HTML, type: "text/html; charset=utf-8" },
  "/index.html": { file: "index.html", inline: INDEX_HTML, type: "text/html; charset=utf-8" },
  "/ui/app.js": { file: ".build/app.js", inline: APP_JS, type: "application/javascript; charset=utf-8" },
  "/ui/style.css": { file: ".build/style.css", inline: STYLE_CSS, type: "text/css; charset=utf-8" },
};

// ---------- /docs:运行时 markdown 渲染(VS Code preview 观感) ----------

const DOCS_MD_PATHS = [
  join(import.meta.dir, "..", "数据说明.md"),          // 开发:仓库根
  join(process.execPath, "..", "数据说明.md"),          // 编译:二进制旁
  join(process.cwd(), "数据说明.md"),                    // cwd 兜底
];

function readDocsMd(): string {
  for (const p of DOCS_MD_PATHS) {
    try { if (existsSync(p)) return readFileSync(p, "utf8"); } catch { /* try next */ }
  }
  return DOCS_MD; // build 时内嵌的备份(二进制部署且旁无 md 文件)
}

// TOC 收集:渲染 heading 时同时收集 h2/h3 生成目录(带锚点 id)
const docsToc: { id: string; text: string; depth: number }[] = [];
let docsHeadingSeq = 0;

const docsMarked = new Marked({ gfm: true, breaks: false });
docsMarked.use({
  renderer: {
    heading(this: any, token: any) {
      const text = this.parser.parseInline(token.tokens);
      const depth = token.depth;
      if (depth === 1) return ""; // h1 与顶栏标题重复,跳过
      // h2/h3 加锚点 id + 收集进目录
      if (depth <= 3) {
        const id = "hd-" + docsHeadingSeq++;
        docsToc.push({ id, text: text.replace(/<[^>]+>/g, ""), depth });
        return `<h${depth} id="${id}">${text}</h${depth}>`;
      }
      return `<h${depth}>${text}</h${depth}>`;
    },
  },
});

function serveDocs(): Response {
  docsToc.length = 0;
  docsHeadingSeq = 0;
  const html = docsMarked.parse(readDocsMd(), { async: false }) as string;
  return new Response(DOCS_PAGE(html, docsToc), { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
}

function DOCS_PAGE(body: string, toc: { id: string; text: string; depth: number }[]): string {
  const tocNav = toc.map(t =>
    t.depth === 2
      ? `<a href="#${t.id}" class="lv2">${t.text}</a>`
      : `<a href="#${t.id}" class="lv3">${t.text}</a>`
  ).join("");
  return `<!DOCTYPE html>
<html lang="zh">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>数据说明 · AI效能平台</title>
<style>
${DOCS_CSS}
</style>
</head>
<body>
<header class="topbar">
  <h1>数据说明</h1>
  <span class="sub">各项数据的含义与计算口径</span>
  <a class="back" href="/">返回看板</a>
</header>
<div class="layout">
  <aside class="toc">
    <div class="toc-label">目录</div>
    ${tocNav}
  </aside>
  <article>${body}</article>
</div>
<script>
(function(){
  var links = Array.prototype.slice.call(document.querySelectorAll("aside.toc a"));
  var byId = {};
  links.forEach(function(a){ byId[a.getAttribute("href").slice(1)] = a; });
  var obs = new IntersectionObserver(function(entries){
    entries.forEach(function(en){
      if (en.isIntersecting) {
        links.forEach(function(a){ a.classList.remove("active"); });
        var a = byId[en.target.id];
        if (a) a.classList.add("active");
      }
    });
  }, { rootMargin: "-10% 0px -80% 0px" });
  document.querySelectorAll("h2[id],h3[id]").forEach(function(h){ obs.observe(h); });
})();
</script>
</body>
</html>`;
}

const DOCS_CSS = `
* { box-sizing: border-box; }
html { scroll-behavior: smooth; }
body { margin: 0; font-family: Inter, -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif; background: var(--background, #f8fafc); color: var(--foreground, #0f172a); font-size: 15px; line-height: 1.8; }
:root { --background:#f8fafc; --foreground:#0f172a; --muted:#f1f5f9; --border:#e2e8f0; --secondary:#f1f5f9; --primary:#6366f1; --sidebar-bg:#1e293b; --sidebar-fg:#e2e8f0; }
@media (prefers-color-scheme: dark) { :root { --background:#0f172a; --foreground:#e2e8f0; --muted:#1e293b; --border:#334155; --secondary:#1e293b; --primary:#818cf8; --sidebar-bg:#0f172a; --sidebar-fg:#94a3b8; } }

.topbar { height: 3.25rem; background: var(--foreground); color: var(--background); display: flex; align-items: center; gap: .75rem; padding: 0 1.25rem; position: sticky; top: 0; z-index: 10; }
.topbar h1 { font-size: .9375rem; font-weight: 600; margin: 0; }
.topbar .sub { font-size: .75rem; opacity: .6; }
.topbar .back { margin-left: auto; color: inherit; opacity: .7; text-decoration: none; font-size: .8125rem; }
.topbar .back:hover { opacity: 1; }

.layout { display: flex; min-height: calc(100vh - 3.25rem); }

aside.toc { width: 14rem; flex-shrink: 0; background: var(--sidebar-bg); color: var(--sidebar-fg); padding: 1rem .5rem 2rem; position: sticky; top: 3.25rem; height: calc(100vh - 3.25rem); overflow-y: auto; }
.toc-label { font-size: .6875rem; opacity: .45; padding: .375rem .75rem; margin-bottom: .25rem; }
aside.toc a { display: block; padding: .3125rem .75rem; font-size: .8125rem; color: inherit; opacity: .65; text-decoration: none; border-radius: 4px; border-left: 2px solid transparent; transition: opacity .15s, border-color .15s; }
aside.toc a:hover { opacity: 1; }
aside.toc a.lv2 { font-weight: 500; margin-top: .375rem; }
aside.toc a.lv3 { padding-left: 1.375rem; font-size: .7813rem; }
aside.toc a.active { opacity: 1; border-left-color: var(--primary); background: rgba(99,102,241,.1); }

article { flex: 1; min-width: 0; padding: 1.5rem 2rem 4rem; }

h2 { font-size: 1.375rem; font-weight: 700; margin: 2.25rem 0 1rem; padding-bottom: .5rem; border-bottom: 2px solid var(--border); }
h3 { font-size: 1.1875rem; font-weight: 600; margin: 1.75rem 0 .875rem; }
h4 { font-size: 1rem; font-weight: 600; margin: 1.375rem 0 .625rem; }
h5, h6 { font-size: .9375rem; font-weight: 600; margin: 1.125rem 0 .5rem; }

p { margin: .8125rem 0; overflow-wrap: break-word; }
a { color: var(--primary); text-decoration: none; }
a:hover { text-decoration: underline; }
ul, ol { padding-left: 1.5em; margin: .8125rem 0; }
li { margin: .25rem 0; }
code { font-family: ui-monospace, SFMono-Regular, Consolas, monospace; font-size: .85em; background: var(--muted); padding: .15em .4em; border-radius: 4px; overflow-wrap: break-word; }
pre { background: var(--muted); border: 1px solid var(--border); border-radius: 6px; padding: .875rem 1.125rem; overflow-x: auto; margin: 1rem 0; }
pre code { background: transparent; padding: 0; font-size: .8125rem; }
blockquote { margin: 1rem 0; padding: .375rem 1.125rem; border-left: 4px solid var(--primary); background: var(--secondary); border-radius: 0 4px 4px 0; }
blockquote p { margin: .4375rem 0; }
strong { font-weight: 600; }
hr { border: 0; border-top: 1px solid var(--border); margin: 2rem 0; }

table { width: 100%; border-collapse: collapse; margin: 1rem 0; font-size: .875rem; line-height: 1.6; }
th, td { border: 1px solid var(--border); padding: .4375rem .875rem; text-align: left; vertical-align: top; overflow-wrap: anywhere; }
th { background: var(--secondary); font-weight: 600; }

@media (max-width: 768px) {
  aside.toc { display: none; }
  article { padding: 1.25rem 1rem 3rem; }
}
`;

function json(req: Request, body: unknown, status = 200): Response {
  const payload = JSON.stringify(body);
  const acceptGzip = (req.headers.get("accept-encoding") ?? "").toLowerCase().includes("gzip");
  const base: Record<string, string> = {
    "content-type": "application/json; charset=utf-8",
    vary: "Accept-Encoding",
  };
  if (acceptGzip) {
    return new Response(gzipSync(Buffer.from(payload, "utf8")), {
      status,
      headers: { ...base, "content-encoding": "gzip" },
    });
  }
  return new Response(payload, { status, headers: base });
}

/** start/end(YYYY-MM-DD)→ {from,to} 毫秒时间戳。from=开始日0点(空=0 不限起始);to=结束日23:59:59.999(空=MAX 不限结束)。 */
function parseDateRange(startStr: string | null, endStr: string | null): { from: number; to: number } {
  const from = startStr ? new Date(startStr + "T00:00:00").getTime() : 0;
  const to = endStr ? new Date(endStr + "T00:00:00").getTime() + 86_400_000 - 1 : Number.MAX_SAFE_INTEGER;
  return { from, to };
}

// 静态资源 gzip 压缩传输:app.js 647KB / style.css 402KB,不开 gzip 浏览器全程裸传 ~1MB。
// 生产(inline)内容随二进制固定 → gzip + ETag memoize;开发(读文件)实时 gzip(文件常变不缓存)。
// 缓存:开发 no-store(改文件即刷);生产 no-cache + ETag(每次条件请求,内容没变 304 无 body、变了自动拿新)。
const inlineCompressed = new Map<string, { gz: Uint8Array; raw: string; etag: string }>();

async function serveAsset(path: string, req: Request): Promise<Response | null> {
  const a = ASSETS[path];
  if (!a) return null;
  const filePath = join(UI_DIR, a.file);
  const acceptGzip = (req.headers.get("accept-encoding") ?? "").toLowerCase().includes("gzip");
  const vary = { vary: "Accept-Encoding" };

  if (existsSync(filePath)) {
    // 开发:读文件,实时 gzip,no-store
    const bytes = readFileSync(filePath);
    if (acceptGzip) {
      return new Response(gzipSync(bytes), {
        headers: { "content-type": a.type, "content-encoding": "gzip", "cache-control": "no-store", ...vary },
      });
    }
    return new Response(bytes, { headers: { "content-type": a.type, "cache-control": "no-store", ...vary } });
  }

  // 生产:内联(随二进制固定),gzip + ETag memoize,no-cache(条件请求)
  let entry = inlineCompressed.get(path);
  if (!entry) {
    const gz = gzipSync(Buffer.from(a.inline, "utf8"));
    const etag = '"' + createHash("sha1").update(a.inline).digest("hex").slice(0, 16) + '"';
    entry = { gz, raw: a.inline, etag };
    inlineCompressed.set(path, entry);
  }
  const cc = "no-cache";
  if (req.headers.get("if-none-match") === entry.etag) {
    return new Response(null, { status: 304, headers: { etag: entry.etag, "cache-control": cc, ...vary } });
  }
  if (acceptGzip) {
    return new Response(entry.gz, {
      headers: { "content-type": a.type, "content-encoding": "gzip", etag: entry.etag, "cache-control": cc, ...vary },
    });
  }
  return new Response(entry.raw, {
    headers: { "content-type": a.type, etag: entry.etag, "cache-control": cc, ...vary },
  });
}

export function startServer() {
  return Bun.serve({
    hostname: HOST,
    port: PORT,
    maxRequestBodySize: 256 * 1024 * 1024, // 256MB:全量回填(sessions + 上万 commit)防 413
    async fetch(req) {
      const url = new URL(req.url);
      const path = url.pathname;

      if (path === "/api/health" && req.method === "GET") {
        return json(req, { service: "tokenserver", ok: true, ts: Date.now() });
      }

      if (path === "/api/report" && req.method === "POST") {
        let body: ReportResponse;
        try {
          body = JSON.parse(
            (req.headers.get("content-encoding") ?? "").toLowerCase().includes("gzip")
              ? gunzipSync(Buffer.from(await req.arrayBuffer())).toString("utf8")
              : await req.text(),
          ) as ReportResponse;
        } catch {
          return json(req, { error: "bad json" }, 400);
        }
        if (!body || !Array.isArray(body.projects)) {
          return json(req, { error: "invalid report: projects missing" }, 400);
        }
        saveReport(body);
        return json(req, { status: "ok" });
      }

      // 全局聚合(overview 6 组件用,小汇总不随会话数膨胀)
      if (path === "/api/stats" && req.method === "GET") {
        const { from, to } = parseDateRange(url.searchParams.get("start"), url.searchParams.get("end"));
        const members = (url.searchParams.get("members") ?? "").split(",").filter(Boolean);
        const gRaw = url.searchParams.get("granularity");
        const granularity: Granularity = gRaw === "week" || gRaw === "month" ? gRaw : "day";
        return json(req, getStats({ from, to, members, granularity }));
      }

      // AI 占比「分母构成」(占比卡「查看分母」按钮):按 cwd + 有无AI 拆 git_changes 分母。
      if (path === "/api/denominator-breakdown" && req.method === "GET") {
        const { from, to } = parseDateRange(url.searchParams.get("start"), url.searchParams.get("end"));
        const members = (url.searchParams.get("members") ?? "").split(",").filter(Boolean);
        const member = url.searchParams.get("member") ?? undefined;
        return json(req, getDenominatorBreakdown({ from, to, members, member }));
      }

      // 会话明细分页(RecentSessionsTable 翻页查 DB)
      if (path === "/api/sessions" && req.method === "GET") {
        const { from, to } = parseDateRange(url.searchParams.get("start"), url.searchParams.get("end"));
        const members = (url.searchParams.get("members") ?? "").split(",").filter(Boolean);
        const member = url.searchParams.get("member") ?? undefined;
        const page = Math.max(1, parseInt(url.searchParams.get("page") ?? "1", 10) || 1);
        const pageSize = Math.max(1, parseInt(url.searchParams.get("pageSize") ?? "20", 10) || 20);
        return json(req, getSessions({ from, to, members, member }, page, pageSize));
      }

      // 成员禅道工时分页(MemberDetailPage 禅道工时表;date 字符串比较)。
      // ⚠️ 必须在 /api/member/:gitUser(startsWith 前缀匹配)之上,否则 gitUser 会变成 "X/worklog"。
      {
        const m = path.match(/^\/api\/member\/([^/]+)\/worklog$/);
        if (m && req.method === "GET") {
          const gitUser = decodeURIComponent(m[1]);
          const start = url.searchParams.get("start") ?? ""; // YYYY-MM-DD 或空(不限)
          const end = url.searchParams.get("end") ?? "";
          const page = Math.max(1, parseInt(url.searchParams.get("page") ?? "1", 10) || 1);
          const pageSize = Math.max(1, parseInt(url.searchParams.get("pageSize") ?? "20", 10) || 20);
          return json(req, getMemberWorklogs(gitUser, { start, end }, page, pageSize));
        }
      }

      // 单成员 KPI + 趋势(MemberDetailPage;团队均值复用 /api/stats)
      if (path.startsWith("/api/member/") && req.method === "GET") {
        const gitUser = decodeURIComponent(path.slice("/api/member/".length));
        const { from, to } = parseDateRange(url.searchParams.get("start"), url.searchParams.get("end"));
        const gRaw = url.searchParams.get("granularity");
        const granularity: Granularity = gRaw === "week" || gRaw === "month" ? gRaw : "day";
        return json(req, getMember(gitUser, { from, to, granularity }));
      }

      // /docs:运行时 markdown 渲染(改 md 刷新即生效)
      if (path === "/docs") return serveDocs();

      const asset = await serveAsset(path, req);
      if (asset) return asset;

      return json(req, { error: "not found" }, 404);
    },
  });
}
