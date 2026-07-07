#!/usr/bin/env node
// shine-code-submit hook 平台分发器（.cjs 强制 CommonJS，兼容所有 node，不依赖 package.json）。
// Claude Code 经 hooks.json 以 `node launcher.cjs <Event>` 调用（exec form，不经 shell）。
// 优先 spawn 同目录 bin/<plat>-<arch>/hook[.exe]（二进制模式，本机 build 产物）；
// 不存在则 bun run src/hook/main.ts（源码模式）。
// 源码模式需要 Bun——若没装，首次自动安装（npm i -g bun → 失败回退官方脚本），
// 安装过程逐行流式输出（hook stdout + 日志文件，可 tail -f 看实时进度）。退出码恒 0。
const { spawn, spawnSync } = require("node:child_process");
const readline = require("node:readline");
const { existsSync, mkdirSync, appendFileSync } = require("node:fs");
const { join } = require("node:path");
const { homedir } = require("node:os");

const here = __dirname; // .../bin/
const plat = process.platform === "win32" ? "windows" : process.platform; // darwin | linux | windows
const arch = process.arch; // x64 | arm64
const ext = process.platform === "win32" ? ".exe" : "";
const hookBin = join(here, `${plat}-${arch}`, `hook${ext}`);
const hookSrc = join(here, "..", "src", "hook", "main.ts"); // 源码模式入口

const argv = process.argv.slice(2);
const event = argv[0];
const SHELL = process.platform === "win32";

/** 找 bun：先 PATH，再常见安装位置（官方脚本装到 ~/.bun/bin，npm -g 装到全局 bin）。 */
function findBun() {
  // shell 模式用单字符串（避免 Node 的 "args + shell:true" 弃用警告污染 hook stderr）
  const r = SHELL
    ? spawnSync("bun --version", { shell: true, encoding: "utf8" })
    : spawnSync("bun", ["--version"], { encoding: "utf8" });
  if (r.status === 0 && (r.stdout || "").trim()) return "bun";
  const home = homedir();
  const cands = process.platform === "win32"
    ? [join(home, ".bun", "bin", "bun.exe"), join(home, ".bun", "bin", "bun")]
    : [join(home, ".bun", "bin", "bun"), "/usr/local/bin/bun", "/opt/homebrew/bin/bun"];
  for (const c of cands) if (existsSync(c)) return c;
  return null;
}

/** 日志文件路径（创建目录）。安装过程逐行写这里，可 `tail -f` 看实时进度。 */
function logFile() {
  const dir = join(homedir(), ".local", "share", "shine-code-submit", "log");
  try { mkdirSync(dir, { recursive: true }); } catch {}
  return join(dir, "bun-install.log");
}

/** 跑一条 shell 命令，stdout/stderr 逐行流式：写日志 +（仅 SessionStart）转发到 hook stdout。 */
function streamCmd(cmd, file, toStdout) {
  return new Promise((resolve) => {
    const w = (s) => { try { appendFileSync(file, s); } catch {} };
    w(`\n[${new Date().toISOString()}] $ ${cmd}\n`);
    let child;
    try {
      child = spawn(cmd, { shell: true, stdio: ["ignore", "pipe", "pipe"] });
    } catch {
      w("[spawn error]\n");
      resolve(1);
      return;
    }
    for (const stream of [child.stdout, child.stderr]) {
      if (!stream) continue;
      readline.createInterface({ input: stream, crlfDelay: Infinity }).on("line", (line) => {
        w(line + "\n");
        if (toStdout) process.stdout.write(line + "\n");
      });
    }
    child.on("error", () => { w("[child error]\n"); resolve(1); });
    child.on("exit", (code) => { w(`[exit ${code}]\n`); resolve(code ?? 1); });
  });
}

/** 装 bun：npm i -g bun → 失败回退官方脚本。每步逐行流式输出。返回 bun 路径或 null。 */
async function installBun(toStdout) {
  const file = logFile();
  const step = async (cmd) => { await streamCmd(cmd, file, toStdout); return findBun(); };
  let b = await step("npm install -g bun");
  if (b) return b;
  const official = process.platform === "win32"
    ? 'powershell -c "irm bun.sh/install.ps1 | iex"'
    : "curl -fsSL https://bun.sh/install | bash";
  return step(official);
}

function runChild(cmd, args, opts) {
  const child = spawn(cmd, args, opts);
  child.on("error", () => process.exit(0));
  child.on("exit", () => process.exit(0));
}

(async () => {
  try {
    if (existsSync(hookBin)) {
      // 二进制模式：spawn 本地已 build 的 hook
      runChild(hookBin, argv, { stdio: "inherit" });
      return;
    }
    // 源码模式：bun run src/hook/main.ts（Windows 需 shell 找 bun.exe）
    let bun = findBun();
    if (!bun) {
      // 只在 SessionStart 把进度打到 stdout（其它 hook 的 stdout 可能被 Claude Code 按 JSON 解析）
      const show = event === "SessionStart";
      if (show) {
        console.log("");
        console.log("⏳ shine-code-submit: 未检测到 Bun 运行时，首次自动安装中（约 10-30s）");
        console.log("   实时进度可另开终端: tail -f " + logFile());
      }
      bun = await installBun(show);
      if (show) console.log(bun ? "✅ Bun 就绪，继续启动…" : "❌ Bun 自动安装失败。请手动装: https://bun.sh （装完重开会话即可，事件不丢）");
    }
    if (!bun) process.exit(0);
    runChild(bun, ["run", hookSrc, ...argv], { stdio: "inherit", shell: SHELL });
  } catch {
    process.exit(0);
  }
})();
