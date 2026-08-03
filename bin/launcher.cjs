#!/usr/bin/env node
// shine-worklog hook 平台分发器（.cjs 强制 CommonJS，兼容所有 node，不依赖 package.json）。
// Claude Code 经 hooks.json 以 `node launcher.cjs <Event>` 调用（exec form，不经 shell）。
// 优先 spawn 同目录 bin/<plat>-<arch>/hook[.exe]（二进制模式，本机 build 产物）；
// 不存在则 bun run src/hook/main.ts（源码模式）。源码模式需要 Bun——若没装，首次自动安装
// （npm i -g bun → 失败回退官方脚本）。退出码恒 0——绝不影响 Claude Code 主进程。
//
// ⚠️ Claude Code 的 SessionStart hook 把 stdout 当【单个 JSON 对象】解析（提取 systemMessage 展示）。
// 所以:① 进度/提示绝不能写 stdout(混入纯文本会让整个 stdout JSON 解析失败、链接也不显示)——走 stderr + 日志。
// ② 装完 Bun 后,把「安装完成」提示与 hook 产出的 Dashboard 链接【合并成一条 systemMessage】发 stdout,
//    确保交互式 claude 里一定能看到(systemMessage 字段已被验证会显示)。
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
  // shell 模式用单字符串（避免 Node 的 "args + shell:true" 弃用警告污染 stderr）
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
  const dir = join(homedir(), ".local", "share", "shine-worklog", "log");
  try { mkdirSync(dir, { recursive: true }); } catch {}
  return join(dir, "bun-install.log");
}

/** 跑一条 shell 命令，stdout/stderr 逐行流式：写日志 +（仅 SessionStart）转发到 hook stderr。 */
function streamCmd(cmd, file, toStderr) {
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
        if (toStderr) process.stderr.write(line + "\n");
      });
    }
    child.on("error", () => { w("[child error]\n"); resolve(1); });
    child.on("exit", (code) => { w(`[exit ${code}]\n`); resolve(code ?? 1); });
  });
}

/** 装 bun：npm i -g bun → 失败回退官方脚本。每步逐行流式（stderr + 日志）。返回 bun 路径或 null。 */
async function installBun(toStderr) {
  const file = logFile();
  const step = async (cmd) => { await streamCmd(cmd, file, toStderr); return findBun(); };
  let b = await step("npm install -g bun");
  if (b) return b;
  const official = process.platform === "win32"
    ? 'powershell -c "irm bun.sh/install.ps1 | iex"'
    : "curl -fsSL https://bun.sh/install | bash";
  return step(official);
}

/** 只发一条 systemMessage 到 stdout（Claude Code 把 systemMessage 显示给用户）。 */
function tellUser(msg) {
  process.stdout.write(JSON.stringify({ systemMessage: msg }));
}

/** spawn 子进程、inherit stdio、子退出即本进程退出（二进制模式 / 有 Bun 的源码模式用）。 */
function runInherit(cmd, args) {
  const child = spawn(cmd, args, { stdio: "inherit", shell: SHELL && cmd !== hookBin });
  child.on("error", () => process.exit(0));
  child.on("exit", () => process.exit(0));
}

/**
 * 刚装完 Bun 时跑 hook:捕获 hook 的 stdout(其中的 {systemMessage: Dashboard 链接}),与「安装完成」
 * 提示合并成【一条】systemMessage 再发 stdout。为什么不直接 inherit:若额外打一行纯文本提示会污染
 * stdout、让 JSON 解析失败;所以合并成单个 JSON,确保用户一定能看到「装好了 + 链接」。
 */
function runHookMerged(bun, installNote) {
  const child = spawn(bun, ["run", hookSrc, ...argv], { stdio: ["inherit", "pipe", "inherit"], shell: SHELL });
  let out = "";
  child.stdout.on("data", (d) => { out += d.toString(); });
  child.on("error", () => { tellUser(installNote); process.exit(0); });
  child.on("exit", () => {
    let linkMsg = "";
    try { linkMsg = JSON.parse((out || "").trim()).systemMessage || ""; } catch {}
    tellUser(linkMsg ? `${installNote}\n${linkMsg}` : installNote);
    process.exit(0);
  });
}

(async () => {
  try {
    if (existsSync(hookBin)) {
      // 二进制模式：spawn 本地已 build 的 hook（不经 bun、不需 shell）
      runInherit(hookBin, argv);
      return;
    }
    // 源码模式：bun run src/hook/main.ts
    let bun = findBun();
    if (!bun) {
      const show = event === "SessionStart";
      if (show) {
        console.error("");
        console.error("⏳ shine-worklog: 未检测到 Bun 运行时，首次自动安装中（约 10-30s）");
        console.error("   实时进度可另开终端: tail -f " + logFile());
      }
      bun = await installBun(show);
      if (!bun) {
        // 失败也走 systemMessage,确保用户看到(而不是静默)
        if (show) tellUser("❌ shine-worklog: Bun 自动安装失败。请手动装 Bun（https://bun.sh）后重开会话；事件不丢。");
        process.exit(0);
      }
      // 装好了:合并「安装完成 + Dashboard 链接」为一条 systemMessage,确保用户看到
      if (show) { runHookMerged(bun, "✅ shine-worklog: 已自动安装 Bun 运行时，继续启动。"); return; }
    }
    runInherit(bun, ["run", hookSrc, ...argv]);
  } catch {
    process.exit(0);
  }
})();
