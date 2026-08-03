// 一次性数据布局迁移(1.3.0):shine-code-submit → shine-worklog 改名 + ZenPilot(~/.zenpilot)统一进 DATA_DIR/zenpilot。
// 幂等(标记文件);runInstall 最开头触发,daemon 启动前。全程容错:失败只 warn,不阻断安装。
/* eslint-disable @typescript-eslint/no-explicit-any -- claude 的 JSON 结构是动态的,用 any 最直接 */
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { DATA_DIR } from "../shared/paths";
import { knownMarketplacesPath, installedPluginsPath, settingsPath, pluginsRoot } from "./paths";
import { readJsonDefault, writeJsonAtomicWithBackup } from "./json-safe";
import { SERVICE_VERSION } from "../shared/config";
import { info, warn } from "./log";

const OLD_NAME = "shine-code-submit"; // 与 deploy.ts MARKETPLACE_NAME/PLUGIN_NAME、config.ts SERVICE_NAME 改名前的旧名
const LOCAL = process.env.LOCALAPPDATA ?? join(homedir(), ".local", "share");
const OLD_DATA_DIR = join(LOCAL, OLD_NAME);
const OLD_ZENPILOT = join(homedir(), ".zenpilot");
const NEW_ZENPILOT = join(DATA_DIR, "zenpilot");
const MARKER = join(DATA_DIR, `.migrated-v${SERVICE_VERSION}`);

/** 优雅停旧 daemon:读旧 pid 文件,POST /api/shutdown + kill 兜底。
 *  改名后 daemonctl.isOursAlive 因 service 不匹配失效,必须在此显式停(否则 db/events.sqlite 被占用,迁移损坏)。 */
async function stopOldDaemon(): Promise<void> {
  const pidFile = join(OLD_DATA_DIR, "daemon.pid");
  if (!existsSync(pidFile)) return;
  let pid: number | undefined;
  let token: string | undefined;
  try {
    const j = JSON.parse(readFileSync(pidFile, "utf8"));
    pid = j.pid;
    token = j.token;
  } catch {
    return;
  }
  try {
    await fetch(`http://127.0.0.1:36666/api/shutdown`, {
      method: "POST",
      headers: token ? { authorization: `Bearer ${token}` } : {},
      signal: AbortSignal.timeout(2000),
    });
  } catch {
    /* 旧 daemon 可能已停 */
  }
  if (pid) {
    try {
      process.kill(pid);
    } catch {
      /* 已退出 */
    }
  }
}

/** 删旧插件 cache + 清 3 JSON 旧 key(避免 Claude Code 同时加载新旧两插件 → hook 重复触发)。 */
export function cleanupOldPlugin(): void {
  const cache = join(pluginsRoot(), "cache", OLD_NAME);
  if (existsSync(cache)) {
    try {
      rmSync(cache, { recursive: true, force: true });
      info(`[shine-worklog] 清旧插件 cache: ${cache}`);
    } catch (e) {
      warn(`[shine-worklog] 清旧 cache 失败: ${e}`);
    }
  }
  const oldKey = `${OLD_NAME}@${OLD_NAME}`;
  try {
    const km = readJsonDefault<Record<string, any>>(knownMarketplacesPath(), {});
    if (km[OLD_NAME]) {
      delete km[OLD_NAME];
      writeJsonAtomicWithBackup(knownMarketplacesPath(), km);
    }
    const ip = readJsonDefault<{ plugins?: Record<string, any> }>(installedPluginsPath(), { plugins: {} });
    if (ip.plugins?.[oldKey]) {
      delete ip.plugins[oldKey];
      writeJsonAtomicWithBackup(installedPluginsPath(), ip);
    }
    const s = readJsonDefault<Record<string, any>>(settingsPath(), {});
    let changed = false;
    if (s.enabledPlugins?.[oldKey]) {
      delete s.enabledPlugins[oldKey];
      changed = true;
    }
    if (s.extraKnownMarketplaces?.[OLD_NAME]) {
      delete s.extraKnownMarketplaces[OLD_NAME];
      changed = true;
    }
    if (changed) writeJsonAtomicWithBackup(settingsPath(), s);
    info("[shine-worklog] 已清旧插件注册(shine-code-submit@shine-code-submit)");
  } catch (e) {
    warn(`[shine-worklog] 清旧注册 JSON 失败: ${e}`);
  }
}

/** runInstall 最开头调:迁移数据布局。幂等(标记文件存在或无旧数据则跳过)。 */
export async function migrateLayout(): Promise<void> {
  if (existsSync(MARKER) || (!existsSync(OLD_DATA_DIR) && !existsSync(OLD_ZENPILOT))) return;
  info("[shine-worklog] === 迁移数据布局(shine-code-submit → shine-worklog + ZenPilot 统一进 DATA_DIR/zenpilot)===");

  await stopOldDaemon();
  await new Promise((r) => setTimeout(r, 1500));

  // 1. 迁 daemon DATA_DIR:renameSync 同卷原子(LOCALAPPDATA 内)。先清自管理可重建文件(pid/notice/vbs/log),保留 db/token/spool/settings。
  if (existsSync(OLD_DATA_DIR) && !existsSync(DATA_DIR)) {
    for (const f of ["daemon.pid", "notice.json", "spawn-daemon-hidden.vbs", "update-hidden.vbs"]) {
      try {
        rmSync(join(OLD_DATA_DIR, f), { force: true });
      } catch {
        /* ignore */
      }
    }
    try {
      rmSync(join(OLD_DATA_DIR, "log"), { recursive: true, force: true });
    } catch {
      /* ignore */
    }
    try {
      renameSync(OLD_DATA_DIR, DATA_DIR);
      info(`[shine-worklog] daemon 数据迁移: ${OLD_DATA_DIR} → ${DATA_DIR}`);
    } catch (e) {
      warn(`[shine-worklog] daemon DATA_DIR 迁移失败(继续): ${e}`);
    }
  }

  // 2. 迁 ZenPilot:~/.zenpilot → DATA_DIR/zenpilot(跨卷 ~ vs LOCALAPPDATA,cp+rm)。config.json 含明文密码,chmod 600。
  if (existsSync(OLD_ZENPILOT) && !existsSync(NEW_ZENPILOT)) {
    try {
      mkdirSync(DATA_DIR, { recursive: true });
      cpSync(OLD_ZENPILOT, NEW_ZENPILOT, { recursive: true });
      const cfg = join(NEW_ZENPILOT, "config.json");
      if (existsSync(cfg)) chmodSync(cfg, 0o600); // 保密码权限(cpSync 已保留,显式再保一次)
      rmSync(OLD_ZENPILOT, { recursive: true, force: true });
      info(`[shine-worklog] ZenPilot 数据迁移: ${OLD_ZENPILOT} → ${NEW_ZENPILOT}`);
    } catch (e) {
      warn(`[shine-worklog] ZenPilot 迁移失败(源保留,可手动迁): ${e}`);
    }
  }

  // 3. 反注册旧插件(清 cache + 3 JSON 旧 key)
  cleanupOldPlugin();

  // 4. 标记(幂等;失败下次重试)
  try {
    mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(MARKER, JSON.stringify({ at: new Date().toISOString(), version: SERVICE_VERSION }), "utf8");
    info("[shine-worklog] 数据布局迁移完成");
  } catch (e) {
    warn(`[shine-worklog] 写迁移标记失败(下次 install 重试): ${e}`);
  }
}
