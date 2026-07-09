// shine-code-submit CLI：status / start / stop / restart / ui。
// 用户侧管理命令。token 从 pid 文件读取。
import { BASE_URL, PUBLIC_BASE_URL } from "../shared/config";
import { readPidFile } from "../shared/pidfile";
import { ensureDaemon, isOursAlive, openBrowser, spawnDaemon, stopDaemon } from "../shared/daemonctl";
import { autoUpdateIfNeeded } from "../shared/updater";

const [cmd] = process.argv.slice(2);

switch (cmd) {
  case "status":
    void cmdStatus();
    break;
  case "start":
    void cmdStart();
    break;
  case "stop":
    void cmdStop();
    break;
  case "restart":
    void cmdRestart();
    break;
  case "ui":
    void cmdUi();
    break;
  case "update":
    void cmdUpdate();
    break;
  default:
    printHelp();
    process.exit(cmd ? 1 : 0);
}

async function cmdStatus(): Promise<void> {
  if (!(await isOursAlive())) {
    console.log("daemon: not running");
    return;
  }
  const res = await fetch(`${BASE_URL}/api/health`);
  const h = (await res.json()) as { pid: number; uptime: number; version: string };
  console.log(`daemon: running  pid=${h.pid}  uptime=${Math.floor(h.uptime / 1000)}s  v${h.version}`);
}

async function cmdStart(): Promise<void> {
  // ensureDaemon 版本感知:已是最新复用,旧版在跑则停旧启新,没跑则拉起
  const ok = await ensureDaemon();
  console.log(ok ? "daemon: running" : "daemon: start failed (check %LOCALAPPDATA%/shine-code-submit/log/daemon.log)");
}

async function cmdStop(): Promise<void> {
  const wasAlive = await isOursAlive();
  await stopDaemon();
  console.log(wasAlive ? "daemon: stopped" : "daemon: not running");
}

async function cmdRestart(): Promise<void> {
  await stopDaemon();
  spawnDaemon();
  const ok = await waitReady();
  console.log(ok ? "daemon: restarted" : "daemon: restart failed");
}

async function cmdUi(): Promise<void> {
  let pid = readPidFile();
  if (!(await isOursAlive())) {
    spawnDaemon();
    await waitReady();
    pid = readPidFile();
  }
  if (!pid) {
    console.error("daemon: failed to start");
    process.exit(1);
  }
  const url = `${PUBLIC_BASE_URL}/ui?t=${pid.token}`;
  console.log("opening:", url);
  openBrowser(url);
}

async function cmdUpdate(): Promise<void> {
  console.log("checking for update...");
  const r = await autoUpdateIfNeeded(true);
  if (r.updated) {
    console.log(`daemon: new version ${r.latest} available, spawning npx install in background`);
  } else {
    console.log(r.latest ? `daemon: already up to date (latest ${r.latest})` : "daemon: update check failed");
  }
}

async function waitReady(): Promise<boolean> {
  return ensureDaemon();
}

function printHelp(): void {
  console.log(`shine-code-submit <command>

  status   显示 daemon 运行状态
  start    启动 daemon（已在跑则跳过）
  stop     优雅停止 daemon
  restart  重启 daemon
  ui       打开查看页（必要时先启动 daemon）
  update   检测并自动升级到 npm 最新版

发布态下 hook/cli/daemon 同目录，daemon 由同目录二进制拉起；
开发期可用环境变量覆盖：
  SHINE_CODE_SUBMIT_DAEMON_CMD   启动 daemon 的完整命令（如 bun run src/daemon/main.ts）
  SHINE_CODE_SUBMIT_DAEMON       bun run 的入口（默认 src/daemon/main.ts）`);
}
