// 跨进程 daemon 控制：探活（认自己人）、拉起、等待 ready、开浏览器。
// Hook 与 CLI 共用。
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { BASE_URL, HEALTH_POLL_TIMEOUT_MS, HEALTH_POLL_INTERVAL_MS, SERVICE_NAME } from "./config";

/** 探活 + 认自己人：service 字段必须匹配，防端口被无关程序占用误判。 */
export async function isOursAlive(timeoutMs = 400): Promise<boolean> {
  try {
    const res = await fetch(`${BASE_URL}/api/health`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return false;
    const data = (await res.json()) as { service?: string };
    return data?.service === SERVICE_NAME;
  } catch {
    return false;
  }
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
      spawn("bun", ["run", process.env.SHINE_CODE_SUBMIT_DAEMON], {
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
      spawn("bun", ["run", daemonSrc], { detached: true, stdio: "ignore", windowsHide: true }).unref();
    }
  } catch (err) {
    process.stderr.write(`[shine-code-submit] spawn daemon failed: ${safeMsg(err)}\n`);
  }
}

/** 确保 daemon 就绪：不在则拉起并轮询至 ready（或超时）。 */
export async function ensureDaemon(): Promise<boolean> {
  if (await isOursAlive()) return true;
  spawnDaemon();
  const deadline = Date.now() + HEALTH_POLL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await sleep(HEALTH_POLL_INTERVAL_MS);
    if (await isOursAlive()) return true;
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
