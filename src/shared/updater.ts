// 自动更新:查 npm registry 最新版本,有新版 spawn detached `npx shine-code-submit@latest install` 升级。
// daemon 启动时 + 定时调 autoUpdateIfNeeded。全程静默(try/catch),绝不影响 daemon。
//
// 升级链路:npx 拉 latest 包 → install CLI 部署新版到 cache + 注册 → startDaemonWithBun(1.0.5)
// 检测旧 daemon 版本不匹配 → stopDaemon 停旧 → 启新 daemon。daemon 退出不影响 npx install(detached)。
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SERVICE_NAME, SERVICE_VERSION } from "./config";
import { DATA_DIR } from "./paths";
import { readSettings, writeSettings } from "../daemon/settings";

const REGISTRY_LATEST = `https://registry.npmjs.org/${SERVICE_NAME}/latest`;
const NPM_REGISTRY = "https://registry.npmjs.org/";

/**
 * 后台拉起一次静默自动更新(spawn detached,不阻塞 daemon)。
 * - Windows:wscript VBS 隐藏包装(Run cmd,0 = SW_HIDE),彻底无窗口。直接 spawn("npx",…,{shell:true})
 *   会因 cmd→npx.cmd→孙进程 node 链分配新控制台而在用户屏幕弹安装日志(error.png),windowsHide 管不到孙进程。
 * - mac/linux:npx 有 shebang,直接 spawn(不 shell)即可,顺带消 DEP0190。
 * install 一律带 --silent:安装器自身也不喷日志(幂等短路 + 诊断落 install.log)。
 */
function spawnSilentInstall(): void {
  const npxArgs = ["--yes", `--registry=${NPM_REGISTRY}`, `${SERVICE_NAME}@latest`, "install", "--silent"];
  // env 经 wscript→cmd→npx→node 链逐级继承,让安装器进 --silent 模式;不依赖 npx 是否吞掉包名后的
  // --silent flag(--silent 是 npx 自身 flag,跨 npm 版本对"包名后已知 flag 是否透传"行为不一)。
  const env = { ...process.env, SHINE_SILENT: "1" };
  if (process.platform === "win32") {
    // 稳定路径,不每次新建;DATA_DIR 即 %LOCALAPPDATA%/shine-code-submit。
    const vbsPath = join(DATA_DIR, "update-hidden.vbs");
    const vbs = [
      `Set s = CreateObject("Wscript.Shell")`,
      `s.Run "cmd /c npx ${npxArgs.join(" ")}", 0, False`,
    ].join("\r\n");
    try {
      mkdirSync(DATA_DIR, { recursive: true });
      writeFileSync(vbsPath, vbs, "utf8");
    } catch {
      /* 写不了 vbs 就放弃本次静默升级,下次 tick 再试——绝不影响 daemon */
      return;
    }
    const wscript = join(process.env.SystemRoot || "C:\\Windows", "system32", "wscript.exe");
    const child = spawn(wscript, [vbsPath], { detached: true, stdio: "ignore", windowsHide: true, env });
    child.on("error", () => {
      /* wscript 缺失/被策略禁用等启动失败:静默放弃本次,下次 tick 再试,绝不拖崩 daemon */
    });
    child.unref();
    return;
  }
  const child = spawn("npx", npxArgs, { detached: true, stdio: "ignore", windowsHide: true, env });
  child.on("error", () => {
    /* npx 不在 PATH 等启动失败:静默放弃本次,下次 tick 再试 */
  });
  child.unref();
}

/** semver 大于:a > b 才 true(相等 false)。只升级不降级,避免本地比 npm 新(如发版前 build)时误降级。 */
function versionGt(a: string, b: string): boolean {
  const pa = a.split(".").map((x) => parseInt(x, 10) || 0);
  const pb = b.split(".").map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x > y) return true;
    if (x < y) return false;
  }
  return false;
}

export interface UpdateCheck {
  latest?: string;
  current: string;
  hasUpdate: boolean;
}

/** 查 npm registry 最新版本。失败返回 hasUpdate:false(不抛)。 */
export async function checkForUpdate(): Promise<UpdateCheck> {
  try {
    const res = await fetch(REGISTRY_LATEST, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return { current: SERVICE_VERSION, hasUpdate: false };
    const data = (await res.json()) as { version?: string };
    const latest = data.version;
    if (!latest) return { current: SERVICE_VERSION, hasUpdate: false };
    return { latest, current: SERVICE_VERSION, hasUpdate: versionGt(latest, SERVICE_VERSION) };
  } catch {
    return { current: SERVICE_VERSION, hasUpdate: false };
  }
}

/**
 * 自动更新:读 settings(autoUpdate 开关),有新版 spawn detached npx install。
 * 返回 {updated, latest}。全程 try/catch 静默——绝不影响 daemon。
 * - autoUpdate===false → 跳过。
 * - 有新版 → spawn `npx --yes --registry=官方 shine-code-submit@latest install`(detached,不阻塞)。
 * - 无论是否升级,都缓存 latestVersion 到 settings(dashboard 显示用)。
 */
export async function autoUpdateIfNeeded(force = false): Promise<{ updated: boolean; latest?: string }> {
  try {
    const s = readSettings();
    if (!force && s.autoUpdate === false) return { updated: false };
    const check = await checkForUpdate();
    // 缓存 latestVersion(dashboard 显示当前/最新版本)
    if (check.latest && check.latest !== s.latestVersion) {
      writeSettings({ ...s, latestVersion: check.latest });
    }
    if (!check.hasUpdate) return { updated: false, latest: check.latest };
    // 有新版:静默 spawn npx install(官方 registry 确保 latest,npmmirror 有同步延迟)。
    // Windows 走 wscript VBS 隐藏包装避免弹窗,见 spawnSilentInstall。
    spawnSilentInstall();
    return { updated: true, latest: check.latest };
  } catch {
    return { updated: false };
  }
}
