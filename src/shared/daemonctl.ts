// 跨进程 daemon 控制：探活（认自己人）、拉起、等待 ready、开浏览器。
// Hook 与 CLI 共用。
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { BASE_URL, HEALTH_POLL_TIMEOUT_MS, HEALTH_POLL_INTERVAL_MS, SERVICE_NAME, SERVICE_VERSION } from "./config";
import { DATA_DIR } from "./paths";
import { readPidFile, removePidFile } from "./pidfile";

/** 探活 + 认自己人 + 取版本:service 必须匹配(防端口被无关程序占用误判),顺便读 version。 */
export async function probeDaemon(timeoutMs = 400): Promise<{ alive: boolean; version?: string }> {
  try {
    const res = await fetch(`${BASE_URL}/api/health`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return { alive: false };
    const data = (await res.json()) as { service?: string; version?: string };
    if (data?.service !== SERVICE_NAME) return { alive: false };
    return { alive: true, version: data.version };
  } catch {
    return { alive: false };
  }
}

/** 探活 + 认自己人(只看存活,不比版本)。向后兼容;需比版本用 probeDaemon。 */
export async function isOursAlive(timeoutMs = 400): Promise<boolean> {
  return (await probeDaemon(timeoutMs)).alive;
}

/** 路径含空格则加双引号(给 VBS Run / shell 命令行用)。 */
function quote(p: string): string {
  return /\s/.test(p) ? `"${p}"` : p;
}

/** Windows 用 wscript VBS 隐藏 spawn(SW_HIDE):detached 的 console exe(daemon.exe)用 windowsHide 管不到(独立进程自分配控制台),
 *  改用 Wscript.Shell.Run "<cmd>", 0(SW_HIDE), False(不等) 强隐藏整条进程链。非 Windows 直接 spawn(shell)。
 *  daemon 常驻:wscript 自身无控制台 + SW_HIDE 隐藏被启动进程;wscript 退出,daemon 独立继续(类 updater.spawnSilentInstall)。 */
function spawnHidden(commandLine: string): void {
  if (process.platform !== "win32") {
    spawn(commandLine, { detached: true, stdio: "ignore", shell: true }).unref();
    return;
  }
  const vbsPath = join(DATA_DIR, "spawn-daemon-hidden.vbs");
  const escaped = commandLine.replace(/"/g, '""'); // VBS 字符串内双引号转义
  const vbs = `Set s = CreateObject("Wscript.Shell")\rs.Run "${escaped}", 0, False\r`;
  try {
    mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(vbsPath, vbs, "utf8");
  } catch {
    return; // 写不了 vbs 放弃(下次 hook 再试),绝不抛
  }
  const wscript = join(process.env.SystemRoot || "C:\\Windows", "system32", "wscript.exe");
  spawn(wscript, [vbsPath], { detached: true, stdio: "ignore", windowsHide: true }).unref();
}

/**
 * detached 拉起 daemon(Windows 走 wscript VBS 隐藏控制台)。
 * 优先级：env 覆盖 > 同目录 daemon 二进制（二进制模式）> bun run src/daemon/main.ts（源码模式）。
 * 开发期可用 env 覆盖：
 *   SHINE_CODE_SUBMIT_DAEMON_CMD  完整命令（shell 执行）
 *   SHINE_CODE_SUBMIT_DAEMON      仅 bun run 入口路径
 */
export function spawnDaemon(): void {
  const cmd = process.env.SHINE_CODE_SUBMIT_DAEMON_CMD;
  const dir = dirname(process.execPath);
  const ext = process.platform === "win32" ? ".exe" : "";
  const daemonBin = join(dir, `daemon${ext}`);
  try {
    if (cmd) {
      // env 覆盖:完整命令(shell 执行)
      spawnHidden(cmd);
    } else if (process.env.SHINE_CODE_SUBMIT_DAEMON) {
      // env:bun run <入口>
      spawnHidden(`${quote(process.execPath)} run ${quote(process.env.SHINE_CODE_SUBMIT_DAEMON)}`);
    } else if (existsSync(daemonBin)) {
      // 二进制模式:与当前 exe 同目录的 daemon 二进制
      spawnHidden(quote(daemonBin));
    } else {
      // 源码模式:bun run src/daemon/main.ts(本文件在 src/shared/,相对定位)
      const here = dirname(fileURLToPath(import.meta.url));
      const daemonSrc = join(here, "..", "daemon", "main.ts");
      // 用 process.execPath(hook/cli 由 bun 跑时即 bun.exe 完整路径),不靠 PATH/PATHEXT 解析
      spawnHidden(`${quote(process.execPath)} run ${quote(daemonSrc)}`);
    }
  } catch (err) {
    process.stderr.write(`[shine-code-submit] spawn daemon failed: ${safeMsg(err)}\n`);
  }
}

/** 停 daemon:POST /api/shutdown(优雅) → sleep 1s → 仍活强杀 → 清 stale pid 文件。 */
export async function stopDaemon(): Promise<void> {
  const pid = readPidFile();
  if (!pid) return;
  if (await isOursAlive()) {
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
        process.kill(pid.pid);
      } catch {
        /* ignore */
      }
    }
  }
  removePidFile();
}

/** 确保 daemon 就绪且版本 == 当前 SERVICE_VERSION:没跑则拉起;旧版在跑则停旧启新(daemon 自守,必须先停后启)。 */
export async function ensureDaemon(): Promise<boolean> {
  const probe = await probeDaemon();
  if (probe.alive && probe.version === SERVICE_VERSION) return true;
  if (probe.alive) await stopDaemon(); // 旧版:先停,新的才起得来
  spawnDaemon();
  const deadline = Date.now() + HEALTH_POLL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await sleep(HEALTH_POLL_INTERVAL_MS);
    const p = await probeDaemon();
    if (p.alive && p.version === SERVICE_VERSION) return true;
  }
  return false;
}

/** 跨平台打开浏览器。WSL 走 Windows interop（cmd.exe start）比 xdg-open 稳。 */
export function openBrowser(url: string): void {
  const platform = process.platform;
  let cmd: string;
  let args: string[];
  if (platform === "win32") {
    cmd = "cmd";
    args = ["/c", "start", "", url];
  } else if (platform === "darwin") {
    cmd = "open";
    args = [url];
  } else if (isWsl()) {
    cmd = "cmd.exe";
    args = ["/c", "start", "", url];
  } else {
    cmd = "xdg-open";
    args = [url];
  }
  try {
    spawn(cmd, args, { detached: true, stdio: "ignore" }).unref();
  } catch {
    /* ignore */
  }
}

/** 是否跑在 WSL（Linux 内核版本字符串含 microsoft）。用于 openBrowser 选 interop 路径。 */
function isWsl(): boolean {
  if (process.platform !== "linux") return false;
  try {
    return readFileSync("/proc/version", "utf8").toLowerCase().includes("microsoft");
  } catch {
    return false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
function safeMsg(v: unknown): string {
  return v instanceof Error ? `${v.name}: ${v.message}` : String(v);
}
