/** zentao.ts 底层共享层:路径常量 + 通用 helper + Args 类型。
 *  原 zentao.ts 1-203 行整段搬入(fat-shared 路线,全部 export),供 client/transcript/report/zentao 四模块复用。
 *  零 npm 依赖:仅 node:fs/node:os/node:path + Bun 全局。 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, networkInterfaces } from "node:os";
import * as path from "node:path";

export const COMMIT_COOLDOWN_MINUTES = 30;

// 内联复刻 src/shared/paths.ts 的 DATA_DIR（zentao.ts 零 npm 依赖，不能 import；改名时此串需与 paths.ts 同步）
export const LOCAL_APP_DIR = process.env.LOCALAPPDATA ?? path.join(homedir(), ".local", "share");
export const DATA_DIR = path.join(LOCAL_APP_DIR, "shine-worklog");
export const ZENPILOT_HOME = path.join(DATA_DIR, "zenpilot"); // 统一数据目录：ZenPilot 数据进 daemon DATA_DIR/zenpilot
export const CONFIG_PATH = path.join(ZENPILOT_HOME, "config.json");
export const CACHE_PATH = path.join(ZENPILOT_HOME, "cache.json"); // 全局:禅道任务缓存
export const MAPPINGS_PATH = path.join(ZENPILOT_HOME, "mappings.json"); // 全局:仓库→项目映射
export const SETTINGS_PATH = path.join(DATA_DIR, "settings.json"); // 行为开关(如 zentaoCacheTtlMin、aiSubmitMark),DATA_DIR 下与 config.json(连接信息)分离

// 按项目隔离,镜像 Claude Code 的 ~/.claude/projects/<编码路径>/
export function encodeProject(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, "-"); // 非字母数字→-,对齐 Claude Code(空格/标点/中文均→-);零依赖不能 import,与 src/shared/datetime.ts 同款(改动两边同步)
}
export const PROJECT_CWD: string = (() => {
  // 用 --cwd 而非 --project,避免和 learn 的 --project<禅道项目ID> 撞名
  const i = process.argv.indexOf("--cwd");
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1];
  return process.env.CLAUDE_PROJECT_DIR || process.cwd();
})();
export const PROJECT_DIR = path.join(ZENPILOT_HOME, "projects", encodeProject(PROJECT_CWD));
export const SESSIONS_PATH = path.join(PROJECT_DIR, "sessions.json"); // 按项目
export const SUBMITTED_PATH = path.join(PROJECT_DIR, "submitted.json"); // 按项目
export const PLAN_PATH = path.join(PROJECT_DIR, "plan.json"); // 按项目
// summary 文件按「会话日期」(sessions.json.date)命名,而非今天——防跨午夜报当天会话时
// note 写到昨天、plan 读今天(空)导致 work=null 的错位。note/plan 都用 summaryPathFor(<会话日期>)。
export function summaryPathFor(date: string): string {
  return path.join(PROJECT_DIR, `summary-${date}.json`);
}

export type Args = { cmd: string } & Record<string, string | boolean | undefined>;

// ---------- 通用 helpers ----------

export function die(msg: string, extra: Record<string, unknown> = {}): never {
  console.log(JSON.stringify({ error: msg, ...extra }));
  process.exit(1);
}

export function loadJSON<T>(p: string, def: T): T {
  return existsSync(p) ? (JSON.parse(readFileSync(p, "utf8")) as T) : def;
}

export function writeJSON(p: string, obj: unknown): void {
  mkdirSync(path.dirname(p), { recursive: true }); // 自动建 ~/.zenpilot/ 与项目目录
  writeFileSync(p, JSON.stringify(obj, null, 2) + "\n", "utf8");
}

export function writeText(p: string, content: string): void {
  mkdirSync(path.dirname(p), { recursive: true });
  writeFileSync(p, content, "utf8");
}

/** HTML 转义:渲染日报/周报 HTML 用(mdCell 只处理 Markdown 的 | 与换行,不能用于 HTML)。 */
export function esc(s: unknown): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Python 的 round 是「四舍五入到偶数」(banker's rounding),JS Math.round 是 half-up,需自行实现。 */
export function roundPy(value: number, digits = 0): number {
  const neg = value < 0;
  const abs = Math.abs(value);
  const f = 10 ** digits;
  const shifted = abs * f;
  const fl = Math.floor(shifted);
  const frac = shifted - fl;
  let r: number;
  if (Math.abs(frac - 0.5) < 1e-9) r = fl % 2 === 0 ? fl : fl + 1; // tie → 偶数
  else r = Math.round(shifted);
  const out = r / f;
  return neg ? -out : out;
}

export function pad2(n: number): string {
  return n < 10 ? "0" + n : String(n);
}

/** 本地日期 YYYY-MM-DD(不能用 toISOString,那是 UTC)。 */
export function todayISO(): string {
  const d = new Date();
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** 本地时间 YYYY-MM-DDTHH:MM:SS,无时区后缀(对齐 Python datetime.isoformat(timespec="seconds"))。 */
export function nowISOSeconds(): string {
  const d = new Date();
  return `${todayISO()}T${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

/** 距离一个无时区 ISO 串的分钟数(ES 把无 tz 的日期时间按本地解析,与 Python fromisoformat 一致)。 */
export function minutesSinceISO(iso: string): number {
  return (Date.now() - new Date(iso).getTime()) / 60000;
}

export function hoursFromMinutes(minutes: number): number {
  return Math.max(roundPy((minutes / 60) * 2) / 2, 0.5);
}

/** 对齐 Python str(float):整数显示为 2.0,非整数显示为 2.5(仅用于 render 文本)。 */
export function fmtHours(n: number): string {
  return Number.isInteger(n) ? `${n}.0` : `${n}`;
}

export function isObj(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null;
}

export function loadConfig(): Record<string, any> {
  if (!existsSync(CONFIG_PATH)) {
    die(`配置文件不存在: ${CONFIG_PATH},请参考项目根目录 config.example.json 创建`);
  }
  const cfg = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
  for (const key of ["url", "account", "password"]) {
    if (!cfg[key]) die(`配置缺少字段: ${key}`);
  }
  cfg.url = String(cfg.url).replace(/\/+$/, "");
  return cfg;
}

// ---------- AI 提交标识 ----------
// 开关+文案存 settings.json(DATA_DIR 下)。标识以全角括号行内拼在 work 末尾随禅道走,对账靠字符串匹配——
// 不依赖本地台账,重装/补报不丢;代价:改文案或拼接格式后,历史提交需按旧格式识别(isAiWork 兼容括号+换行两种)。
const DEFAULT_MARK = { enabled: true, text: "本次内容由AI填报" };

export function loadMarkSetting(): { enabled: boolean; text: string } {
  const m = loadJSON<any>(SETTINGS_PATH, {}).aiSubmitMark ?? {};
  return {
    enabled: typeof m.enabled === "boolean" ? m.enabled : DEFAULT_MARK.enabled,
    text: typeof m.text === "string" && m.text ? m.text : DEFAULT_MARK.text,
  };
}

/** enabled 且文案非空、且 work 末尾尚未带该标识 → 行内追加 (文案)(全角括号,不换行,作为内容一部分);否则原样(幂等,防重复拼)。 */
export function applyMark(work: string, mark: { enabled: boolean; text: string }): string {
  if (!mark.enabled || !mark.text) return work;
  const tail = `(${mark.text})`;
  return work.endsWith(tail) ? work : work + tail;
}

export function isAiWork(work: string, text: string): boolean {
  // 命中新括号格式 work(文案) 或旧换行格式 work\n文案(历史已提交记录),任一即算 AI 代报
  return !!text && (work.endsWith(`(${text})`) || work.endsWith("\n" + text));
}

/** 剥掉末尾标识(新括号格式或旧换行格式);不含标识或 text 为空则原样返回。 */
export function stripMark(work: string, text: string): string {
  if (!text) return work;
  const paren = `(${text})`;
  if (work.endsWith(paren)) return work.slice(0, -paren.length);
  const newline = "\n" + text;
  return work.endsWith(newline) ? work.slice(0, -newline.length) : work;
}

export function requireStr(a: Args, k: string): string {
  if (a[k] === undefined) die(`缺少必填参数: --${k}`);
  return String(a[k]);
}
export function requireInt(a: Args, k: string): number {
  if (a[k] === undefined) die(`缺少必填参数: --${k}`);
  return parseInt(String(a[k]), 10);
}

// ---------- 会话采集辅助(从 transcript 挖掘真实会话)----------

export const IDLE_CAP_MS = 10 * 60 * 1000;

export function num(x: unknown): number {
  const n = Number(x);
  return Number.isFinite(n) ? n : 0;
}

export function countLines(s: unknown): number {
  if (typeof s !== "string" || s.length === 0) return 0;
  return s.split("\n").length;
}

export function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((b: any) => b && b.type === "text" && typeof b.text === "string")
      .map((b: any) => b.text)
      .join("\n");
  }
  return "";
}

export function localDateISO(iso: string): string {
  const d = new Date(iso);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

export function localHHMM(v: string | number): string {
  const d = new Date(v);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

export function localMidnightEpoch(): number {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export function gitBranchFallback(cwd: string | null): string | null {
  if (!cwd) return null;
  try {
    const r = Bun.spawnSync(["git", "-C", cwd, "rev-parse", "--abbrev-ref", "HEAD"]);
    const out = (r.stdout?.toString() ?? "").trim();
    return out && out !== "HEAD" ? out : null;
  } catch {
    return null;
  }
}

// ---------- dashboard 链接(报告 stdout 展示用)----------
// 与 src/shared/config.ts(PORT/getPrimaryIpv4/PUBLIC_BASE_URL)+ src/shared/pidfile.ts(readPidFile)同口径,
// 内联复刻(zentao.ts 零 npm 依赖、不跨目录 import src/shared);改网卡规则或端口时两边同步。
export const PORT = 36666;

/** 第一个非回环、非虚拟网卡的 IPv4(复刻 src/shared/config.ts:25-50);全为虚拟网卡退第一个非回环;都没有则 localhost。 */
function getPrimaryIpv4(): string {
  const VIRTUAL = ["vethernet", "vmware", "virtualbox", "docker", "veth", "br-", "virbr", "vnet", "utun", "meta", "clash", "mihomo"]; // +代理 TUN 虚拟网卡(Clash/Mihomo TUN)
  const isVirtual = (name: string): boolean => {
    const n = name.toLowerCase();
    return VIRTUAL.some((k) => n.includes(k));
  };
  try {
    const nets = networkInterfaces();
    // 第一轮：跳过回环 + 虚拟网卡，取真实局域网 IP
    for (const name of Object.keys(nets)) {
      if (isVirtual(name)) continue;
      for (const net of nets[name] ?? []) {
        if (net.family === "IPv4" && !net.internal && !net.address.startsWith("198.18.")) return net.address; // 跳过 198.18.0.0/15(基准测试段,Clash TUN 占用)
      }
    }
    // 第二轮：全是虚拟网卡时，退回第一个非回环 IPv4
    for (const name of Object.keys(nets)) {
      for (const net of nets[name] ?? []) {
        if (net.family === "IPv4" && !net.internal && !net.address.startsWith("198.18.")) return net.address;
      }
    }
  } catch {
    /* fallthrough to localhost */
  }
  return "localhost";
}

export const PUBLIC_BASE_URL = `http://${getPrimaryIpv4()}:${PORT}`; // 局域网可访问的链接(网卡 IP),与 cli ui 同口径

/** 读 DATA_DIR/daemon.pid 拿 token 拼 dashboard 链接;daemon 未运行/pid 缺失/无 token → null(报告降级为只给文件路径)。 */
export function dashboardUrl(): string | null {
  try {
    const pid = JSON.parse(readFileSync(path.join(DATA_DIR, "daemon.pid"), "utf8"));
    const token = (pid as any)?.token;
    if (typeof token !== "string" || !token) return null;
    return `${PUBLIC_BASE_URL}/ui?t=${token}`;
  } catch {
    return null;
  }
}
