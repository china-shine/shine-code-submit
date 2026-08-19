// 用户设置(持久化到 DATA_DIR/settings.json)。daemon 与查看页共用。
// 目前只有 reportUrl(上报到服务器的地址);后期「报表」模块的上报按钮读它。
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { DATA_DIR } from "../shared/paths";
import { join } from "node:path";

const SETTINGS_FILE = join(DATA_DIR, "settings.json");

export interface Settings {
  reportUrl?: string | null; // 上报到服务器的地址(空/缺省=未配置)。默认空:公开 npm 用户不应默认把数据报到别人服务器,团队内部装完在设置页配置
  reportSecret?: string | null; // 上报 HMAC 密钥(与 tokenserver 的 reportSecret 配对);配了对上报 body 签名,服务端开了验签时必填,否则恒 401
  reportIntervalMin?: number | null; // 自动上报间隔(分钟);>0 启用,空/0=不自动上报
  autoUpdate?: boolean | null; // 自动更新开关;true=启动时+定时查 npm 升级(默认开)
  autoUpdateIntervalMin?: number | null; // 自动更新检测间隔(分钟);默认 60
  zentaoCacheTtlMin?: number | null; // 禅道任务缓存刷新间隔(分钟);>0 启用 TTL 自动重拉,空/0=禁用;默认 300
  latestVersion?: string | null; // 缓存的 registry 最新版本(dashboard 显示用)
  lastReportAt?: number | null; // 上次上报时刻(增量水位,buildReport since=此值;0/空=全量)。持久化,重启不重置
  lastFullReportAt?: number | null; // 上次全量上报时刻(定期校准用,每 24h 强制全量防 tokenserver 数据漂移)
  lastDaemonVersion?: string | null; // 上次运行的 daemon 版本(升级检测:不同则下次全量回填 gitCommits)
  aiSubmitMark?: { enabled: boolean; text: string | null } | null; // AI 提交标识(开关+文案):提交禅道工时拼到 work 末尾,/daily /weekly 据此对账统计 AI 代报
}

/** 默认设置:不上报(reportUrl 空,团队内部部署再配地址;reportSecret 随包默认分发,见下),自动更新默认开。 */
const DEFAULTS: Settings = {
  reportUrl: null,
  // reportSecret 随包默认分发(用户决策 2026-08-19):成员机零配置即签名。
  // ⚠️ 该值随公开 npm/GitHub 仓库对所有人可见——只挡「顺手扫端口/Postman 乱灌」,挡不住专门研究本项目的人(真要私密就改掉此默认,各机在设置页单独配)。
  // ⚠️ 轮换 = 服务端改 reportSecret 重启 + 本处换新值发新版(成员机 autoUpdate ~1h 换上);期间旧密钥机器 401 不丢数据。
  reportSecret: "40b70c5bca0251ac516aaa264ed31d690ee1444ec34dcabc",
  reportIntervalMin: 10,
  autoUpdate: true,
  autoUpdateIntervalMin: 60,
  zentaoCacheTtlMin: 300,
  latestVersion: null,
  lastReportAt: 0,
  lastFullReportAt: 0,
  lastDaemonVersion: null,
  aiSubmitMark: { enabled: true, text: "本次内容由AI填报" },
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
