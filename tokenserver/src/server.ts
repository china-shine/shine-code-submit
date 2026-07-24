// HTTP 路由:API(health/report/reports) + 静态资源。
// 静态资源双模式:开发(bun run src)读文件(改 HTML/CSS 直接刷新);
// 编译(二进制)用内联 ui-assets(因二进制内无 ui/ 文件)。
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { gzipSync, gunzipSync } from "node:zlib";
import { createHash } from "node:crypto";
import { saveReport, getStats, getSessions, getMember, type Granularity } from "./store";
import type { ReportResponse } from "./types";
import { APP_JS, INDEX_HTML, STYLE_CSS } from "./ui-assets";

const PORT = Number(process.env.PORT ?? 36667);
const HOST = "0.0.0.0";

const UI_DIR = join(import.meta.dir, "..", "ui");

const ASSETS: Record<string, { file: string; inline: string; type: string }> = {
  "/": { file: "index.html", inline: INDEX_HTML, type: "text/html; charset=utf-8" },
  "/index.html": { file: "index.html", inline: INDEX_HTML, type: "text/html; charset=utf-8" },
  "/ui/app.js": { file: ".build/app.js", inline: APP_JS, type: "application/javascript; charset=utf-8" },
  "/ui/style.css": { file: ".build/style.css", inline: STYLE_CSS, type: "text/css; charset=utf-8" },
};

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

      // 会话明细分页(RecentSessionsTable 翻页查 DB)
      if (path === "/api/sessions" && req.method === "GET") {
        const { from, to } = parseDateRange(url.searchParams.get("start"), url.searchParams.get("end"));
        const members = (url.searchParams.get("members") ?? "").split(",").filter(Boolean);
        const member = url.searchParams.get("member") ?? undefined;
        const page = Math.max(1, parseInt(url.searchParams.get("page") ?? "1", 10) || 1);
        const pageSize = Math.max(1, parseInt(url.searchParams.get("pageSize") ?? "20", 10) || 20);
        return json(req, getSessions({ from, to, members, member }, page, pageSize));
      }

      // 单成员 KPI + 趋势(MemberDetailPage;团队均值复用 /api/stats)
      if (path.startsWith("/api/member/") && req.method === "GET") {
        const gitUser = decodeURIComponent(path.slice("/api/member/".length));
        const { from, to } = parseDateRange(url.searchParams.get("start"), url.searchParams.get("end"));
        const gRaw = url.searchParams.get("granularity");
        const granularity: Granularity = gRaw === "week" || gRaw === "month" ? gRaw : "day";
        return json(req, getMember(gitUser, { from, to, granularity }));
      }

      const asset = await serveAsset(path, req);
      if (asset) return asset;

      return json(req, { error: "not found" }, 404);
    },
  });
}
