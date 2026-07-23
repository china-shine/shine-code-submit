// 用户设置(持久化到 DATA_DIR/settings.json)。daemon 与查看页共用。
// 目前只有 reportUrl(上报到服务器的地址);后期「报表」模块的上报按钮读它。
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { DATA_DIR } from "../shared/paths";
import { join } from "node:path";

const SETTINGS_FILE = join(DATA_DIR, "settings.json");

export interface Settings {
  reportUrl?: string | null; // 上报到服务器的地址(空/缺省=未配置)
  reportIntervalMin?: number | null; // 自动上报间隔(分钟);>0 启用,空/0=不自动上报
  autoUpdate?: boolean | null; // 自动更新开关;true=启动时+定时查 npm 升级(默认开)
  autoUpdateIntervalMin?: number | null; // 自动更新检测间隔(分钟);默认 60
  latestVersion?: string | null; // 缓存的 registry 最新版本(dashboard 显示用)
  lastReportAt?: number | null; // 上次上报时刻(增量水位,buildReport since=此值;0/空=全量)。持久化,重启不重置
  lastFullReportAt?: number | null; // 上次全量上报时刻(定期校准用,每 24h 强制全量防 tokenserver 数据漂移)
}

/** 默认设置:上报到 tokenserver 公网地址,每 10 分钟一次。 */
const DEFAULTS: Settings = {
  reportUrl: "http://47.98.221.20:36667/api/report",
  reportIntervalMin: 10,
  autoUpdate: true,
  autoUpdateIntervalMin: 60,
  latestVersion: null,
  lastReportAt: 0,
  lastFullReportAt: 0,
};

/** 读设置;文件不存在/损坏返回默认值,已存字段覆盖默认(含 null)。 */
export function readSettings(): Settings {
  let s: Settings;
  try {
    s = JSON.parse(readFileSync(SETTINGS_FILE, "utf8")) as Settings;
  } catch {
    s = {};
  }
  return { ...DEFAULTS, ...s };
}

/** 写设置(整体覆盖)。写失败静默——GET 仍返回上次成功写入的值。 */
export function writeSettings(s: Settings): void {
  try {
    mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(SETTINGS_FILE, JSON.stringify(s, null, 2), "utf8");
  } catch {
    /* 容错 */
  }
}
