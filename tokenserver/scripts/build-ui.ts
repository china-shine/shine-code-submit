#!/usr/bin/env bun
// 把 ui/app.tsx 打包成 ui/.build/app.js（browser esm, minify, production）。
// React 一并打入 app.js,运行时无需前端 node_modules。改 UI 后重新跑此脚本。
// 用 import.meta.dir 定位,不依赖 cwd。
import { $ } from "bun";
import { mkdirSync, readFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";

const UI_DIR = join(import.meta.dir, "..", "ui");
const OUT_DIR = join(UI_DIR, ".build");
mkdirSync(OUT_DIR, { recursive: true });

// 编译 tailwind css -> .build/style.css(与 app.js 同目录,供 server.ts 开发态读取 / build.ts 内联)
await $`bunx @tailwindcss/cli -i ${join(UI_DIR, "styles", "index.css")} -o ${join(OUT_DIR, "style.css")} --minify`;
console.log("css compiled -> " + join(OUT_DIR, "style.css"));

// 追加 react-day-picker 官方默认样式(纯 CSS,无 @import),随 /ui/style.css 一起下发(避开 build 不产 CSS 输出的问题)。
const rdpCss = readFileSync(join(import.meta.dir, "..", "node_modules", "react-day-picker", "src", "style.css"), "utf8");
appendFileSync(join(OUT_DIR, "style.css"), "\n/* react-day-picker default style */\n" + rdpCss);
console.log("rdp style appended -> " + join(OUT_DIR, "style.css"));

const uiBuild = await Bun.build({
  entrypoints: [join(UI_DIR, "app.tsx")],
  outdir: OUT_DIR,
  target: "browser",
  format: "esm",
  minify: true,
  define: { "process.env.NODE_ENV": '"production"' },
});
if (!uiBuild.success) {
  throw new Error("ui bundle failed:\n" + uiBuild.logs.join("\n"));
}
console.log("ui bundled -> " + join(OUT_DIR, "app.js"));
