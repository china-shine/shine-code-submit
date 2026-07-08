// 用户设置(持久化到 DATA_DIR/settings.json)。daemon 与查看页共用。
// 目前只有 reportUrl(上报到服务器的地址);后期「报表」模块的上报按钮读它。
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { DATA_DIR } from "../shared/paths";
import { join } from "node:path";

const SETTINGS_FILE = join(DATA_DIR, "settings.json");

export interface Settings {
  reportUrl?: string | null; // 上报到服务器的地址(空/缺省=未配置)
}

/** 读设置;文件不存在/损坏返回空对象(全默认)。 */
export function readSettings(): Settings {
  try {
    return JSON.parse(readFileSync(SETTINGS_FILE, "utf8")) as Settings;
  } catch {
    return {};
  }
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
