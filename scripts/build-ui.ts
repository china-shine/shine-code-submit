#!/usr/bin/env bun
// 只重新生成 src/daemon/ui-assets.ts（ui/* → 字符串常量），不 build 任何 exe。
// 开发期改了 ui/*.tsx 后跑：bun run build:ui，再重启 daemon 即生效。
// 逻辑与 scripts/build.ts 的 ui 段完全一致（同口径），只是剥离了 exe 编译。
import { $ } from "bun";

const UI_BUNDLE = "ui/.build/app.js";
await $`mkdir -p ui/.build`;
const uiBuild = await Bun.build({
  entrypoints: ["ui/app.tsx"],
  outdir: "ui/.build",
  target: "browser",
  format: "esm",
  minify: true,
  define: { "process.env.NODE_ENV": '"production"' },
});
if (!uiBuild.success) {
  throw new Error("ui bundle failed:\n" + uiBuild.logs.join("\n"));
}
process.stdout.write(`bundle ui/app.tsx -> ${UI_BUNDLE}\n`);

const [uiHtml, uiJs, uiCss] = await Promise.all([
  Bun.file("ui/index.html").text(),
  Bun.file(UI_BUNDLE).text(),
  Bun.file("ui/style.css").text(),
]);
await Bun.write(
  "src/daemon/ui-assets.ts",
  `// AUTO-GENERATED from ui/* by scripts/build.ts. Do not edit by hand.
export const INDEX_HTML = ${JSON.stringify(uiHtml)};
export const APP_JS = ${JSON.stringify(uiJs)};
export const STYLE_CSS = ${JSON.stringify(uiCss)};
`,
);
process.stdout.write("✓ ui-assets regenerated (no exe built)\n");
