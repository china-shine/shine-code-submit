#!/usr/bin/env bun
// 打包 Linux x64 单文件二进制:
// 0. 编译 tailwind css -> ui/.build/style.css
// 1. bundle ui/app.tsx -> ui/.build/app.js
// 2. 生成 src/ui-assets.ts(INDEX_HTML/APP_JS/STYLE_CSS 字符串,编译时内联)
// 3. bun build --compile --target bun-linux-x64 src/main.ts -> bin/tokenserver-linux-x64
import { $ } from "bun";
import { mkdirSync, readFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";

const TS_ROOT = join(import.meta.dir, "..");
const UI_DIR = join(TS_ROOT, "ui");
const BUILD_DIR = join(UI_DIR, ".build");
mkdirSync(BUILD_DIR, { recursive: true });

// 0. 编译 tailwind css + 追加 react-day-picker 官方样式(随 style.css 内联进二进制)
console.log("0. compiling tailwind css");
await $`bunx @tailwindcss/cli -i ${join(UI_DIR, "styles", "index.css")} -o ${join(BUILD_DIR, "style.css")} --minify`;
const rdpCss = readFileSync(join(TS_ROOT, "node_modules", "react-day-picker", "src", "style.css"), "utf8");
const RDP_TWEAK = "\n/* tokenserver tweak: smaller calendar */\n.rdp-root{--rdp-day-width:2rem;--rdp-day-height:2rem;--rdp-day_button-width:1.85rem;--rdp-day_button-height:1.85rem;--rdp-nav_button-width:1.5rem;--rdp-nav_button-height:1.5rem;}.rdp-root *{font-size:12px;}\n";
appendFileSync(join(BUILD_DIR, "style.css"), "\n/* react-day-picker default style */\n" + rdpCss + RDP_TWEAK);
console.log("0. rdp style appended");

// 1. bundle UI
const uiBuild = await Bun.build({
  entrypoints: [join(UI_DIR, "app.tsx")],
  outdir: BUILD_DIR,
  target: "browser",
  format: "esm",
  minify: true,
  define: { "process.env.NODE_ENV": '"production"' },
});
if (!uiBuild.success) {
  throw new Error("ui bundle failed:\n" + uiBuild.logs.join("\n"));
}
console.log("1. ui bundled -> " + join(BUILD_DIR, "app.js"));

// 2. 生成 ui-assets.ts(字符串化内联)
const [html, js, css] = await Promise.all([
  Bun.file(join(UI_DIR, "index.html")).text(),
  Bun.file(join(BUILD_DIR, "app.js")).text(),
  Bun.file(join(BUILD_DIR, "style.css")).text(),
]);
await Bun.write(
  join(TS_ROOT, "src", "ui-assets.ts"),
  "// AUTO-GENERATED from ui/* by scripts/build.ts. Do not edit by hand.\n" +
    "export const INDEX_HTML = " + JSON.stringify(html) + ";\n" +
    "export const APP_JS = " + JSON.stringify(js) + ";\n" +
    "export const STYLE_CSS = " + JSON.stringify(css) + ";\n",
);
console.log("2. src/ui-assets.ts generated");

// 3. 编译 Linux x64 单文件二进制
const BIN_DIR = join(TS_ROOT, "bin");
mkdirSync(BIN_DIR, { recursive: true });
const out = join(BIN_DIR, "tokenserver-linux-x64");
console.log("3. compiling linux-x64 -> " + out);
await $`bun build --compile --minify --target bun-linux-x64 --outfile ${out} ${join(TS_ROOT, "src", "main.ts")}`;
console.log("✓ build done: " + out);
