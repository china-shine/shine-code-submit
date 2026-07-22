#!/usr/bin/env node
// install CLI 入口:install / uninstall / status。由 node 跑(编译成 dist/install.cjs)。
// npx shine-code-submit install → 自动装 bun + 部署 plugin + 注册 + 启 daemon + 开 dashboard。
//
// --silent:自动更新后台升级用(由 daemon 的 updater.ts 传入)。静默所有进度输出,
//   诊断/致命错误改落 LOG_DIR/install.log,绝不在用户屏幕弹控制台喷日志(见 error.png 的教训)。
// --force:强制重新部署 + bun install(绕过同版本幂等短路),排错/手动重装用。
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { ensureBun } from "./bun";
import { cacheDir, deployPlugin } from "./deploy";
import { enablePlugin, registerMarketplace, registerPlugin, unregisterAll } from "./register";
import { PUBLIC_BASE_URL, SERVICE_VERSION } from "../shared/config";
import { isOursAlive, openBrowser, probeDaemon, spawnHidden, stopDaemon } from "../shared/daemonctl";
import { ensureDirs } from "../shared/paths";
import { readPidFile } from "../shared/pidfile";
import { info, setSilent, warn } from "./log";

// 静默 node 自身的 DEP0190 噪音:bun install / 起 daemon 用 spawn(bun,[...],{shell:true})(Windows
// 下 bun 经 shell 调用更稳),命中 "Passing args to a child process with shell option" 弃用警告。
// 该警告对功能零影响,但在 --silent 自动更新路径下会污染输出,统一关掉。
process.noDeprecation = true;

const args = process.argv.slice(2);
// --silent/-s 显式 flag,或 daemon 自动更新经 env SHINE_SILENT=1 触发(env 经 npx/wscript 链无解析歧义,
// 不依赖 npx 是否吞掉包名后的 --silent flag,跨 npm 版本都稳)。
const silent = args.includes("--silent") || args.includes("-s") || process.env.SHINE_SILENT === "1";
const force = args.includes("--force");
setSilent(silent);
// cmd = 首个非 flag 参数(跳过 --silent/-s/--force),保留 --version/-v 当命令用。
const cmd = args.find((a) => a !== "--silent" && a !== "-s" && a !== "--force");

main().catch((err) => {
  warn(`[shine-code-submit] ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});

async function main(): Promise<void> {
  switch (cmd) {
    case undefined:
    case "install":
      await runInstall();
      break;
    case "uninstall":
      await runUninstall();
      break;
    case "status":
      await runStatus();
      break;
    case "--version":
    case "-v":
      console.log(SERVICE_VERSION);
      break;
    default:
      printHelp();
  }
}

async function runInstall(): Promise<void> {
  info(`=== shine-code-submit installer v${SERVICE_VERSION} ===`);
  const bunPath = await ensureBun();
  const cachePath = deployPlugin(bunPath, { force });
  registerMarketplace(cachePath);
  registerPlugin(cachePath);
  enablePlugin(cachePath);
  ensureDirs();
  await startDaemonWithBun(bunPath, cachePath);
  openDashboard();
  info("");
  info("✓ 安装完成。");
  info("  · 重启 Claude Code 后,/plugin 列表会显示 shine-code-submit(已启用)。");
  info("  · 开新会话即触发 SessionStart hook,事件出现在 dashboard。");
}

async function runUninstall(): Promise<void> {
  info("=== shine-code-submit uninstaller ===");
  await stopDaemon();
  unregisterAll();
  const target = cacheDir();
  if (existsSync(target)) {
    rmSync(target, { recursive: true, force: true });
    info(`[shine-code-submit] 已删除 ${target}`);
  }
  info("✓ 已卸载。重启 Claude Code 后 /plugin 不再显示。");
}

async function runStatus(): Promise<void> {
  const alive = await isOursAlive();
  const pid = readPidFile();
  if (alive && pid) {
    console.log(`daemon: running  pid=${pid.pid}  ${PUBLIC_BASE_URL}`);
  } else {
    console.log("daemon: not running");
  }
}

/** 用显式 bunPath 拉 daemon。不调 daemonctl.spawnDaemon——它用 process.execPath,install 场景是 node 会出错。
 *  版本感知:已是当前 SERVICE_VERSION 则复用;旧版在跑则停旧启新(daemon 自守,必须先停后启);没跑则直接启。 */
async function startDaemonWithBun(bunPath: string, cachePath: string): Promise<void> {
  const probe = await probeDaemon();
  if (probe.alive && probe.version === SERVICE_VERSION) {
    info(`[shine-code-submit] daemon 已是最新 v${SERVICE_VERSION},跳过启动`);
    return;
  }
  if (probe.alive) {
    info(`[shine-code-submit] daemon 旧版 v${probe.version} 运行中,重启到 v${SERVICE_VERSION}...`);
    await stopDaemon();
  } else {
    info("[shine-code-submit] 启动 daemon...");
  }
  const daemonSrc = join(cachePath, "src", "daemon", "main.ts");
  try {
    // Windows 走 wscript VBS 隐藏(shell:true 孙进程 bun→daemon 弹窗,windowsHide 管不到),复用 daemonctl.spawnHidden
    const q = (p: string): string => (/\s/.test(p) ? `"${p}"` : p);
    spawnHidden(`${q(bunPath)} run ${q(daemonSrc)}`, { cwd: cachePath });
  } catch (err) {
    warn(`[shine-code-submit] 启动 daemon 失败:${err instanceof Error ? err.message : err}`);
    warn("  plugin 已注册,Claude Code 重启后 hook 会自动拉起 daemon");
    return;
  }
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    await sleep(200);
    const p = await probeDaemon();
    if (p.alive && p.version === SERVICE_VERSION) {
      info("[shine-code-submit] daemon 已就绪");
      return;
    }
  }
  warn(
    "[shine-code-submit] daemon 启动超时(10s)。plugin 已注册,可稍后手动 `shine-code-submit start` 或重启 claude。",
  );
}

function openDashboard(): void {
  const pid = readPidFile();
  const url = pid ? `${PUBLIC_BASE_URL}/ui?t=${pid.token}` : `${PUBLIC_BASE_URL}/ui`;
  info(`[shine-code-submit] Dashboard: ${url}`);
  // 自动弹浏览器暂时关闭——Dashboard 链接仍打印在上一行,用户可自行点开。
  // 想恢复:把下面 try/catch 取消注释(openBrowser(url))。
  // try {
  //   openBrowser(url);
  // } catch {
  //   /* 打开失败不阻塞 */
  // }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function printHelp(): void {
  // help 走 console.log 不受 silent 影响:用户显式打错命令时应看到帮助。
  console.log(`shine-code-submit <command>

  install     安装插件(自动装 bun + 部署 + 注册 + 启 daemon + 开 dashboard)
              flags: --silent(静默,自动更新用) --force(强制重装,绕过同版本幂等)
  uninstall   卸载(停 daemon + 反注册 + 删文件)
  status      显示 daemon 状态

通常通过 npx 跑:npx shine-code-submit install`);
  process.exit(cmd ? 1 : 0);
}
