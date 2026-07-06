#!/usr/bin/env bun
// 编译 hook/cli/daemon 为单文件可执行（bun build --compile），产出到 bin/<plat>-<arch>/。
// plugin 的 bin/launcher.js 按 process.platform/process.arch 选对应目录的二进制 spawn。
// daemon 入口经 ui.ts 引用 build 时生成的 src/daemon/ui-assets.ts（ui/ 静态资源字符串）。
//
// 用法：
//   bun run build        仅本机平台（开发自测 + 单平台发布）
//   bun run build:all    6 平台交叉编译（全平台发布）
import { $ } from "bun";
import { join } from "node:path";
import { existsSync, renameSync, unlinkSync } from "node:fs";

const ENTRIES: Array<[string, string]> = [
  ["src/hook/main.ts", "hook"],
  ["src/cli/main.ts", "cli"],
  ["src/daemon/main.ts", "daemon"],
];

// Bun --target 名 → 目录名（platform-arch）
const TARGETS: Array<[string, string]> = [
  ["bun-windows-x64", "windows-x64"],
  ["bun-windows-arm64", "windows-arm64"],
  ["bun-darwin-x64", "darwin-x64"],
  ["bun-darwin-arm64", "darwin-arm64"],
  ["bun-linux-x64", "linux-x64"],
  ["bun-linux-arm64", "linux-arm64"],
];

const buildAll = process.argv.includes("--all");

// Windows 下目标 exe 可能正被运行中的 daemon 持有（本仓库 hook 会自动拉起 daemon），
// bun build --compile 把临时文件 rename 到目标会 EPERM。运行中的 exe 可改名不可删，故先挪到 .old。
function stashExisting(p: string): void {
  try {
    const old = `${p}.old`;
    if (existsSync(old)) {
      try { unlinkSync(old); } catch { /* 仍被旧进程持有，留着 */ }
    }
    if (existsSync(p)) renameSync(p, old);
  } catch {
    /* 忽略：交由 bun build 自行处理 */
  }
}

const isWin = process.platform === "win32";
const nativePlat = isWin ? "windows" : process.platform; // windows | darwin | linux
const nativeDir = `${nativePlat}-${process.arch}`;

const dirs: string[] = buildAll ? TARGETS.map(([, d]) => d) : [nativeDir];

// 先把 ui/app.tsx 打包成单个 ESM bundle（React / marked 一并打入），再字符串化嵌入 daemon。
// 用 Bun.build API 以便传 define：React 据 process.env.NODE_ENV 选 dev/prod bundle，
// 必须 inline 成 "production"，否则 React 按默认打成 dev 版（jsxDEV）运行时报错。
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

await $`mkdir -p bin`;
for (const dir of dirs) {
  const plat = dir.split("-")[0]; // windows | darwin | linux
  const outExt = plat === "windows" ? ".exe" : "";
  const target = buildAll ? TARGETS.find(([, d]) => d === dir)![0] : null;
  for (const [entry, name] of ENTRIES) {
    const out = join("bin", dir, name + outExt);
    stashExisting(out);
    process.stdout.write(`build ${entry} -> ${out}${target ? ` (${target})` : ""}\n`);
    if (target) {
      await $`bun build --compile --minify --target ${target} --outfile ${out} ${entry}`;
    } else {
      await $`bun build --compile --minify --outfile ${out} ${entry}`;
    }
  }
}
process.stdout.write("✓ build done\n");
