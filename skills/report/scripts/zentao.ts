#!/usr/bin/env bun
/** 禅道 REST API v1 客户端(ZenPilot 工时填报 skill 使用)— Bun + TypeScript 版。
 *
 * 命令(与原 zentao.py 一致,输出 JSON):
 *   config [--url U --account A --password P --projects 1,2] [--show]
 *   check / projects [--limit N] / my-tasks [--projects 1,2] [--all-status]
 *   executions [--projects 1,2] / create-task --execution ID --name TEXT --estimate H [--type devel --desc TEXT]
 *   refresh / plan / render / commit [--dry-run] / amend [--dry-run]
 *   efforts --task ID / submit --task ID --date D --hours H --work TEXT [--left H] [--dry-run] [--session S --minutes M]
 *   learn --repo R --project P [--branch B --task T] / mappings [--forget-repo R]
 *
 * 配置文件 ~/.zenpilot/config.json:
 *   { "url": "https://...", "account": "...", "password": "...", "projectIds": [] }
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import * as path from "node:path";

const COMMIT_COOLDOWN_MINUTES = 30;

// 内联复刻 src/shared/paths.ts 的 DATA_DIR（zentao.ts 零 npm 依赖，不能 import；改名时此串需与 paths.ts 同步）
const LOCAL_APP_DIR = process.env.LOCALAPPDATA ?? path.join(homedir(), ".local", "share");
const DATA_DIR = path.join(LOCAL_APP_DIR, "shine-worklog");
const ZENPILOT_HOME = path.join(DATA_DIR, "zenpilot"); // 统一数据目录：ZenPilot 数据进 daemon DATA_DIR/zenpilot
const CONFIG_PATH = path.join(ZENPILOT_HOME, "config.json");
const CACHE_PATH = path.join(ZENPILOT_HOME, "cache.json"); // 全局:禅道任务缓存
const MAPPINGS_PATH = path.join(ZENPILOT_HOME, "mappings.json"); // 全局:仓库→项目映射

// 按项目隔离,镜像 Claude Code 的 ~/.claude/projects/<编码路径>/
function encodeProject(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, "-"); // 非字母数字→-,对齐 Claude Code(空格/标点/中文均→-)
}
const PROJECT_CWD: string = (() => {
  // 用 --cwd 而非 --project,避免和 learn 的 --project<禅道项目ID> 撞名
  const i = process.argv.indexOf("--cwd");
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1];
  return process.env.CLAUDE_PROJECT_DIR || process.cwd();
})();
const PROJECT_DIR = path.join(ZENPILOT_HOME, "projects", encodeProject(PROJECT_CWD));
const SESSIONS_PATH = path.join(PROJECT_DIR, "sessions.json"); // 按项目
const SUBMITTED_PATH = path.join(PROJECT_DIR, "submitted.json"); // 按项目
const PLAN_PATH = path.join(PROJECT_DIR, "plan.json"); // 按项目

type Args = { cmd: string } & Record<string, string | boolean | undefined>;

// ---------- 通用 helpers ----------

function die(msg: string, extra: Record<string, unknown> = {}): never {
  console.log(JSON.stringify({ error: msg, ...extra }));
  process.exit(1);
}

function loadJSON<T>(p: string, def: T): T {
  return existsSync(p) ? (JSON.parse(readFileSync(p, "utf8")) as T) : def;
}

function writeJSON(p: string, obj: unknown): void {
  mkdirSync(path.dirname(p), { recursive: true }); // 自动建 ~/.zenpilot/ 与项目目录
  writeFileSync(p, JSON.stringify(obj, null, 2) + "\n", "utf8");
}

function writeText(p: string, content: string): void {
  mkdirSync(path.dirname(p), { recursive: true });
  writeFileSync(p, content, "utf8");
}

/** HTML 转义:渲染日报/周报 HTML 用(mdCell 只处理 Markdown 的 | 与换行,不能用于 HTML)。 */
function esc(s: unknown): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Python 的 round 是「四舍五入到偶数」(banker's rounding),JS Math.round 是 half-up,需自行实现。 */
function roundPy(value: number, digits = 0): number {
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

function pad2(n: number): string {
  return n < 10 ? "0" + n : String(n);
}

/** 本地日期 YYYY-MM-DD(不能用 toISOString,那是 UTC)。 */
function todayISO(): string {
  const d = new Date();
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** 本地时间 YYYY-MM-DDTHH:MM:SS,无时区后缀(对齐 Python datetime.isoformat(timespec="seconds"))。 */
function nowISOSeconds(): string {
  const d = new Date();
  return `${todayISO()}T${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

/** 距离一个无时区 ISO 串的分钟数(ES 把无 tz 的日期时间按本地解析,与 Python fromisoformat 一致)。 */
function minutesSinceISO(iso: string): number {
  return (Date.now() - new Date(iso).getTime()) / 60000;
}

function hoursFromMinutes(minutes: number): number {
  return Math.max(roundPy((minutes / 60) * 2) / 2, 0.5);
}

/** 对齐 Python str(float):整数显示为 2.0,非整数显示为 2.5(仅用于 render 文本)。 */
function fmtHours(n: number): string {
  return Number.isInteger(n) ? `${n}.0` : `${n}`;
}

function isObj(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null;
}

function loadConfig(): Record<string, any> {
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

function requireStr(a: Args, k: string): string {
  if (a[k] === undefined) die(`缺少必填参数: --${k}`);
  return String(a[k]);
}
function requireInt(a: Args, k: string): number {
  if (a[k] === undefined) die(`缺少必填参数: --${k}`);
  return parseInt(String(a[k]), 10);
}

// ---------- 会话采集(从 transcript 挖掘真实会话)----------

const IDLE_CAP_MS = 10 * 60 * 1000;

function num(x: unknown): number {
  const n = Number(x);
  return Number.isFinite(n) ? n : 0;
}

function countLines(s: unknown): number {
  if (typeof s !== "string" || s.length === 0) return 0;
  return s.split("\n").length;
}

function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((b: any) => b && b.type === "text" && typeof b.text === "string")
      .map((b: any) => b.text)
      .join("\n");
  }
  return "";
}

function localDateISO(iso: string): string {
  const d = new Date(iso);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function localHHMM(v: string | number): string {
  const d = new Date(v);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

function localMidnightEpoch(): number {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function gitBranchFallback(cwd: string | null): string | null {
  if (!cwd) return null;
  try {
    const r = Bun.spawnSync(["git", "-C", cwd, "rev-parse", "--abbrev-ref", "HEAD"]);
    const out = (r.stdout?.toString() ?? "").trim();
    return out && out !== "HEAD" ? out : null;
  } catch {
    return null;
  }
}

// ---------- shine-worklog daemon 数据接入(合并后 collect 改读 daemon,不再挖 transcript) ----------

/** 读 shine-worklog daemon 的持久 token(复刻 src/shared/pidfile.ts readToken + paths.ts DATA_DIR,跨平台,零依赖)。 */
function readDaemonToken(): string | null {
  try {
    const pid = JSON.parse(readFileSync(path.join(DATA_DIR, "daemon.pid"), "utf8"));
    if (pid && typeof pid.token === "string" && pid.token) return pid.token;
  } catch {
    /* ignore */
  }
  try {
    const t = readFileSync(path.join(DATA_DIR, "daemon.token"), "utf8").trim();
    if (t.length >= 16) return t;
  } catch {
    /* ignore */
  }
  return null;
}

const DAEMON_BASE = "http://127.0.0.1:36666"; // config.ts BASE_URL,回环固定

/** 查 daemon 当天本项目 sessions(GET /api/sessions?cwd=&since=当日0点)。 */
async function fetchDaemonSessions(
  cwd: string,
  sinceMs: number,
  token: string,
): Promise<{ sessions: any[]; total: number }> {
  const url = `${DAEMON_BASE}/api/sessions?cwd=${encodeURIComponent(cwd)}&since=${sinceMs}&pageSize=200`;
  const res = await fetch(url, {
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(3000),
  });
  if (!res.ok) throw new Error(`daemon HTTP ${res.status}`);
  return (await res.json()) as { sessions: any[]; total: number };
}

/** daemon ProjectSession → ZenPilot session(字段映射见合并方案 2.1)。 */
function toZenSession(s: any, branch: string | null): any {
  const activeMs = num(s.activeMs);
  const lastActive = num(s.lastActive);
  const tt = s.tokenTotal || {};
  const lt = s.linesTotal || { added: 0, deleted: 0, modified: 0 };
  return {
    id: s.sessionId,
    cwd: s.cwd || PROJECT_CWD,
    repo: path.basename(s.cwd || PROJECT_CWD),
    branch,
    start: localHHMM(Math.max(0, lastActive - activeMs)),
    end: localHHMM(lastActive),
    activeMinutes: Math.round(activeMs / 60000),
    tokens: { input: num(tt.input) + num(tt.cacheCreation) + num(tt.cacheRead), output: num(tt.output) },
    filesChanged: 0,
    linesAdded: num(lt.added) + num(lt.modified),
    linesRemoved: num(lt.deleted) + num(lt.modified),
    summary: typeof s.title === "string" && s.title ? s.title : "(无文本提示)",
  };
}

// ---------- 以下 transcript 挖掘相关函数合并后已不再被 cmdCollect 调用(改读 daemon) ----------
// @deprecated 保留作「daemon 不可达时的应急/诊断」备用,合并稳定后再单独清理。

/** 挖掘单条 transcript,派生出一个 session(含内部 date 字段,用于全量过滤后剔除)。 */
function mineSession(transcriptPath: string): any | null {
  let raw: string;
  try {
    raw = readFileSync(transcriptPath, "utf8");
  } catch {
    return null;
  }
  let sessionId: string | null = null;
  let cwd: string | null = null;
  const branches: string[] = [];
  const stamps: string[] = [];
  const prompts: string[] = [];
  let lastInputTokens = 0;
  let outputTokens = 0;
  const files = new Set<string>();
  let added = 0;
  let removed = 0;

  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let ev: any;
    try {
      ev = JSON.parse(line);
    } catch {
      continue;
    }
    if (ev.sessionId) sessionId = ev.sessionId;
    if (ev.cwd && !cwd) cwd = ev.cwd; // 取首条 cwd=项目根(后续 shell cd 不影响归属)
    if (ev.gitBranch && ev.gitBranch !== "HEAD") branches.push(ev.gitBranch);
    const role = ev.message?.role;
    const ts = ev.timestamp;
    if ((role === "user" || role === "assistant") && typeof ts === "string") stamps.push(ts);
    if (role === "user") {
      const text = extractText(ev.message?.content).trim();
      if (text && !text.startsWith("<") && text.length > 1 && text.length <= 300) prompts.push(text);
    }
    if (role === "assistant") {
      const u = ev.message?.usage;
      if (u) {
        // input 取最后一轮的上下文快照(量级直观);output 累加=总生成
        lastInputTokens = num(u.input_tokens) + num(u.cache_read_input_tokens) + num(u.cache_creation_input_tokens);
        outputTokens += num(u.output_tokens);
      }
      const content = ev.message?.content;
      if (Array.isArray(content)) {
        for (const b of content) {
          if (!b || b.type !== "tool_use") continue;
          const input = b.input || {};
          if (typeof input.file_path === "string") files.add(input.file_path);
          if (b.name === "Edit") {
            added += countLines(input.new_string);
            removed += countLines(input.old_string);
          } else if (b.name === "Write") {
            added += countLines(input.content);
          } else if (b.name === "MultiEdit" && Array.isArray(input.edits)) {
            for (const e of input.edits) {
              added += countLines(e.new_string);
              removed += countLines(e.old_string);
            }
          }
        }
      }
    }
  }

  if (stamps.length === 0) return null;
  stamps.sort((a, b) => new Date(a).getTime() - new Date(b).getTime());
  let activeMs = 0;
  for (let i = 1; i < stamps.length; i++) {
    const gap = new Date(stamps[i]).getTime() - new Date(stamps[i - 1]).getTime();
    if (gap > 0 && gap <= IDLE_CAP_MS) activeMs += gap;
  }

  const seen = new Set<string>();
  const uniq: string[] = [];
  for (const p of prompts) {
    const k = p.slice(0, 60);
    if (!seen.has(k)) {
      seen.add(k);
      uniq.push(p);
    }
    if (uniq.length >= 3) break;
  }
  let summary = uniq.join(" / ").replace(/\s+/g, " ").trim();
  if (summary.length > 200) summary = summary.slice(0, 197) + "...";

  return {
    id: sessionId ?? path.basename(transcriptPath, ".jsonl"),
    cwd: cwd ?? null,
    repo: cwd ? path.basename(cwd) : path.basename(path.dirname(transcriptPath)),
    branch: branches.length ? branches[branches.length - 1] : gitBranchFallback(cwd),
    start: localHHMM(stamps[0]),
    end: localHHMM(stamps[stamps.length - 1]),
    activeMinutes: Math.round(activeMs / 60000),
    tokens: { input: lastInputTokens, output: outputTokens },
    filesChanged: files.size,
    linesAdded: added,
    linesRemoved: removed,
    summary: summary || "(无文本提示)",
    date: localDateISO(stamps[0]),
  };
}

function samePath(a: string, b: string): boolean {
  return a.replace(/\//g, "\\").toLowerCase() === b.replace(/\//g, "\\").toLowerCase();
}

function fullScanToday(): any[] {
  // 扫所有项目的 transcript,按 cwd 归属当前项目(不靠目录名编码,避免带空格/中文等路径失配)
  const root = path.join(homedir(), ".claude", "projects");
  if (!existsSync(root)) return [];
  const today = todayISO();
  const startToday = localMidnightEpoch();
  const out: any[] = [];
  let projs: string[] = [];
  try {
    projs = readdirSync(root);
  } catch {
    return [];
  }
  for (const proj of projs) {
    const projDir = path.join(root, proj);
    let entries: string[] = [];
    try {
      entries = readdirSync(projDir);
    } catch {
      continue;
    }
    for (const f of entries) {
      if (!f.endsWith(".jsonl")) continue;
      const full = path.join(projDir, f);
      try {
        if (statSync(full).mtimeMs < startToday) continue;
      } catch {
        continue;
      }
      const mined = mineSession(full);
      if (mined && mined.date === today && mined.cwd && samePath(mined.cwd, PROJECT_CWD)) {
        const { date, cwd, ...session } = mined;
        out.push(session);
      }
    }
  }
  return out;
}

function upsertSession(session: any): void {
  const today = todayISO();
  let data = loadJSON<any>(SESSIONS_PATH, { date: today, sessions: [] as any[] });
  if (data.date !== today) data = { date: today, sessions: [] };
  const idx = data.sessions.findIndex((s: any) => s.id === session.id);
  if (idx >= 0) data.sessions[idx] = session;
  else data.sessions.push(session);
  writeJSON(SESSIONS_PATH, data);
}

async function readStdinTimed(ms = 2000): Promise<string> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v: string) => {
      if (!done) {
        done = true;
        resolve(v);
      }
    };
    const timer = setTimeout(() => finish(""), ms);
    Bun.stdin
      .text()
      .then((t) => {
        clearTimeout(timer);
        finish(t);
      })
      .catch(() => finish(""));
  });
}

async function cmdCollect(): Promise<any> {
  // 合并后:collect 改读 shine-worklog daemon 的 /api/sessions(不再挖 transcript)。
  // hook 模式(Stop hook 触发,stdin 携带 payload)与 full 模式(/report 兜底手动跑)统一:
  //   读 daemon token → GET /api/sessions?cwd=本项目&since=当日0点 → 映射成 ZenPilot session → 写 sessions.json。
  // daemon 不可达时:hook 静默跳过(不写、不崩、不影响 hook);full 给错误提示。
  const isHook = process.stdin.isTTY !== true;
  let hookSessionId: string | null = null;
  if (isHook) {
    // hook 模式:读 stdin 仅取 session_id(日志/诊断用),不依赖其内容挖掘
    try {
      const text = await readStdinTimed();
      if (text.trim()) hookSessionId = JSON.parse(text)?.session_id ?? null;
    } catch {
      /* ignore */
    }
  }

  // 1. 读 daemon token
  const token = readDaemonToken();
  if (!token) {
    if (isHook) return { mode: "hook", skipped: "daemon token unavailable", hookSessionId };
    return { mode: "full", error: "daemon 未运行或 token 读不到(shine-worklog daemon 未启动)" };
  }

  // 2. 查 daemon 当天本项目 sessions
  let resp: { sessions: any[]; total: number };
  try {
    resp = await fetchDaemonSessions(PROJECT_CWD, localMidnightEpoch(), token);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (isHook) return { mode: "hook", skipped: "daemon fetch failed", error: msg, hookSessionId };
    return { mode: "full", error: `daemon 查询失败: ${msg}` };
  }

  // 3. branch 单值探测(daemon 不提供 branch,每 collect 调一次,所有 session 共用当前分支)
  const branch = gitBranchFallback(PROJECT_CWD);

  // 4. 映射 + 写盘(hook 仅在有数据时写,防 daemon 消费者 lag 误删;full 照实写含空)
  const sessions = resp.sessions.map((s: any) => toZenSession(s, branch));
  if (sessions.length > 0 || !isHook) {
    writeJSON(SESSIONS_PATH, { date: todayISO(), sessions });
  }

  return {
    mode: isHook ? "hook" : "full",
    date: todayISO(),
    count: sessions.length,
    hookSessionId,
    sessions: sessions.map((s: any) => ({ id: s.id, repo: s.repo, branch: s.branch, activeMinutes: s.activeMinutes })),
  };
}

// ---------- 禅道客户端 ----------

class Client {
  base: string;
  account: string;
  token = "";

  constructor(cfg: Record<string, any>) {
    this.base = cfg.url + "/api.php/v1";
    this.account = cfg.account;
  }

  async login(cfg: Record<string, any>): Promise<void> {
    const resp = await this._request("POST", "/tokens", {
      account: cfg.account,
      password: cfg.password,
    }, false);
    this.token = resp.token;
    if (!this.token) die("获取 token 失败,请检查账号密码");
  }

  /** 三分错误:网络层(含超时)→ die 退出;HTTP 非 2xx → throw 供调用方 catch 重试;2xx → JSON。 */
  async _request(method: string, p: string, body: unknown = null, auth = true): Promise<any> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "User-Agent": "ZenPilot-Bun/0.1",
    };
    if (auth) headers["Token"] = this.token;
    const init: any = { method, headers, signal: AbortSignal.timeout(30000) };
    if (body !== null) init.body = JSON.stringify(body);
    let resp: Response;
    try {
      resp = await fetch(this.base + p, init);
    } catch (e) {
      die(`无法连接禅道服务器: ${e instanceof Error ? e.message : String(e)}`);
    }
    const text = await resp.text();
    if (!resp.ok) {
      throw new Error(`${method} ${p} -> HTTP ${resp.status}: ${text.slice(0, 300)}`);
    }
    return JSON.parse(text);
  }

  async get(p: string): Promise<any> {
    return this._request("GET", p);
  }

  async myProjects(limit = 100, filterActive = false): Promise<any[]> {
    const data = await this.get(`/projects?involved=1&status=doing&limit=${limit}&order=lastEditedDate_desc`);
    let raw: any[] = data.projects || [];
    if (filterActive) {
      // 一层过滤:剔除任务全完成的项目(剩余工时 left=0),零额外请求
      raw = raw.filter((p: any) => Number(p.left) > 0);
    }
    return raw.map((p: any) => ({
      id: p.id,
      name: p.name,
      lastEdited: p.lastEditedDate ?? null,
    }));
  }

  /** 任务下「我」的工时记录(efforts),过滤 account=me + 未删除 */
  async myEfforts(taskId: number): Promise<any[]> {
    const data = (await this.get(`/tasks/${taskId}/estimate`)).effort || {};
    const records: any[] = Array.isArray(data) ? data : Object.values(data);
    return records
      .filter((r: any) => r.account === this.account && r.deleted === "0")
      .map((r: any) => ({ date: r.date ?? null, consumed: Number(r.consumed) || 0, work: r.work ?? "" }));
  }

  async myTasks(projectIds: number[], statuses: Set<string> | null): Promise<any[]> {
    const results: any[] = [];
    for (const pid of projectIds) {
      let execs: any[];
      try {
        execs = (await this.get(`/projects/${pid}/executions?limit=50`)).executions || [];
      } catch {
        continue;
      }
      for (const ex of execs) {
        if (ex.status !== "doing") continue;
        let tasks: any[];
        try {
          tasks = (await this.get(`/executions/${ex.id}/tasks?limit=200`)).tasks || [];
        } catch {
          continue;
        }
        for (const t of tasks) {
          const at = t.assignedTo;
          const acc = isObj(at) ? (at as any).account : at;
          if (acc !== this.account) continue;
          if (statuses && !statuses.has(t.status)) continue;
          results.push({
            id: t.id,
            name: t.name,
            status: t.status,
            estimate: t.estimate ?? null,
            consumed: t.consumed ?? null,
            left: t.left ?? null,
            project: pid,
            execution: ex.id,
            executionName: ex.name ?? null,
          });
        }
      }
    }
    return results;
  }

  async executions(projectIds: number[]): Promise<any[]> {
    const results: any[] = [];
    for (const pid of projectIds) {
      let execs: any[];
      try {
        execs = (await this.get(`/projects/${pid}/executions?limit=50`)).executions || [];
      } catch {
        continue;
      }
      for (const ex of execs) {
        if (ex.status === "doing") {
          results.push({ id: ex.id, name: ex.name ?? null, project: pid, end: ex.end ?? null });
        }
      }
    }
    return results;
  }

  async createTask(executionId: number, name: string, estimate: number, taskType = "devel", desc = ""): Promise<any> {
    const today = todayISO();
    const payload: any = {
      name,
      type: taskType,
      assignedTo: [this.account],
      estimate,
      left: estimate,
      desc,
      estStarted: today,
      deadline: today,
    };
    let resp: any;
    try {
      resp = await this._request("POST", `/executions/${executionId}/tasks`, payload);
    } catch {
      payload.assignedTo = this.account; // 部分版本 assignedTo 只接受字符串
      resp = await this._request("POST", `/executions/${executionId}/tasks`, payload);
    }
    return {
      created: true,
      task: { id: resp.id ?? null, name: resp.name ?? null },
      execution: executionId,
      estimate,
    };
  }

  async submitEffort(taskId: number, date: string, hours: number, work: string, left: number | null = null, dryRun = false): Promise<any> {
    const task = await this.get(`/tasks/${taskId}`);
    if (left === null || left === undefined) {
      left = Math.max(roundPy(Number(task.left ?? 0) - hours, 1), 0);
    }
    const payload: any = { date: [date], work: [work], consumed: [hours], left: [left] };
    const legacy: any = { id: [0], objectID: [taskId], dates: [date], work: [work], consumed: [hours], left: [left], objectType: ["task"] };
    if (dryRun) {
      return {
        dryRun: true,
        task: { id: taskId, name: task.name ?? null },
        endpoint: `POST /tasks/${taskId}/estimate`,
        payload,
      };
    }
    let resp: any;
    try {
      resp = await this._request("POST", `/tasks/${taskId}/estimate`, payload);
    } catch {
      resp = await this._request("POST", `/tasks/${taskId}/estimate`, legacy); // 禅道 < 20.7 旧版请求体
    }
    return {
      submitted: true,
      task: { id: taskId, name: task.name ?? null },
      consumed: resp.consumed ?? null,
      left: resp.left ?? null,
    };
  }
}

// ---------- 命令实现 ----------

function cmdConfig(a: Args): any {
  const cfg = existsSync(CONFIG_PATH) ? JSON.parse(readFileSync(CONFIG_PATH, "utf8")) : {};
  if (a.url !== undefined) cfg.url = String(a.url).replace(/\/+$/, "");
  if (a.account !== undefined) cfg.account = a.account;
  if (a.password !== undefined) cfg.password = a.password;
  if (a.projects !== undefined) {
    cfg.projectIds = String(a.projects)
      .split(",")
      .filter((x: string) => x.trim() !== "")
      .map((x: string) => parseInt(x, 10));
  }
  if (!a.show) {
    mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
    writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2) + "\n", "utf8");
    chmodSync(CONFIG_PATH, 0o600);
  }
  const masked = { ...cfg };
  if (masked.password) masked.password = "***";
  return {
    path: CONFIG_PATH,
    config: masked,
    missing: ["url", "account", "password"].filter((k) => !cfg[k]),
  };
}

/** 读禅道缓存 TTL(分钟):从 daemon DATA_DIR/settings.json 取 zentaoCacheTtlMin。
 *  >0 启用过期自动重拉;0/null=禁用(显式,永远复用缓存除非手动 refresh);读不到(文件缺失/损坏)→ 默认 60(对齐 daemon DEFAULTS)。
 *  zentao.ts 是零依赖独立脚本,不 import daemon 代码,这里直接 readFileSync settings.json。 */
function readZentaoCacheTtlMin(): number | null {
  try {
    const s = JSON.parse(readFileSync(path.join(DATA_DIR, "settings.json"), "utf8"));
    const v = (s as any)?.zentaoCacheTtlMin;
    if (typeof v === "number" && v > 0) return Math.floor(v);
    if (v === 0 || v === null) return null; // 显式禁用
  } catch {
    /* 文件不存在/损坏 → 走默认 */
  }
  return 60;
}

async function getCache(client: Client, cfg: Record<string, any>, refresh = false): Promise<any> {
  const existing = loadJSON<any>(CACHE_PATH, null);
  const ttl = readZentaoCacheTtlMin();
  const expired = ttl !== null && existing !== null && (!existing.fetchedAt || minutesSinceISO(existing.fetchedAt) > ttl);
  if (existing !== null && !refresh && !expired) return existing;
  // 1000 上限避开禅道默认 100 截断;filterActive=true 只留「我参与 + 还有剩余工时(left>0)」的项目,
  // 剔除任务全完成/关闭的历史项目,减少噪音(语义对齐 projects 命令默认过滤)。
  const projects = await client.myProjects(1000, true);
  // 遍历每个项目(配了 projectIds 用配置,否则全部 involved)查「我的未关闭任务」(doing/wait),
  // 再只留「我的任务有未关闭」的项目——剔除「我的任务全关、只剩别人在做」的项目。
  const pids = cfg.projectIds && cfg.projectIds.length
    ? cfg.projectIds
    : projects.map((p: any) => p.id);
  const tasks = await client.myTasks(pids, new Set(["doing", "wait"]));
  const taskProjIds = new Set(tasks.map((t: any) => t.project));
  const activeProjects = projects.filter((p: any) => taskProjIds.has(p.id));
  const cache = {
    fetchedAt: nowISOSeconds(),
    projects: activeProjects,
    tasks,
    executions: await client.executions(activeProjects.map((p: any) => p.id)),
    taskDetails: existing?.taskDetails ?? {},
  };
  writeJSON(CACHE_PATH, cache);
  return cache;
}

async function cmdPlan(client: Client, cfg: Record<string, any>): Promise<any> {
  const data = loadJSON<any>(SESSIONS_PATH, null);
  if (data === null) die(`会话数据不存在: ${SESSIONS_PATH}`);
  const date = data.date;
  const mappings = loadJSON<any>(MAPPINGS_PATH, { repoToProject: {}, branchToTask: {} });
  const submittedAll = loadJSON<any>(SUBMITTED_PATH, {});
  const submitted = submittedAll[date] || {};
  const cache = await getCache(client, cfg);
  const projectNames: Record<number, string> = {};
  for (const p of cache.projects) projectNames[p.id] = p.name;
  const tasks = cache.tasks;
  const taskById: Record<number, any> = {};
  for (const t of tasks) taskById[t.id] = t;

  const taskInfo = async (taskId: number | null): Promise<any> => {
    let t = (taskId != null ? taskById[taskId] : undefined) || cache.taskDetails[String(taskId)];
    if (!t) {
      try {
        const raw = await client.get(`/tasks/${taskId}`);
        const ex = raw.execution;
        const pid = isObj(ex) ? (ex as any).project : raw.project;
        t = { name: raw.name ?? null, project: pid ?? null };
        cache.taskDetails[String(taskId)] = t;
        writeJSON(CACHE_PATH, cache);
      } catch {
        return {};
      }
    }
    return {
      taskName: t.name ?? null,
      project: t.project ?? null,
      projectName: projectNames[t.project] ?? null,
    };
  };

  const items: any[] = [];
  for (const s of data.sessions) {
    const item: any = {
      session: s.id,
      repo: s.repo,
      branch: s.branch,
      start: s.start,
      end: s.end,
      minutes: s.activeMinutes,
      summary: s.summary ?? "",
      increment: false,
      work: null,
    };
    const rec = submitted[s.id];
    if (rec) {
      const tasksList = Array.isArray(rec.tasks) && rec.tasks.length ? rec.tasks : [null];
      const taskId = tasksList[tasksList.length - 1];
      const delta = s.activeMinutes - (rec.minutes ?? 0);
      if (delta < 15) {
        Object.assign(item, { status: "already", task: taskId, submittedHours: rec.hours ?? null }, await taskInfo(taskId));
      } else {
        Object.assign(
          item,
          {
            status: "resolved",
            increment: true,
            task: taskId,
            hours: hoursFromMinutes(delta),
            confidence: 95,
            reason: "已提交会话的增量补报,沿用原任务",
          },
          await taskInfo(taskId),
        );
      }
      items.push(item);
      continue;
    }
    item.hours = hoursFromMinutes(s.activeMinutes);
    const m = /task-(\d+)/.exec(s.branch || "");
    if (m) {
      const tid = parseInt(m[1], 10);
      Object.assign(item, { status: "resolved", task: tid, confidence: 95, reason: "分支名含任务号" }, await taskInfo(tid));
    } else {
      const pid = mappings.repoToProject ? mappings.repoToProject[s.repo] : undefined;
      const cands = tasks.filter((t: any) => pid == null || t.project === pid);
      Object.assign(item, {
        status: "needs_semantic",
        reason: pid != null ? `仓库映射到项目 ${pid},候选已收窄` : "无仓库映射,候选为全部任务",
        candidates: cands.map((t: any) => ({
          id: t.id,
          name: t.name,
          project: t.project,
          projectName: projectNames[t.project] ?? null,
        })),
      });
    }
    items.push(item);
  }

  // 顺手刷新本地项目名缓存,供 mappings 离线查看
  mappings.projectNames = {};
  for (const [k, v] of Object.entries(projectNames)) mappings.projectNames[String(k)] = v;
  writeJSON(MAPPINGS_PATH, mappings);

  const plan = { date, draftSeq: 0, items };
  writeJSON(PLAN_PATH, plan);
  return plan;
}

function cmdRender(): string {
  const plan = loadJSON<any>(PLAN_PATH, null);
  if (plan === null) die(`计划不存在,请先运行 plan 命令: ${PLAN_PATH}`);
  const items = plan.items;
  const pending = items.filter((i: any) => i.status === "needs_semantic").map((i: any) => i.session);
  if (pending.length) die("尚有会话未完成归属(needs_semantic),补全后才能渲染草稿", { sessions: pending });
  const noWork = items.filter((i: any) => i.status === "resolved" && !i.work).map((i: any) => i.session);
  if (noWork.length) die("以下 resolved 条目缺少 work 字段(工作内容)", { sessions: noWork });
  plan.draftSeq = (plan.draftSeq ?? 0) + 1;
  writeJSON(PLAN_PATH, plan);

  const lines: string[] = [
    `今日工时草稿 #ZR-${plan.date.replace(/-/g, "")}-${String(plan.draftSeq).padStart(3, "0")}`,
    "",
  ];
  let n = 0;
  for (const i of items) {
    if (i.status !== "resolved") continue;
    n++;
    const inc = i.increment ? "(增量)" : "";
    lines.push(
      `[${n}] ${i.projectName || i.repo}(项目#${i.project}) / ${i.taskName || "?"}(任务#${i.task})`,
      `    ${i.start}—${i.end},${fmtHours(i.hours)}小时${inc}`,
      `    内容:${i.work}`,
      `    置信度:${i.confidence}%`,
      `    理由:${i.reason ?? null}`,
      "",
    );
  }
  const skipped = items.filter((i: any) => i.status === "skipped");
  if (skipped.length) {
    lines.push("跳过(不提交):");
    for (const i of skipped) {
      lines.push(
        `[·] ${i.repo}/${i.branch} ${i.start}—${i.end},${fmtHours(i.hours || hoursFromMinutes(i.minutes))}小时 — ${i.skipReason || "用户选择跳过"}`,
      );
    }
    lines.push("");
  }
  const already = items.filter((i: any) => i.status === "already");
  if (already.length) {
    lines.push("已提交(本次不再提交):");
    for (const i of already) {
      lines.push(`[·] ${i.taskName || ""}(任务#${i.task}) ${fmtHours(i.submittedHours)}小时 — 会话 ${i.session}`);
    }
    lines.push("");
  }
  lines.push("状态:未提交");
  return lines.join("\n");
}

function recordSubmission(date: string, session: string, taskId: number, hours: number, minutes: number | null): any {
  const log = existsSync(SUBMITTED_PATH) ? JSON.parse(readFileSync(SUBMITTED_PATH, "utf8")) : {};
  if (!log[date]) log[date] = {};
  const day = log[date];
  if (!day[session]) day[session] = { tasks: [], hours: 0, minutes: 0 };
  const rec = day[session];
  if (!rec.tasks.includes(taskId)) rec.tasks.push(taskId);
  rec.hours = roundPy(rec.hours + hours, 1);
  if (minutes !== null && minutes !== undefined) rec.minutes = minutes;
  writeJSON(SUBMITTED_PATH, log);
  return rec;
}

async function cmdCommit(client: Client, opts: { dryRun?: boolean; amend?: boolean }): Promise<any> {
  const dryRun = !!opts.dryRun;
  const amend = !!opts.amend;
  const plan = loadJSON<any>(PLAN_PATH, null);
  if (plan === null) die(`计划不存在,请先运行 plan 命令: ${PLAN_PATH}`);
  const items = plan.items;
  const pending = items.filter((i: any) => i.status === "needs_semantic").map((i: any) => i.session);
  if (pending.length) die("尚有会话未完成归属,不能提交", { sessions: pending });
  const toSubmit = items.filter((i: any) => i.status === "resolved");
  const noWork = toSubmit.filter((i: any) => !i.work).map((i: any) => i.session);
  if (noWork.length) die("以下条目缺少 work 字段,不能提交", { sessions: noWork });
  const meta = (loadJSON<any>(SUBMITTED_PATH, {})[plan.date] || {})._meta || {};
  if (amend) {
    if (!meta.lastCommit) die("没有可修正的提交:今天还没有 commit 记录");
    const allowed = new Set(meta.lastCommit.map((e: any) => e.session));
    const extra = toSubmit.filter((i: any) => !allowed.has(i.session)).map((i: any) => i.session);
    if (extra.length) {
      die("amend 只能修正最后一次提交包含的会话,其余条目请改回 skipped 或等冷却后走 commit", {
        sessions: extra,
        lastCommitSessions: [...allowed].sort(),
      });
    }
  } else if (toSubmit.length && !dryRun && meta.lastCommitAt) {
    const elapsed = minutesSinceISO(meta.lastCommitAt);
    if (elapsed < COMMIT_COOLDOWN_MINUTES) {
      die(
        `距上次提交仅 ${Math.trunc(elapsed)} 分钟,两次提交间隔须≥${COMMIT_COOLDOWN_MINUTES}分钟。用户明确要求修正最后一次提交时,用 amend 命令(禅道只能追加更正记录)`,
        { lastCommitAt: meta.lastCommitAt, waitMinutes: Math.trunc(COMMIT_COOLDOWN_MINUTES - elapsed) + 1 },
      );
    }
  }
  const mappings = loadJSON<any>(MAPPINGS_PATH, { repoToProject: {}, branchToTask: {} });
  const results: any[] = [];
  for (const i of toSubmit) {
    const out = await client.submitEffort(i.task, plan.date, i.hours, i.work, i.left ?? null, dryRun);
    if (out.submitted) {
      recordSubmission(plan.date, i.session, i.task, i.hours, i.minutes);
      if (i.project) {
        mappings.repoToProject[i.repo] = i.project;
        if (i.projectName) {
          if (!mappings.projectNames) mappings.projectNames = {};
          mappings.projectNames[String(i.project)] = i.projectName;
        }
      }
    }
    results.push({ session: i.session, hours: i.hours, ...out });
  }
  const ok = results.filter((r: any) => r.submitted);
  if (!dryRun) {
    writeJSON(MAPPINGS_PATH, mappings);
    if (ok.length) {
      const log = loadJSON<any>(SUBMITTED_PATH, {});
      if (!log[plan.date]) log[plan.date] = {};
      const day = log[plan.date];
      const entries = ok.map((r: any) => ({ session: r.session, task: r.task.id, hours: r.hours }));
      if (amend && day._meta) {
        day._meta.amendedAt = nowISOSeconds();
        day._meta.lastCommit = day._meta.lastCommit.concat(entries);
      } else {
        day._meta = { lastCommitAt: nowISOSeconds(), lastCommit: entries };
      }
      writeJSON(SUBMITTED_PATH, log);
    }
  }
  return {
    date: plan.date,
    dryRun,
    amend,
    submitted: ok.length,
    skipped: items.filter((i: any) => i.status === "skipped").map((i: any) => i.session),
    results,
    mappings,
  };
}

function cmdMappings(a: Args): any {
  const mappings = loadJSON<any>(MAPPINGS_PATH, { repoToProject: {} });
  const names = mappings.projectNames || {};
  if (a["forget-repo"] !== undefined) {
    const repo = String(a["forget-repo"]);
    const existed = repo in mappings.repoToProject;
    delete mappings.repoToProject[repo];
    writeJSON(MAPPINGS_PATH, mappings);
    if (!existed) die(`映射不存在: ${repo}`);
  }
  return {
    repoToProject: Object.entries(mappings.repoToProject).map(([repo, pid]: [string, any]) => ({
      repo,
      project: pid,
      projectName: names[String(pid)] ?? null,
    })),
  };
}

function cmdLearn(a: Args): any {
  const mappings = existsSync(MAPPINGS_PATH)
    ? JSON.parse(readFileSync(MAPPINGS_PATH, "utf8"))
    : { repoToProject: {}, branchToTask: {} };
  if (a.repo && a.project) mappings.repoToProject[a.repo] = parseInt(String(a.project), 10);
  if (a.branch && a.task) mappings.branchToTask[`${a.repo}:${a.branch}`] = parseInt(String(a.task), 10);
  writeJSON(MAPPINGS_PATH, mappings);
  return mappings;
}

// ---------- 日报 / 周报(从禅道 efforts 汇总)----------

/** 本自然周一(本地日期 YYYY-MM-DD) */
function weekStart(): string {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  const day = d.getDay(); // 0=周日
  d.setDate(d.getDate() - (day === 0 ? 6 : day - 1));
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** 收集日期范围内出现过的任务 ID(遍历所有项目的 submitted.json) */
function collectTaskIds(from: string, to: string): number[] {
  const root = path.join(ZENPILOT_HOME, "projects");
  const ids = new Set<number>();
  let projs: string[] = [];
  try {
    projs = readdirSync(root);
  } catch {
    return [];
  }
  for (const proj of projs) {
    const submitted = loadJSON<any>(path.join(root, proj, "submitted.json"), null);
    if (!submitted) continue;
    for (const date of Object.keys(submitted)) {
      if (date < from || date > to) continue;
      const day = submitted[date];
      if (!isObj(day)) continue;
      for (const key of Object.keys(day)) {
        if (key === "_meta") {
          for (const e of day._meta?.lastCommit || []) if (e.task) ids.add(e.task);
        } else {
          for (const tid of day[key]?.tasks || []) ids.add(tid);
        }
      }
    }
  }
  return [...ids];
}

/** 任务名 + 项目名(优先 cache,缺则 GET /tasks/{id}) */
async function taskNameInfo(client: Client, cache: any, taskId: number): Promise<{ taskName: string; projectName: string }> {
  const taskById: any = {};
  for (const t of cache.tasks) taskById[t.id] = t;
  let t = taskById[taskId] || cache.taskDetails?.[String(taskId)];
  if (!t) {
    try {
      const raw = await client.get(`/tasks/${taskId}`);
      const ex = raw.execution;
      const pid = isObj(ex) ? (ex as any).project : raw.project;
      t = { name: raw.name ?? null, project: pid ?? null };
    } catch {
      t = { name: null, project: null };
    }
  }
  const projectNames: any = {};
  for (const p of cache.projects) projectNames[p.id] = p.name;
  return { taskName: t.name ?? `#${taskId}`, projectName: projectNames[t.project] ?? "" };
}

const WEEKDAYS = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
const round1 = (n: number) => Math.round(n * 10) / 10;

type ReportRow = { hours: number; works: string[] };
type ReportData = {
  from: string;
  to: string;
  title: string;
  realname: string;
  dates: string[]; // 有数据的天,升序
  byDate: Record<string, Record<string, ReportRow>>; // date -> taskId(字符串) -> {hours, works[]}
  infoMap: Map<number, { taskName: string; projectName: string }>;
  zentaoUrl: string;
};

/** 装配日报/周报数据:从禅道 efforts 汇总日期范围内的提交记录(纯数据,不含渲染)。 */
async function gatherReport(client: Client, cfg: Record<string, any>, from: string, to: string): Promise<ReportData> {
  const cache = await getCache(client, cfg);
  const ids = new Set<number>(collectTaskIds(from, to));
  for (const t of cache.tasks) ids.add(t.id);
  const idList = [...ids];

  const effMap = new Map<number, any[]>(
    await Promise.all(idList.map(async (id): Promise<[number, any[]]> => {
      try { return [id, await client.myEfforts(id)]; } catch { return [id, []]; }
    })),
  );
  const infoMap = new Map<number, any>(
    await Promise.all(idList.map(async (id): Promise<[number, any]> => {
      try { return [id, await taskNameInfo(client, cache, id)]; } catch { return [id, { taskName: `#${id}`, projectName: "" }]; }
    })),
  );

  // 按日期分组:date -> taskId(字符串) -> {hours, works[]}
  const byDate: Record<string, Record<string, ReportRow>> = {};
  for (const id of idList) {
    for (const e of effMap.get(id) || []) {
      if (!e.date || e.date < from || e.date > to) continue;
      const day = (byDate[e.date] ??= {});
      const key = String(id);
      (day[key] ??= { hours: 0, works: [] as string[] });
      day[key].hours += e.consumed;
      if (e.work) day[key].works.push(e.work);
    }
  }

  let realname = cfg.account;
  try {
    realname = ((await client.get("/user")).profile || {}).realname || realname;
  } catch {}

  const dates = Object.keys(byDate).sort();
  const title = from === to ? `日报 ${from}` : `周报 ${from} ~ ${to}`;
  return { from, to, title, realname, dates, byDate, infoMap, zentaoUrl: cfg.url };
}

const REPORT_CSS = `
  :root {
    --ink:#0f172a; --muted:#64748b; --line:#e2e8f0; --line-soft:#eef2f5;
    --accent:#4f46e5; --accent2:#7c3aed;
    --bg1:#eef2f7; --bg2:#f5f7fa;
  }
  * { box-sizing:border-box; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", "PingFang SC", Roboto, sans-serif;
    color: var(--ink);
    background: linear-gradient(180deg, var(--bg1), var(--bg2));
    margin:0; padding:0 16px 18px; line-height:1.5; font-weight:700;
    -webkit-font-smoothing: antialiased;
  }
  .report { width:95%; margin:0 auto; background:#fff; border-radius:18px; overflow:hidden;
            box-shadow:0 14px 44px rgba(15,23,42,.11); }

  /* Hero */
  .hero { position:relative; overflow:hidden; color:#fff;
          background: linear-gradient(135deg, #4f46e5 0%, #7c3aed 100%);
          padding:16px 28px; display:flex; align-items:center; justify-content:space-between; gap:16px; }
  .hero::after { content:""; position:absolute; right:-70px; top:-70px; width:230px; height:230px;
                 border-radius:50%; background:rgba(255,255,255,.10); }
  .hero::before { content:""; position:absolute; right:96px; bottom:-92px; width:170px; height:170px;
                  border-radius:50%; background:rgba(255,255,255,.07); }
  .hero-left { position:relative; z-index:1; display:flex; align-items:baseline; gap:12px; flex-wrap:wrap; }
  .hero-stat { position:relative; z-index:1; }
  .hero-type { font-size:11.5px; letter-spacing:.22em; text-transform:uppercase; opacity:.85; font-weight:700; }
  .hero-title { font-size:20px; font-weight:800; margin:0; letter-spacing:.01em; }
  .hero-sub { font-size:13px; opacity:.88; }
  .hero-stat { text-align:right; }
  .hero-stat-num { font-size:28px; font-weight:800; line-height:1; font-variant-numeric:tabular-nums; }
  .hero-stat-label { font-size:12px; opacity:.85; margin-top:5px; letter-spacing:.05em; }

  /* Meta chips */
  .meta { display:flex; gap:8px 20px; flex-wrap:wrap; padding:9px 28px;
          border-bottom:1px solid var(--line); background:#fafbfc; }
  .chip { font-size:13.5px; color:var(--muted); }
  .chip b { color:var(--ink); font-weight:700; font-variant-numeric:tabular-nums; margin-right:3px; }

  /* Body */
  .report-body { padding:12px 24px 16px; }

  /* Day header (weekly) */
  .day-head { display:flex; align-items:baseline; justify-content:space-between;
              margin:16px 0 0; padding-bottom:5px; border-bottom:2px solid var(--line-soft); }
  .day-head:first-child { margin-top:0; }
  .day-date { font-size:16px; font-weight:800; color:var(--ink); }
  .day-week { font-size:12.5px; color:var(--muted); margin-left:8px; font-weight:500; }
  .day-total { font-size:15px; font-weight:800; color:var(--accent); font-variant-numeric:tabular-nums; }

  /* Table */
  table { width:100%; border-collapse:collapse; font-size:14px; margin-top:8px; }
  thead th { background:#f8fafc; color:#475569; font-weight:600; font-size:13px; }
  th, td { border:1px solid #94a3b8; padding:6px 10px; text-align:left; vertical-align:top; }
  tbody tr:nth-child(even) { background:#fcfcfd; }
  td.hours, th.hours { text-align:right; white-space:nowrap; font-variant-numeric:tabular-nums; font-weight:600; }
  .tid { color:#94a3b8; font-weight:400; font-size:13px; margin-left:4px; }
  .cell-proj { color:var(--ink); font-weight:700; }
  .cell-task { font-weight:700; color:var(--ink); text-decoration:none; }
  a.cell-task:hover { color:var(--accent); text-decoration:underline; }
  .cell-date { width:110px; white-space:nowrap; }
  tr.total td { font-weight:700; color:var(--accent); background:#f3f0ff; }

  /* Grand total (weekly) */
  .grand { margin:16px 0 0; padding:11px 18px; border-radius:12px;
           background:linear-gradient(135deg,#eef2ff,#faf5ff); border:1px solid #e0e7ff;
           display:flex; align-items:center; justify-content:space-between; }
  .grand-label { font-size:14px; color:#475569; font-weight:600; }
  .grand-num { font-size:24px; font-weight:800; color:var(--accent); font-variant-numeric:tabular-nums; }

  /* Empty */
  .empty { padding:56px 0; text-align:center; }
  .empty-icon { font-size:42px; margin-bottom:12px; opacity:.75; }
  .empty-text { color:var(--muted); font-size:14px; }

  /* AI summary */
  .ai-summary { margin:0; padding:18px 28px; border-top:1px solid var(--line); background:#fafbfc; }
  .ai-summary h2 { margin:0 0 10px; font-size:15px; font-weight:800; color:var(--ink); }
  .ai-summary h3 { margin:14px 0 6px; font-size:13.5px; font-weight:700; color:var(--ink); }
  .ai-summary p, .ai-summary li { font-size:13.5px; color:#475569; line-height:1.65; margin:4px 0; }
  .ai-summary ul { margin:4px 0; padding-left:20px; }

  /* Foot */
  .foot { padding:10px 28px; font-size:12.5px; color:var(--muted);
          border-top:1px solid var(--line); background:#fafbfc; }

  @media print {
    body { background:#fff; padding:0; }
    .report { box-shadow:none; max-width:none; border-radius:0; }
    .foot { display:none; }
    .task:hover { transform:none; box-shadow:none; }
  }
`;

const PROJECT_COLORS = ["#6366f1","#10b981","#f59e0b","#ec4899","#06b6d4","#8b5cf6","#ef4444","#84cc16","#0ea5e9","#f97316"];
/** 按项目名稳定地映射到一种颜色(同项目同色),用于任务卡片色条/标签。 */
function projectColor(name: string): { bar: string; bg: string; fg: string } {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  const c = PROJECT_COLORS[h % PROJECT_COLORS.length];
  return { bar: c, bg: c + "1a", fg: c }; // 1a ≈ 10% 透明度,做柔和标签底色
}

/** 把多个 work(各自 "1. a\n2. b" 从1编号)的条目拆出,顺延重新编号成单列表(1..N 不重复)。
 *  一天内多次提交同任务时,日报/周报聚合后避免出现多个重复的 1./2.。 */
function renumberWorks(works: string[]): string {
  const items: string[] = [];
  for (const w of works) {
    for (const line of String(w).replace(/\r/g, "").split("\n")) {
      const t = line.trim();
      if (!t) continue;
      items.push(t.replace(/^\d+\.\s*/, "")); // 去原 "数字. " 前缀,统一重新编号
    }
  }
  return items.map((it, i) => `${i + 1}. ${it}`).join("\n");
}

/** 把报告数据渲染成自包含 HTML(内联 CSS,无外部依赖)。 */
function renderReportHtml(d: ReportData): string {
  const daily = d.from === d.to;
  const dateText = daily ? d.from : `${d.from} ~ ${d.to}`;
  const reportType = daily ? "日报" : "周报";

  const TABLE_HEAD = daily
    ? `<table>\n<thead><tr><th>任务</th><th class="hours">工时</th><th>工作内容</th></tr></thead>\n<tbody>`
    : `<table>\n<thead><tr><th>任务</th><th class="cell-date">日期</th><th class="hours">工时</th><th>工作内容</th></tr></thead>\n<tbody>`;
  const taskRow = (id: string, r: ReportRow, dateCell = "", bg = ""): string => {
    const info = d.infoMap.get(Number(id));
    return `<tr${bg ? ` style="background:${bg}"` : ""}>${dateCell}<td><a class="cell-task" href="${d.zentaoUrl}/index.php?m=task&amp;f=view&amp;taskID=${id}" target="_blank" rel="noopener">${esc(info?.taskName)}</a><span class="tid">#${esc(id)}</span></td><td class="hours">${round1(r.hours)}h</td><td>${esc(renumberWorks(r.works)).replace(/\n/g, "<br>")}</td></tr>`;
  };

  let total = 0;
  let taskCount = 0;
  const projects = new Set<string>();
  let body = "";

  if (d.dates.length === 0) {
    body = `<div class="empty"><div class="empty-icon">📭</div><div class="empty-text">该范围内没有禅道提交记录</div></div>`;
  } else if (daily) {
    const day = d.byDate[d.dates[0]];
    const rows: string[] = [];
    for (const id of Object.keys(day)) {
      total += day[id].hours; taskCount++;
      const info = d.infoMap.get(Number(id)); if (info?.projectName) projects.add(info.projectName);
      rows.push(taskRow(id, day[id]));
    }
    body = `${TABLE_HEAD}\n${rows.join("\n")}\n<tr class="total"><td>合计</td><td class="hours">${round1(total)}h</td><td>${taskCount} 个任务</td></tr>\n</tbody>\n</table>`;
  } else {
    // 按任务分组(同 taskId 聚一起),任务列用 rowspan 合并相同任务
    const groups: { id: number; rows: { date: string; r: ReportRow }[] }[] = [];
    const idxOf = new Map<number, number>();
    for (const date of d.dates) {
      const day = d.byDate[date];
      for (const id of Object.keys(day)) {
        const numId = Number(id);
        let gi = idxOf.get(numId);
        if (gi === undefined) { gi = groups.length; idxOf.set(numId, gi); groups.push({ id: numId, rows: [] }); }
        groups[gi].rows.push({ date, r: day[id] });
        total += day[id].hours;
        const info = d.infoMap.get(numId); if (info?.projectName) projects.add(info.projectName);
      }
    }
    taskCount = groups.length;
    const rows: string[] = [];
    for (let gi = 0; gi < groups.length; gi++) {
      const g = groups[gi];
      const info = d.infoMap.get(g.id);
      g.rows.forEach((row, i) => {
        const taskCell = i === 0
          ? `<td${g.rows.length > 1 ? ` rowspan="${g.rows.length}"` : ""}><a class="cell-task" href="${d.zentaoUrl}/index.php?m=task&amp;f=view&amp;taskID=${g.id}" target="_blank" rel="noopener">${esc(info?.taskName)}</a><span class="tid">#${g.id}</span></td>`
          : "";
        rows.push(`<tr>${taskCell}<td class="cell-date">${esc(row.date.slice(5))}</td><td class="hours">${round1(row.r.hours)}h</td><td>${esc(renumberWorks(row.r.works)).replace(/\n/g, "<br>")}</td></tr>`);
      });
    }
    body = `${TABLE_HEAD}\n${rows.join("\n")}\n<tr class="total"><td colspan="2">本周合计</td><td class="hours">${round1(total)}h</td><td>${taskCount} 个任务</td></tr>\n</tbody>\n</table>`;
  }

  const statNum = d.dates.length === 0 ? "—" : `${round1(total)}h`;
  const chips = [
    `<span class="chip"><b>${taskCount}</b>个任务</span>`,
    `<span class="chip"><b>${projects.size}</b>个项目</span>`,
    daily ? "" : `<span class="chip"><b>${d.dates.length}</b>天</span>`,
  ].filter(Boolean).join("");
  const grand = ""; // 合计已在表尾行(周报单表含日期列)

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(d.title)}</title>
<style>${REPORT_CSS}</style>
</head>
<body>
  <div class="report">
    <div class="hero">
      <div class="hero-left">
        <span class="hero-type">${reportType}</span>
        <span class="hero-title">${esc(dateText)}</span>
        <span class="hero-sub">${esc(d.realname)}</span>
      </div>
      <div class="hero-stat">
        <div class="hero-stat-num">${statNum}</div>
        <div class="hero-stat-label">总工时</div>
      </div>
    </div>
    <div class="meta">${chips}</div>
    <div class="report-body">
${body}${grand}
    </div>
    <!--AI_SUMMARY-->
    <div class="foot">由 ZenPilot 自动生成 · ${esc(dateText)}</div>
  </div>
</body>
</html>`;
}

/** 精简纯文本摘要(供 stdout/对话速览,非落盘文件)。 */
function renderReportText(d: ReportData): string {
  const daily = d.from === d.to;
  if (d.dates.length === 0) return `${d.title} · ${d.realname}\n该范围内没有禅道提交记录。`;
  const line = (id: string, r: ReportRow): string => {
    const info = d.infoMap.get(Number(id));
    return `${info?.projectName ?? ""} / ${info?.taskName ?? ""} #${id}  ${round1(r.hours)}h  ${renumberWorks(r.works).replace(/\n/g, "; ")}`;
  };
  const lines: string[] = [`${d.title} · ${d.realname}`];
  let total = 0;
  if (daily) {
    const day = d.byDate[d.dates[0]];
    for (const id of Object.keys(day)) {
      total += day[id].hours;
      lines.push(line(id, day[id]));
    }
    lines.push(`合计 ${round1(total)}h · ${Object.keys(day).length} 个任务`);
  } else {
    for (const date of d.dates) {
      const day = d.byDate[date];
      const wd = WEEKDAYS[new Date(date + "T00:00:00").getDay()];
      for (const id of Object.keys(day)) {
        total += day[id].hours;
        lines.push(`[${date.slice(5)} ${wd}] ${line(id, day[id])}`);
      }
    }
    lines.push(`本周合计 ${round1(total)}h`);
  }
  return lines.join("\n");
}

/** 生成日报/周报 HTML 并落盘到当前目录 reports/,返回文件路径与文本摘要。 */
async function writeReport(client: Client, cfg: Record<string, any>, from: string, to: string) {
  const data = await gatherReport(client, cfg, from, to);
  const html = renderReportHtml(data);
  const dir = path.join(PROJECT_CWD, "reports");
  const name = from === to ? `日报-${from}.html` : `周报-${from}~${to}.html`;
  const file = path.join(dir, name);
  writeText(file, html);
  return { ok: true, file, title: data.title, empty: data.dates.length === 0, text: renderReportText(data) };
}

// ---------- 参数解析与分发 ----------
// collect 的分发见 main():它是本地命令(不登录禅道),与 render/config 同区。

const BOOL_FLAGS = new Set(["show", "all-status", "dry-run", "all"]);

function parseArgs(argv: string[]): Args {
  const cmd = argv[0];
  const a: Args = { cmd };
  for (let i = 1; i < argv.length; i++) {
    const t = argv[i];
    if (!t.startsWith("--")) continue;
    const raw = t.slice(2);
    const eq = raw.indexOf("=");
    if (eq >= 0) {
      a[raw.slice(0, eq)] = raw.slice(eq + 1);
    } else if (BOOL_FLAGS.has(raw)) {
      a[raw] = true;
    } else {
      a[raw] = argv[++i]; // 取下一个 token 作为值,空串 "" 原样保留
    }
  }
  return a;
}

async function main(): Promise<void> {
  const a = parseArgs(process.argv.slice(2));
  const cmd = a.cmd;
  if (!cmd) {
    die("用法: zentao.ts <命令> [参数],如 config/check/projects/my-tasks/plan/render/commit ...");
  }

  // 仅本地文件、不走网络的命令
  if (cmd === "render") {
    console.log(cmdRender());
    return;
  }
  if (cmd === "collect") {
    console.log(JSON.stringify(await cmdCollect(), null, 2));
    return;
  }
  if (cmd === "config") {
    console.log(JSON.stringify(cmdConfig(a), null, 2));
    return;
  }
  if (cmd === "learn") {
    console.log(JSON.stringify(cmdLearn(a), null, 2));
    return;
  }
  if (cmd === "mappings") {
    console.log(JSON.stringify(cmdMappings(a), null, 2));
    return;
  }

  // 走网络的命令
  const cfg = loadConfig();
  const client = new Client(cfg);
  await client.login(cfg);

  let out: any;
  if (cmd === "daily") {
    const from = (a.from as string) || todayISO();
    console.log(JSON.stringify(await writeReport(client, cfg, from, (a.to as string) || from), null, 2));
    return;
  }
  if (cmd === "weekly") {
    console.log(JSON.stringify(await writeReport(client, cfg, (a.from as string) || weekStart(), (a.to as string) || todayISO()), null, 2));
    return;
  }
  if (cmd === "check") {
    const user = (await client.get("/user")).profile || {};
    out = {
      ok: true,
      account: user.account ?? null,
      realname: user.realname ?? null,
      role: (isObj(user.role) ? (user.role as any).name : null) ?? null,
    };
  } else if (cmd === "projects") {
    const limit = a.limit !== undefined ? parseInt(String(a.limit), 10) : 100;
    let list = await client.myProjects(limit, !a.all); // 默认一层过滤(left>0,剔除任务全完成);--all 显示全部
    if (a.search !== undefined) {
      const kw = String(a.search).toLowerCase();
      list = list.filter((p: any) => String(p.name).toLowerCase().includes(kw));
    }
    out = list;
  } else if (cmd === "my-tasks") {
    let pids: number[];
    if (a.projects) {
      pids = String(a.projects).split(",").map((x: string) => parseInt(x, 10));
    } else {
      pids =
        cfg.projectIds && cfg.projectIds.length
          ? cfg.projectIds
          : (await client.myProjects()).slice(0, 10).map((p: any) => p.id);
    }
    const statuses = a["all-status"] ? null : new Set(["doing", "wait"]);
    out = await client.myTasks(pids, statuses);
  } else if (cmd === "plan") {
    out = await cmdPlan(client, cfg);
  } else if (cmd === "refresh") {
    const c = await getCache(client, cfg, true);
    out = {
      fetchedAt: c.fetchedAt,
      projects: c.projects.length,
      tasks: c.tasks.length,
      executions: c.executions.length,
    };
  } else if (cmd === "commit") {
    out = await cmdCommit(client, { dryRun: !!a["dry-run"] });
  } else if (cmd === "amend") {
    out = await cmdCommit(client, { dryRun: !!a["dry-run"], amend: true });
  } else if (cmd === "efforts") {
    const taskId = requireInt(a, "task");
    const data = (await client.get(`/tasks/${taskId}/estimate`)).effort || {};
    const records: any[] = Array.isArray(data) ? data : Object.values(data);
    out = records
      .filter((r: any) => r.account === client.account && r.deleted === "0")
      .map((r: any) => ({
        effortId: r.id,
        date: r.date ?? null,
        consumed: r.consumed ?? null,
        left: r.left ?? null,
        work: r.work ?? null,
      }));
  } else if (cmd === "executions") {
    if (a.projects) {
      out = await client.executions(String(a.projects).split(",").map((x: string) => parseInt(x, 10)));
    } else {
      out = (await getCache(client, cfg)).executions;
    }
  } else if (cmd === "create-task") {
    const executionId = requireInt(a, "execution");
    const name = requireStr(a, "name");
    const estimate = parseFloat(String(a.estimate));
    out = await client.createTask(
      executionId,
      name,
      estimate,
      a.type !== undefined ? String(a.type) : "devel",
      a.desc !== undefined ? String(a.desc) : "",
    );
    const cache = loadJSON<any>(CACHE_PATH, null);
    if (cache !== null && out.created && out.task.id) {
      const ex = cache.executions?.find((e: any) => e.id === executionId) ?? null;
      cache.tasks.push({
        id: out.task.id,
        name,
        status: "wait",
        estimate,
        consumed: 0,
        left: estimate,
        project: ex ? (ex.project ?? null) : null,
        execution: executionId,
        executionName: ex ? (ex.name ?? null) : null,
      });
      writeJSON(CACHE_PATH, cache);
    }
  } else if (cmd === "submit") {
    const taskId = requireInt(a, "task");
    const date = requireStr(a, "date");
    const hours = parseFloat(String(a.hours));
    const work = requireStr(a, "work");
    const left = a.left !== undefined ? parseFloat(String(a.left)) : null;
    out = await client.submitEffort(taskId, date, hours, work, left, !!a["dry-run"]);
    if (out.submitted && a.session !== undefined) {
      out.recorded = recordSubmission(
        date,
        String(a.session),
        taskId,
        hours,
        a.minutes !== undefined ? parseInt(String(a.minutes), 10) : null,
      );
    }
  } else {
    die(`未知命令: ${cmd}`);
  }
  console.log(JSON.stringify(out, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
