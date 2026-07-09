// 跨进程 daemon 控制：探活（认自己人）、拉起、等待 ready、开浏览器。
// Hook 与 CLI 共用。
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { BASE_URL, HEALTH_POLL_TIMEOUT_MS, HEALTH_POLL_INTERVAL_MS, SERVICE_NAME, SERVICE_VERSION } from "./config";
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

/**
 * detached 拉起 daemon。
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
      spawn(cmd, { detached: true, stdio: "ignore", windowsHide: true, shell: true }).unref();
    } else if (process.env.SHINE_CODE_SUBMIT_DAEMON) {
      spawn(process.execPath, ["run", process.env.SHINE_CODE_SUBMIT_DAEMON], {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
      }).unref();
    } else if (existsSync(daemonBin)) {
      // 二进制模式：与当前 exe 同目录的 daemon 二进制
      spawn(daemonBin, [], { detached: true, stdio: "ignore", windowsHide: true }).unref();
    } else {
      // 源码模式：bun run src/daemon/main.ts（本文件在 src/shared/，相对定位）
      const here = dirname(fileURLToPath(import.meta.url));
      const daemonSrc = join(here, "..", "daemon", "main.ts");
      // 用 process.execPath（hook/cli 由 bun 跑时即 bun.exe 完整路径），不靠 PATH/PATHEXT 解析——
      // Windows 上 bun 进程内 spawn("bun") 不查 PATHEXT 会 ENOENT（Linux 无此问题）
      spawn(process.execPath, ["run", daemonSrc], { detached: true, stdio: "ignore", windowsHide: true }).unref();
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
