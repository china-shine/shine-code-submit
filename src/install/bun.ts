// bun 检测 + 自动安装。install CLI 由 node 跑,跑 install 时 bun 可能还没装。
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { info, isSilent, warn } from "./log";

const MIN_BUN = [1, 1, 0];
const INSTALL_TIMEOUT_MS = 5 * 60 * 1000;

/** 检测 bun:先 PATH(which),再常见安装位置(不依赖 PATH 刚刷新)。 */
export function getBunPath(): string | null {
  const r = spawnSync("bun", ["--version"], { shell: process.platform === "win32", encoding: "utf8" });
  if (r.status === 0 && (r.stdout ?? "").trim()) return "bun";
  const home = homedir();
  const candidates =
    process.platform === "win32"
      ? [join(home, ".bun", "bin", "bun.exe")]
      : [join(home, ".bun", "bin", "bun"), "/usr/local/bin/bun", "/opt/homebrew/bin/bun"];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return null;
}

function parseVersion(v: string): number[] {
  return v.trim().split(".").map((x) => parseInt(x, 10) || 0);
}

function versionGte(v: string, min: number[]): boolean {
  const parts = parseVersion(v);
  for (let i = 0; i < min.length; i++) {
    const p = parts[i] ?? 0;
    const m = min[i] ?? 0;
    if (p > m) return true;
    if (p < m) return false;
  }
  return true;
}

/** 当前 npm registry 是否国内镜像(npmmirror/taobao)——是则优先 npm i -g bun 走镜像。 */
function isCnRegistry(): boolean {
  const reg = process.env.npm_config_registry ?? "";
  return /npmmirror|taobao/i.test(reg);
}

function runShell(cmd: string): number {
  return spawnSync(cmd, {
    shell: true,
    encoding: "utf8",
    timeout: INSTALL_TIMEOUT_MS,
    stdio: isSilent() ? "ignore" : "inherit",
  }).status ?? 1;
}

/**
 * 确保 bun 可用:已装且版本够返回路径;否则自动装。
 * 返回 bun 可执行路径("bun" 或绝对路径)。
 */
export async function ensureBun(): Promise<string> {
  const existing = getBunPath();
  if (existing) {
    const v =
      spawnSync(existing, ["--version"], { shell: process.platform === "win32", encoding: "utf8" }).stdout?.trim() ?? "";
    if (v && versionGte(v, MIN_BUN)) {
      info(`[shine-code-submit] bun ${v} detected`);
      return existing;
    }
  }

  info("[shine-code-submit] bun 未找到或版本过低,开始自动安装...");

  // 国内镜像优先:npm i -g bun(走 npmmirror,比官方脚本快且稳)
  if (isCnRegistry()) {
    info("[shine-code-submit] 检测到国内 npm 镜像,先尝试 npm install -g bun");
    if (runShell("npm install -g bun") === 0) {
      const p = getBunPath();
      if (p) {
        info("[shine-code-submit] ✓ bun 安装成功(via npm 镜像)");
        return p;
      }
    }
    info("[shine-code-submit] npm 镜像方式失败,回退官方脚本");
  }

  // 官方脚本
  if (process.platform === "win32") {
    runShell('powershell -c "irm bun.sh/install.ps1 | iex"');
  } else {
    runShell("curl -fsSL https://bun.sh/install | bash");
  }

  const p = getBunPath();
  if (!p) {
    warn("[shine-code-submit] bun 自动安装失败。请手动安装后重试:");
    warn("  Windows: winget install Oven-sh.Bun   或   npm install -g bun");
    warn("  macOS:   brew install oven-sh/bun/bun");
    warn("  Linux:   curl -fsSL https://bun.sh/install | bash");
    throw new Error("bun installation failed");
  }
  info("[shine-code-submit] ✓ bun 安装成功");
  return p;
}
