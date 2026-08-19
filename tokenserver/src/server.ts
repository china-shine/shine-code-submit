// HTTP 路由:API(health/report/reports) + 静态资源。
// 静态资源双模式:开发(bun run src)读文件(改 HTML/CSS 直接刷新);
// 编译(二进制)用内联 ui-assets(因二进制内无 ui/ 文件)。
// /docs 例外:**运行时**读 数据说明.md → marked 渲染(改 md 刷新即生效,不需重新 build;
// 二进制旁有 md 优先读,否则用 build 时内嵌的备份)。
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { gzipSync, gunzipSync } from "node:zlib";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { saveReport, getStats, getSessions, getMember, getMemberWorklogs, getDenominatorBreakdown, readAuthConfig, type Granularity } from "./store";
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

function DOCS_PAGE(body: string, _toc: { id: string; text: string; depth: number }[]): string {
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
  <a class="back" href="/" onclick="this.href='/?'+location.search">返回看板</a>
</header>
<article>${body}</article>
</body>
</html>`;
}

const DOCS_CSS = `
* { box-sizing: border-box; }
html { scroll-behavior: smooth; }
body { margin: 0; font-family: Inter, -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif; background: var(--bg); color: var(--fg); font-size: 15px; line-height: 1.8; }
:root {
  --bg:#ffffff; --fg:#1e293b; --muted-bg:#f8fafc; --border:#e2e8f0;
  --secondary:#f1f5f9; --accent:#4f46e5; --accent-light:#eef2ff;
}
@media (prefers-color-scheme: dark) { :root {
  --bg:#0f172a; --fg:#e2e8f0; --muted-bg:#1e293b; --border:#334155;
  --secondary:#1e293b; --accent:#818cf8; --accent-light:#312e81;
} }

.topbar { height: 3rem; background: var(--fg); color: var(--bg); display: flex; align-items: center; gap: .75rem; padding: 0 1.25rem; position: sticky; top: 0; z-index: 10; }
.topbar h1 { font-size: .875rem; font-weight: 600; margin: 0; }
.topbar .sub { font-size: .75rem; opacity: .5; }
.topbar .back { margin-left: auto; color: inherit; opacity: .6; text-decoration: none; font-size: .8125rem; padding: .25rem .625rem; border-radius: 4px; }
.topbar .back:hover { opacity: 1; background: rgba(255,255,255,.1); }

article { padding: 1.75rem 2.5rem 4rem; }

h2 { font-size: 1.375rem; font-weight: 700; margin: 2.5rem 0 1rem; padding-bottom: .5rem; border-bottom: 2px solid var(--border); }
h3 { font-size: 1.1875rem; font-weight: 600; margin: 2rem 0 .875rem; }
h4 { font-size: 1rem; font-weight: 600; margin: 1.5rem 0 .625rem; }
h5, h6 { font-size: .9375rem; font-weight: 600; margin: 1.25rem 0 .5rem; }

p { margin: .8125rem 0; overflow-wrap: break-word; }
a { color: var(--accent); text-decoration: none; }
a:hover { text-decoration: underline; }
ul, ol { padding-left: 1.5em; margin: .8125rem 0; }
li { margin: .25rem 0; }
code { font-family: ui-monospace, SFMono-Regular, Consolas, monospace; font-size: .85em; background: var(--muted-bg); padding: .15em .4em; border-radius: 4px; overflow-wrap: break-word; }
pre { background: var(--muted-bg); border: 1px solid var(--border); border-radius: 8px; padding: .875rem 1.125rem; overflow-x: auto; margin: 1rem 0; }
pre code { background: transparent; padding: 0; font-size: .8125rem; }
blockquote { margin: 1rem 0; padding: .5rem 1.125rem; border-left: 3px solid var(--accent); background: var(--secondary); border-radius: 0 6px 6px 0; }
blockquote p { margin: .4375rem 0; }
strong { font-weight: 600; }
hr { border: 0; border-top: 1px solid var(--border); margin: 2rem 0; }

table { width: 100%; border-collapse: collapse; margin: 1rem 0; font-size: .875rem; line-height: 1.6; }
th, td { border: 1px solid var(--border); padding: .4375rem .875rem; text-align: left; vertical-align: top; overflow-wrap: anywhere; }
th { background: var(--secondary); font-weight: 600; }
tbody tr:hover td { background: var(--muted-bg); }

@media (max-width: 768px) {
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

// ---------- 鉴权 ----------
// POST /api/report:HMAC-SHA256(密钥, ts || 原始请求字节)。对 gzip 后的字节签名(=链路上实际传输的字节),
// 服务端先验签、再解压/解析——垃圾请求在 gunzip 前就被挡掉,且与客户端签名对象严格一致(签未压缩 JSON 而发
// gzip 字节会永远验不过)。ts 恒 13 位毫秒(2286 年前 update 链无拼接歧义)。
// 窗口 ±15min:容忍成员机(笔记本)与服务端时钟偏移;窗口内重放因 upsert 幂等(lastActive 旧值不覆盖)无害,不加 nonce。
const REPORT_TS_WINDOW_MS = 15 * 60_000;

function verifyReportSig(secret: string, tsHeader: string | null, sigHeader: string | null, body: Buffer): boolean {
  const ts = tsHeader ?? "";
  if (!/^\d{13}$/.test(ts)) return false; // 格式门:先挡垃圾输入
  if (Math.abs(Date.now() - Number(ts)) > REPORT_TS_WINDOW_MS) return false;
  const expect = createHmac("sha256", secret).update(ts).update(body).digest();
  const got = Buffer.from(sigHeader ?? "", "hex"); // 非法 hex 静默截断,由长度检查兜住
  if (got.length !== expect.length) return false; // timingSafeEqual 长度不等会 throw,先比长度(长度非秘密)
  return timingSafeEqual(got, expect);
}

// 未配 reportSecret 的放行警告只打一次:迁移期兼容老 daemon(不带签名),但不刷屏。
let warnedNoSecret = false;

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

      // 读接口鉴权:配了 viewToken 后,/api/*(health 探活除外;report 走下方 HMAC)必须带 ?t= 或 Bearer。
      // 静态页(/、/ui/*、/docs)保持开放(与 shine-worklog daemon 同口径);看板链接形如 /?t=<viewToken>。
      {
        const { viewToken } = readAuthConfig();
        if (viewToken && path.startsWith("/api/") && path !== "/api/report") {
          const q = url.searchParams.get("t");
          const auth = req.headers.get("authorization");
          if (q !== viewToken && auth !== `Bearer ${viewToken}`) {
            return json(req, { error: "unauthorized" }, 401);
          }
        }
      }

      if (path === "/api/report" && req.method === "POST") {
        // body 只读一次(Fetch body 是流,消费两次会抛错):先按原始字节验 HMAC,通过后再解压/解析。
        const raw = Buffer.from(await req.arrayBuffer());
        const { reportSecret } = readAuthConfig();
        if (reportSecret) {
          const ok = verifyReportSig(reportSecret, req.headers.get("x-report-ts"), req.headers.get("x-report-sig"), raw);
          if (!ok) return json(req, { error: "unauthorized" }, 401);
        } else if (!warnedNoSecret) {
          // 迁移期:未配密钥放行(兼容不带签名的老 daemon),但公网部署必须配置,首条打警告提示
          warnedNoSecret = true;
          console.warn("[tokenserver] 未配置 reportSecret(config.json 或 env TOKENSERVER_REPORT_SECRET),POST /api/report 不验签,公网部署有被伪造上报风险");
        }
        let body: ReportResponse;
        try {
          body = JSON.parse(
            (req.headers.get("content-encoding") ?? "").toLowerCase().includes("gzip")
              ? gunzipSync(raw).toString("utf8")
              : raw.toString("utf8"),
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
