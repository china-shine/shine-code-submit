// shine-code-submit CLI：status / start / stop / restart / ui。
// 用户侧管理命令。token 从 pid 文件读取。
import { BASE_URL } from "../shared/config";
import { readPidFile, removePidFile } from "../shared/pidfile";
import { ensureDaemon, isOursAlive, openBrowser, spawnDaemon } from "../shared/daemonctl";

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
  if (await isOursAlive()) {
    console.log("daemon: already running");
    return;
  }
  spawnDaemon();
  const ok = await waitReady();
  console.log(ok ? "daemon: started" : "daemon: start failed (check %LOCALAPPDATA%/shine-code-submit/log/daemon.log)");
}

async function cmdStop(): Promise<void> {
  const pid = readPidFile();
  if (!pid) {
    console.log("daemon: not running (no pid file)");
    return;
  }
  if (!(await isOursAlive())) {
    console.log("daemon: not running (stale pid file)");
    removePidFile();
    return;
  }
  // 优雅停止：调用 /api/shutdown
  try {
    await fetch(`${BASE_URL}/api/shutdown`, {
      method: "POST",
      headers: { authorization: `Bearer ${pid.token}` },
    });
  } catch {
    /* ignore */
  }
  await sleep(1000);
  if (await isOursAlive()) {
    try {
      process.kill(pid.pid); // 兜底强杀
    } catch {
      /* ignore */
    }
    removePidFile();
    console.log("daemon: force-stopped");
  } else {
    console.log("daemon: stopped");
  }
}

async function cmdRestart(): Promise<void> {
  await cmdStop();
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
  const url = `${BASE_URL}/ui?t=${pid.token}`;
  console.log("opening:", url);
  openBrowser(url);
}

async function waitReady(): Promise<boolean> {
  return ensureDaemon();
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function printHelp(): void {
  console.log(`shine-code-submit <command>

  status   显示 daemon 运行状态
  start    启动 daemon（已在跑则跳过）
  stop     优雅停止 daemon
  restart  重启 daemon
  ui       打开查看页（必要时先启动 daemon）

发布态下 hook/cli/daemon 同目录，daemon 由同目录二进制拉起；
开发期可用环境变量覆盖：
  SHINE_CODE_SUBMIT_DAEMON_CMD   启动 daemon 的完整命令（如 bun run src/daemon/main.ts）
  SHINE_CODE_SUBMIT_DAEMON       bun run 的入口（默认 src/daemon/main.ts）`);
}
