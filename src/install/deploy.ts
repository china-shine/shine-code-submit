// 部署 plugin 文件到 claude cache 目录,并跑 bun install 装运行时依赖(marked/react)。
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { pluginsRoot } from "./paths";
import { SERVICE_VERSION } from "../shared/config";
import { info, isSilent } from "./log";

export const MARKETPLACE_NAME = "shine-code-submit";
export const PLUGIN_NAME = "shine-code-submit";

/** 部署目标版本目录:~/.claude/plugins/cache/shine-code-submit/shine-code-submit/<version>/ */
export function cacheDir(version: string = SERVICE_VERSION): string {
  return join(pluginsRoot(), "cache", MARKETPLACE_NAME, PLUGIN_NAME, version);
}

/**
 * 清同 plugin 下非当前版本的 cache 目录(升级残留)。尽力而为:失败只 log,绝不抛。
 * 时机:由 runInstall 在确认新 daemon 运行正常(probe alive 且 version === SERVICE_VERSION)后调用——
 *      保证"当前版本已能正常运行"才删旧;部署/启动失败则保留旧版可用(绝不两头空)。
 * 安全性:活 daemon 启动时已把所有静态 import 加载进内存,运行时 I/O 全指向 DATA_DIR/~/.claude/projects,
 *        绝不读 plugin cache 目录(Explore 已确认);故删旧 version 目录不影响在跑的进程。
 */
export function pruneOldVersions(): void {
  const versionsDir = join(pluginsRoot(), "cache", MARKETPLACE_NAME, PLUGIN_NAME);
  let entries: string[];
  try {
    entries = readdirSync(versionsDir);
  } catch {
    return; // 目录不存在(首次安装)或读不了,无事可做
  }
  for (const name of entries) {
    if (name === SERVICE_VERSION) continue; // 保留当前版本(= cacheDir() 目录名)
    const p = join(versionsDir, name);
    try {
      if (!statSync(p).isDirectory()) continue; // 只清目录,跳过文件
      rmSync(p, { recursive: true, force: true });
      info(`[shine-code-submit] 已清理旧版本目录: ${name}`);
    } catch (e) {
      // 删不掉(Windows 文件占用/权限)不强求,留给下次 install 或 Claude Code sweep
      info(`[shine-code-submit] 清理 ${name} 跳过: ${e instanceof Error ? e.message : e}`);
    }
  }
}

/** 找 npm 包根:运行入口(dist/install.cjs)所在目录上溯到含 package.json + .claude-plugin 的目录。
 *  不能用 import.meta.url —— Bun 打 cjs 单文件 bundle 时会把它静态固化为构建机的源码绝对路径,
 *  换台机器就指向不存在的目录,部署白名单全拷不到、bun install 必失败。改用 process.argv[1]。
 *
 *  ⚠️ 必须 realpathSync:npx 下 process.argv[1] 是 node_modules/.bin/<pkg> 符号链接(bundle 带
 *  #!/usr/bin/env node shebang,内核按原链接路径执行,node 拿到未解析路径)。path.resolve 不跟符号链接,
 *  会从 .bin 上溯,永远碰不到 sibling 的包根 → 部署源错指到 node_modules、白名单拷空、bun install 崩。
 *  realpathSync 把符号链接解析到真实 dist/install.cjs,dirname 后上溯即命中包根。 */
function findPackageRoot(): string {
  const entry = process.argv[1];
  let start = process.cwd();
  if (entry) {
    try {
      start = dirname(realpathSync(resolve(entry)));
    } catch {
      start = dirname(resolve(entry)); // entry 不存在等异常时退回普通解析
    }
  }
  let dir = start;
  for (let i = 0; i < 12; i++) {
    if (existsSync(join(dir, "package.json")) && existsSync(join(dir, ".claude-plugin"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return dirname(start);
}

/** 要部署的文件/目录白名单(plugin 运行必需;不含 dist/install.cjs——install CLI 本身不进 plugin)。 */
const WHITELIST = [".claude-plugin", "hooks", "bin", "src", "ui", "package.json", "bun.lock", "README.md"];

/**
 * 部署 plugin:清同版本目录 → 拷白名单 → bun install 装依赖 → 写版本标记。
 * 返回 cache 目录绝对路径。
 *
 * 幂等:同版本已部署(且非 --force)时直接复用,不 rmSync/不拷贝/不 bun install。
 * 自动更新可能反复触发(60min tick、或旧 daemon 没杀干净导致循环),没有幂等就会每次满屏日志 + 慢装。
 */
export function deployPlugin(bunPath: string, opts: { force?: boolean } = {}): string {
  const target = cacheDir();
  if (!opts.force && sameVersionDeployed(target)) {
    info("[shine-code-submit] 同版本已部署,跳过(用 --force 强制重装)");
    return target;
  }
  if (existsSync(target)) rmSync(target, { recursive: true, force: true });
  mkdirSync(target, { recursive: true });

  const srcRoot = findPackageRoot();
  info(`[shine-code-submit] 部署源:${srcRoot}`);
  for (const item of WHITELIST) {
    const from = join(srcRoot, item);
    if (!existsSync(from)) continue; // 缺(如 bun.lock 未入库)跳过
    cpSync(from, join(target, item), { recursive: true });
  }

  // bun install 装运行时依赖。silent(--silent) 时 stdio:ignore,不喷日志到可能的控制台。
  info("[shine-code-submit] 安装运行时依赖(bun install)...");
  const stdio = isSilent() ? "ignore" : "inherit";
  let status = spawnSync(bunPath, ["install", "--frozen-lockfile"], {
    cwd: target,
    shell: process.platform === "win32",
    encoding: "utf8",
    stdio,
  }).status;
  if (status !== 0) {
    info("[shine-code-submit] --frozen-lockfile 失败,重试普通 bun install");
    status = spawnSync(bunPath, ["install"], {
      cwd: target,
      shell: process.platform === "win32",
      encoding: "utf8",
      stdio,
    }).status;
    if (status !== 0) {
      throw new Error(`bun install 失败(exit ${status})。请手动在 ${target} 跑 bun install`);
    }
  }

  writeFileSync(
    join(target, ".install-version"),
    JSON.stringify({ version: SERVICE_VERSION, installedAt: Date.now() }),
    "utf8",
  );
  info(`[shine-code-submit] 已部署到 ${target}`);
  return target;
}

/** 同版本已部署?.install-version 的 version === SERVICE_VERSION 即视为已部署。 */
function sameVersionDeployed(target: string): boolean {
  try {
    const meta = JSON.parse(readFileSync(join(target, ".install-version"), "utf8")) as {
      version?: string;
    };
    return meta.version === SERVICE_VERSION;
  } catch {
    return false;
  }
}
