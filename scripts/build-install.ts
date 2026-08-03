// 编译 install CLI → dist/install.cjs(CJS, target=node, 零依赖单文件)。
// install CLI 必须由 node 跑(跑 install 时 bun 可能还没装),所以编译成 CommonJS 单文件,
// 把 src/install/* + 复用的 src/shared/* 全 bundle 进去,运行时只用 node 内置模块。
// (跟 bin/launcher.cjs 同理:.cjs 强制 CommonJS,跨 npx/npm-g/直接 node 都稳。)
import { chmodSync, mkdirSync } from "node:fs";

const out = await Bun.build({
  entrypoints: ["src/install/main.ts"],
  outdir: "dist",
  naming: "install.cjs",
  format: "cjs",
  target: "node",
  minify: true,
  define: { "process.env.NODE_ENV": '"production"' },
});

if (!out.success) {
  for (const log of out.logs) console.error(log);
  process.exit(1);
}

mkdirSync("dist", { recursive: true });
// dist/install.cjs 是 npm bin(npx 经 node_modules/.bin/<pkg> 符号链接 + shebang 执行)。
// 必须可执行,否则 Linux 上 npx 跑它报 "shine-worklog: Permission denied"(tarball 保留 +x 位)。
chmodSync("dist/install.cjs", 0o755);
console.log("✓ build install CLI -> dist/install.cjs");
