// HTTP 路由:API(health/report/reports) + 静态资源。
// 静态资源双模式:开发(bun run src)读文件(改 HTML/CSS 直接刷新);
// 编译(二进制)用内联 ui-assets(因二进制内无 ui/ 文件)。
import { existsSync } from "node:fs";
import { join } from "node:path";
import { aggregate, saveReport, type UserAgg } from "./store";
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

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function serveAsset(path: string): Response | null {
  const a = ASSETS[path];
  if (!a) return null;
  const filePath = join(UI_DIR, a.file);
  if (existsSync(filePath)) {
    return new Response(Bun.file(filePath), {
      headers: { "content-type": a.type, "cache-control": "no-store" },
    });
  }
  return new Response(a.inline, { headers: { "content-type": a.type } });
}

export function startServer() {
  return Bun.serve({
    hostname: HOST,
    port: PORT,
    async fetch(req) {
      const url = new URL(req.url);
      const path = url.pathname;

      if (path === "/api/health" && req.method === "GET") {
        return json({ service: "tokenserver", ok: true, ts: Date.now() });
      }

      if (path === "/api/report" && req.method === "POST") {
        let body: ReportResponse;
        try {
          body = await req.json();
        } catch {
          return json({ error: "bad json" }, 400);
        }
        if (!body || !Array.isArray(body.projects)) {
          return json({ error: "invalid report: projects missing" }, 400);
        }
        saveReport(body);
        return json({ status: "ok" });
      }

      if (path === "/api/reports" && req.method === "GET") {
        const users: UserAgg[] = aggregate();
        return json({ users });
      }

      const asset = serveAsset(path);
      if (asset) return asset;

      return json({ error: "not found" }, 404);
    },
  });
}
