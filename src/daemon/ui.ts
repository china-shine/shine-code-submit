// 查看页静态资源：编译期嵌入二进制。
// ui-assets.ts 由 scripts/build.ts 从 ui/* 生成为字符串常量，bun build --compile 时随 daemon 嵌入。
// （不走 Bun import attribute：tsc 在 bundler 模式会把 .html/.css 当 bun-types 的 HTMLBundle/CSSBundle、
//   把 app.js 当真实模块解析，类型与解析都报错；生成字符串模块最稳。）
import { INDEX_HTML, APP_JS, STYLE_CSS } from "./ui-assets";

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
};

// 路径 → 嵌入内容（内存取，天然无路径穿越风险）
const ASSETS: Record<string, { body: string; ext: string }> = {
  "/": { body: INDEX_HTML, ext: ".html" },
  "/ui": { body: INDEX_HTML, ext: ".html" },
  "/ui/": { body: INDEX_HTML, ext: ".html" },
  "/ui/index.html": { body: INDEX_HTML, ext: ".html" },
  "/ui/app.js": { body: APP_JS, ext: ".js" },
  "/ui/style.css": { body: STYLE_CSS, ext: ".css" },
};

export function serveUi(_req: Request, url: URL): Response {
  const asset = ASSETS[url.pathname];
  if (!asset) return new Response("not found", { status: 404 });
  return new Response(asset.body, {
    headers: {
      "content-type": CONTENT_TYPES[asset.ext] ?? "application/octet-stream",
      // 开发期 UI 常更新，URL 无 hash，禁止缓存避免改了不生效
      "cache-control": "no-store, must-revalidate",
    },
  });
}
