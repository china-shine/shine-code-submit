// 自动更新:查 npm registry 最新版本,有新版 spawn detached `npx shine-code-submit@latest install` 升级。
// daemon 启动时 + 定时调 autoUpdateIfNeeded。全程静默(try/catch),绝不影响 daemon。
//
// 升级链路:npx 拉 latest 包 → install CLI 部署新版到 cache + 注册 → startDaemonWithBun(1.0.5)
// 检测旧 daemon 版本不匹配 → stopDaemon 停旧 → 启新 daemon。daemon 退出不影响 npx install(detached)。
import { spawn } from "node:child_process";
import { SERVICE_NAME, SERVICE_VERSION } from "./config";
import { readSettings, writeSettings } from "../daemon/settings";

const REGISTRY_LATEST = `https://registry.npmjs.org/${SERVICE_NAME}/latest`;
const NPM_REGISTRY = "https://registry.npmjs.org/";

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
    // 有新版:spawn detached npx install(官方 registry 确保 latest,npmmirror 有同步延迟)
    spawn(
      "npx",
      ["--yes", `--registry=${NPM_REGISTRY}`, `${SERVICE_NAME}@latest`, "install"],
      { detached: true, stdio: "ignore", windowsHide: true, shell: true },
    ).unref();
    return { updated: true, latest: check.latest };
  } catch {
    return { updated: false };
  }
}
