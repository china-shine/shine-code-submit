// HTTP/WS 路由与鉴权。组装 Bun.serve。
// 健康端点与静态页不鉴权；其余端点（事件接收、stats、events、sessions、ws、shutdown）需 token。
import type { ServerWebSocket } from "bun";
import { LISTEN_HOST, PORT, SERVICE_NAME, SERVICE_VERSION, LOG_TAIL_LINES, SESSION_TOKEN_ENRICH_LIMIT } from "../shared/config";
import type {
  HookEvent,
  HookEventType,
  PidFile,
  ProjectSession,
  ProjectSessionsResponse,
  ProjectSummary,
  ProjectsResponse,
  ReportProject,
  ReportResponse,
  ReportSession,
  ReportTotals,
  SessionSummary,
  TokenUsage,
} from "../shared/types";
import { deriveStableEventId } from "../shared/id";
import { checkToken } from "./auth";
import { gzipSync } from "node:zlib";
import { parseTranscript, sumSessionUsage } from "./transcript";
// claude-scan 现 only export claudeProjectsRoots/collectJsonl/parentSessionInfo/ScannedSession(供 watcher/consumer/aggregate);scanSessions 系列已删(P3)
import { getCommits, getGitUser } from "./git";
import { collectWorklogs } from "./worklog";
import { getSessionLines, sumLines } from "./lines";
import {
  buildHookCwdMap,
  groupScannedByCwd,
  buildProjectDetail,
  buildProjectSummary,
  decodeProjectCwd,
  normCwd,
  rowToScannedSession,
  sumTokens,
} from "./aggregate";
import { readSettings, writeSettings } from "./settings";
import { DATA_DIR } from "../shared/paths";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { autoUpdateIfNeeded } from "../shared/updater";
import type { Store } from "./store";
import type { EventBus } from "./bus";
import type { Stats } from "./stats";
import type { Logger } from "./logger";

export interface ServerDeps {
  pid: PidFile;
  startedAt: number;
  store: Store;
  bus: EventBus;
  stats: Stats;
  log: Logger;
  serveUi: (req: Request, url: URL) => Response | Promise<Response>;
  onWsOpen?: (ws: ServerWebSocket<unknown>) => void;
  onWsClose?: (ws: ServerWebSocket<unknown>) => void;
  shutdown: () => void;
}

/** 读禅道缓存展示数据:cache.json 内容 + TTL 过期判断 + 禅道地址。仅读本地 JSON,不调禅道。
 *  供 dashboard「禅道」模块只读展示;expired 与 zentao.ts getCache 的过期口径一致(缺 fetchedAt 亦视为过期)。 */
function readZentaoCachePayload(): {
  cache: Record<string, unknown> | null;
  ttl: number | null;
  expired: boolean;
  zentaoUrl: string | null;
} {
  const ZENPILOT = join(DATA_DIR, "zenpilot");
  let cache: Record<string, unknown> | null = null;
  try {
    const p = join(ZENPILOT, "cache.json");
    if (existsSync(p)) cache = JSON.parse(readFileSync(p, "utf8")) as Record<string, unknown>;
  } catch {
    /* 损坏 → 视为无缓存 */
  }
  const ttl = readSettings().zentaoCacheTtlMin ?? null;
  let expired = false;
  if (cache && ttl && ttl > 0) {
    const fa = cache.fetchedAt;
    expired = typeof fa !== "string" || (Date.now() - new Date(fa).getTime()) / 60000 > ttl;
  }
  let zentaoUrl: string | null = null;
  try {
    const cp = join(ZENPILOT, "config.json");
    if (existsSync(cp)) {
      const cfg = JSON.parse(readFileSync(cp, "utf8")) as Record<string, unknown>;
      if (typeof cfg.url === "string") zentaoUrl = cfg.url.replace(/\/+$/, "");
    }
  } catch {
    /* ignore */
  }
  return { cache, ttl, expired, zentaoUrl };
}

/** 文件名 → {date, name}:日报-YYYY-MM-DD[-姓名].html / 周报-区间[-姓名].html;兼容旧格式(无姓名段)。 */
const REPORT_RE: Record<"daily" | "weekly", RegExp> = {
  daily: /^日报-(\d{4}-\d{2}-\d{2})(?:-(.+))?\.html$/,
  weekly: /^周报-(\d{4}-\d{2}-\d{2}~\d{4}-\d{2}-\d{2})(?:-(.+))?\.html$/,
};

/** 列 DATA_DIR/reports/ 下的日报/周报 HTML(由 /daily /weekly skill 生成)。提取纯日期/区间段 + 姓名;
 *  同日期多文件(新旧格式共存/多用户)取 mtime 最新。按日期倒序。 */
function listReports(kind: "daily" | "weekly"): { date: string; name: string; filename: string }[] {
  const dir = join(DATA_DIR, "reports");
  let files: string[] = [];
  try {
    files = readdirSync(dir);
  } catch {
    return [];
  }
  const re = REPORT_RE[kind];
  const latest = new Map<string, { name: string; filename: string; mtime: number }>();
  for (const f of files) {
    const m = f.match(re);
    if (!m) continue;
    const date = m[1]!;
    const name = m[2] ?? "";
    let mtime = 0;
    try { mtime = statSync(join(dir, f)).mtimeMs; } catch {}
    const prev = latest.get(date);
    if (!prev || mtime >= prev.mtime) latest.set(date, { name, filename: f, mtime });
  }
  return [...latest.entries()]
    .map(([date, v]) => ({ date, name: v.name, filename: v.filename }))
    .sort((a, b) => b.date.localeCompare(a.date));
}

/** 按 date/区间段定位实际文件(前缀 + 可选 -姓名);多个取 mtime 最新,无则 null。
 *  daemon 不知 realname,靠 date 段模糊匹配兼容新旧格式。dateKey 仅允许日期/区间字符(防穿越)。 */
function findReportFile(kind: "daily" | "weekly", dateKey: string | undefined): string | null {
  if (!dateKey || !/^[\d~-]+$/.test(dateKey)) return null;
  const dir = join(DATA_DIR, "reports");
  let files: string[] = [];
  try {
    files = readdirSync(dir);
  } catch {
    return null;
  }
  const prefix = kind === "daily" ? "日报-" : "周报-";
  const re = new RegExp(`^${prefix}${dateKey}(?:-.+)?\\.html$`); // (?:-.+)? 姓名段可选:兼容无姓名旧格式,否则旧报表 DELETE 永远 404
  let best: { f: string; mtime: number } | null = null;
  for (const f of files) {
    if (!re.test(f)) continue;
    let mtime = 0;
    try { mtime = statSync(join(dir, f)).mtimeMs; } catch {}
    if (!best || mtime >= best.mtime) best = { f, mtime };
  }
  return best?.f ?? null;
}

/** 删除某 date/区间段的【所有】匹配报表文件(新旧格式共存一次删净)。返回删除数。
 *  listReports 按 date 去重只展示 mtime 最新一个;DELETE 该 date 应清掉同 date 全部文件,
 *  否则删一个浮现一个、用户得删多次(日报频繁生成新旧共存尤甚)。 */
function deleteReportFiles(kind: "daily" | "weekly", dateKey: string | undefined): number {
  if (!dateKey || !/^[\d~-]+$/.test(dateKey)) return 0;
  const dir = join(DATA_DIR, "reports");
  let files: string[] = [];
  try { files = readdirSync(dir); } catch { return 0; }
  const prefix = kind === "daily" ? "日报-" : "周报-";
  const re = new RegExp(`^${prefix}${dateKey}(?:-.+)?[.]html$`);
  let n = 0;
  for (const f of files) {
    if (!re.test(f)) continue;
    try { unlinkSync(join(dir, f)); n++; } catch {}
  }
  return n;
}

/** 读单个报表 HTML(按文件名),不存在返回 null。 */
function readReportHtml(filename: string): string | null {
  try {
    return readFileSync(join(DATA_DIR, "reports", filename), "utf8");
  } catch {
    return null;
  }
}

/** 触发禅道缓存刷新:spawn `bun zentao.ts refresh`(禅道登录/拉取逻辑全在 skill 层 zentao.ts,daemon 只触发)。
 *  超时 120s;返回刷新结果或错误(如 config.json 未配禅道账号)。
 *  in-flight 锁:手动按钮与后台 cacheTick 并发触发时跳过第二个——两个 refresh 并发写 cache.json/efforts/
 *  (非原子 writeFileSync)会交错出半截 JSON,读方(loadJSON 无容错)直接崩。 */
let zentaoRefreshInFlight = false;
async function refreshZentaoCache(): Promise<
  | { ok: true; projects: number; tasks: number; executions: number; fetchedAt: string }
  | { ok: false; error: string }
> {
  if (zentaoRefreshInFlight) return { ok: false, error: "刷新进行中(上一轮未完成),已跳过并发触发" };
  zentaoRefreshInFlight = true;
  try {
    return await refreshZentaoCacheInner();
  } finally {
    zentaoRefreshInFlight = false;
  }
}

async function refreshZentaoCacheInner(): Promise<
  | { ok: true; projects: number; tasks: number; executions: number; fetchedAt: string }
  | { ok: false; error: string }
> {
  const zentaoTs = join(
    dirname(fileURLToPath(new URL(import.meta.url))),
    "..",
    "..",
    "skills",
    "report",
    "scripts",
    "zentao.ts",
  );
  if (!existsSync(zentaoTs)) return { ok: false, error: `zentao.ts 未找到: ${zentaoTs}` };
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn({
      cmd: [process.execPath, "run", zentaoTs, "refresh"],
      stdout: "pipe",
      stderr: "pipe",
    });
  } catch (e) {
    return { ok: false, error: `启动失败: ${e instanceof Error ? e.message : String(e)}` };
  }
  const timer = setTimeout(() => {
    try {
      proc.kill();
    } catch {
      /* ignore */
    }
  }, 120_000);
  let exitCode: number | null;
  try {
    exitCode = await proc.exited;
  } finally {
    clearTimeout(timer);
  }
  const stdout = await new Response(proc.stdout as ReadableStream<Uint8Array>).text();
  if (exitCode !== 0) {
    const stderr = await new Response(proc.stderr as ReadableStream<Uint8Array>).text();
    return { ok: false, error: (stderr || stdout).slice(0, 300) || `exit ${exitCode}` };
  }
  try {
    const parsed = JSON.parse(stdout) as {
      projects?: number;
      tasks?: number;
      executions?: number;
      fetchedAt?: string;
    };
    return {
      ok: true,
      projects: parsed.projects ?? 0,
      tasks: parsed.tasks ?? 0,
      executions: parsed.executions ?? 0,
      fetchedAt: parsed.fetchedAt ?? "",
    };
  } catch {
    return { ok: false, error: `输出解析失败: ${stdout.slice(0, 200)}` };
  }
}

export function startServer(deps: ServerDeps) {
  const { pid, store, bus, stats, log } = deps;

  const authed = (req: Request) => checkToken(req.headers.get("authorization"), pid);

  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json; charset=utf-8" },
    });

  // 自动上报:每分钟 tick;配置了 reportUrl + reportIntervalMin(>0) 且到点,则上报一次。
  // 配置实时读 settings,改 URL/间隔不用重启即生效。
  setInterval(async () => {
    let url: string | null;
    let intervalMin: number;
    let lastReportAt: number;
    try {
      const s = readSettings();
      url = s.reportUrl ?? null;
      intervalMin = typeof s.reportIntervalMin === "number" ? s.reportIntervalMin : 0;
      lastReportAt = s.lastReportAt ?? 0; // 持久化水位(替代内存变量,重启不重置)
    } catch {
      return;
    }
    if (!url || !intervalMin || intervalMin <= 0) return;
    if (Date.now() - lastReportAt < intervalMin * 60_000) return;
    try {
      const r = await uploadReport(store);
      log.info(r.uploaded ? `auto report uploaded to ${url}` : `auto report skipped: ${r.reason}`);
    } catch (e) {
      log.info(`auto report upload failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }, 60_000);

  // 自动更新:启动时检测一次 + 每 autoUpdateIntervalMin 分钟复查(每分钟 tick 节流,配置实时读 settings)。
  // 用户开 Claude → hook 拉起 daemon → daemon 启动检测 → 有新版 spawn npx install(1.0.5 自动重启接管)。
  let lastUpdateAt = 0;
  const updateTick = async (): Promise<void> => {
    let intervalMin: number;
    try {
      const s = readSettings();
      if (s.autoUpdate === false) return;
      intervalMin = typeof s.autoUpdateIntervalMin === "number" ? s.autoUpdateIntervalMin : 60;
    } catch {
      return;
    }
    if (!intervalMin || intervalMin <= 0) return;
    if (Date.now() - lastUpdateAt < intervalMin * 60_000) return;
    lastUpdateAt = Date.now();
    try {
      const r = await autoUpdateIfNeeded();
      if (r.updated) log.info(`auto update: new version ${r.latest} available, spawning npx install`);
    } catch (e) {
      log.info(`auto update check failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  };
  void updateTick(); // 启动即检测一次(覆盖"每次打开 Claude")
  setInterval(updateTick, 60_000);

  // 禅道缓存后台定时刷新:把 cache.json 从"懒触发"(访问 plan/daily 才刷)变成"后台主动定时刷",
  // 保证 commit 读 cache 的 task.left 不太旧(读缓存省 GET 的前提)。zentaoCacheTtlMin 控制间隔(默认 300min);
  // 启动时不立即跑(避免和 report/update tick 抢启动期资源,懒 TTL 兜底)。
  let lastCacheRefreshAt = 0;
  const cacheTick = async (): Promise<void> => {
    let intervalMin: number;
    try {
      intervalMin = readSettings().zentaoCacheTtlMin ?? 0;
    } catch {
      return;
    }
    if (!intervalMin || intervalMin <= 0) return;
    if (Date.now() - lastCacheRefreshAt < intervalMin * 60_000) return;
    lastCacheRefreshAt = Date.now();
    try {
      const r: any = await refreshZentaoCache();
      if (r?.ok) log.info(`zentao cache refreshed: ${r.tasks ?? 0} tasks`);
    } catch (e) {
      log.info(`zentao cache refresh failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  };
  setInterval(cacheTick, 60_000);

  return Bun.serve({
    hostname: LISTEN_HOST,
    port: PORT,
    async fetch(req, server) {
      const url = new URL(req.url);
      const path = url.pathname;

      // favicon.ico:浏览器自动请求标签页图标,无图标 → 204(无鉴权,避免控制台 401 噪音)
      if (path === "/favicon.ico") {
        return new Response(null, { status: 204 });
      }

      // ---- health（无鉴权）：Hook「认自己人」用 ----
      if (path === "/api/health" && req.method === "GET") {
        return json({
          service: SERVICE_NAME,
          version: SERVICE_VERSION,
          pid: pid.pid,
          uptime: Date.now() - deps.startedAt,
        });
      }

      // ---- 静态页（无鉴权；数据接口仍鉴权）----
      if (path === "/" || path === "/ui" || path.startsWith("/ui/")) {
        return await deps.serveUi(req, url);
      }

      // ---- WS 升级（鉴权；浏览器无法设 header，故支持 ?t= 查询参数）----
      if (path === "/api/ws" && req.method === "GET") {
        const q = url.searchParams.get("t");
        const authHeader = q ? `Bearer ${q}` : req.headers.get("authorization");
        if (!checkToken(authHeader, pid)) return json({ error: "unauthorized" }, 401);
        if (server.upgrade(req, { data: { tokenOk: true } })) {
          return new Response(null, { status: 101 });
        }
        return json({ error: "upgrade failed" }, 400);
      }

      // ---- reports 静态预览(?t= query 鉴权,供 dashboard 新窗口直接打开 HTTP URL,免 blob) ----
      const rd = path.match(/^\/reports\/daily\/(\d{4}-\d{2}-\d{2})$/);
      if (rd && req.method === "GET") {
        const q = url.searchParams.get("t");
        if (!q || !checkToken(`Bearer ${q}`, pid)) return json({ error: "unauthorized" }, 401);
        const fn = findReportFile("daily", rd[1]);
        const html = fn ? readReportHtml(fn) : null;
        if (!html) return json({ error: "not found" }, 404);
        return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
      }
      const rw = path.match(/^\/reports\/weekly\/(\d{4}-\d{2}-\d{2}~\d{4}-\d{2}-\d{2})$/);
      if (rw && req.method === "GET") {
        const q = url.searchParams.get("t");
        if (!q || !checkToken(`Bearer ${q}`, pid)) return json({ error: "unauthorized" }, 401);
        const fn = findReportFile("weekly", rw[1]);
        const html = fn ? readReportHtml(fn) : null;
        if (!html) return json({ error: "not found" }, 404);
        return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
      }

      // ---- 以下均需鉴权 ----
      if (!authed(req)) return json({ error: "unauthorized" }, 401);

      // 事件接收（热路径）
      const m = path.match(/^\/api\/hook\/(\w+)$/);
      if (m && req.method === "POST") {
        const type = m[1] as HookEventType;
        let body: unknown;
        try {
          body = await req.json();
        } catch {
          return json({ error: "bad json" }, 400);
        }
        const event = normalizeEvent(type, body);
        if (!event) return json({ error: "missing required fields (cwd, sessionId)" }, 400);
        const inserted = store.insert(event);
        if (inserted) {
          bus.emit(event);
          stats.recordEvent();
          log.info(`ingest http ${event.type}`);
        }
        return json({ status: "ok", inserted, version: SERVICE_VERSION });
      }

      if (path === "/api/stats" && req.method === "GET") {
        return json({
          service: SERVICE_NAME,
          version: SERVICE_VERSION,
          pid: pid.pid,
          uptime: Date.now() - deps.startedAt,
          spoolBacklog: stats.backlog(),
          eventsPerSec: stats.rate(),
          totalEvents: store.count(),
          lastError: stats.lastError,
          logTail: log.tail(LOG_TAIL_LINES),
        });
      }

      if (path === "/api/events" && req.method === "GET") {
        const sp = url.searchParams;
        return json({
          events: store.query({
            cwd: sp.get("cwd") ?? undefined,
            sessionId: sp.get("sessionId") ?? undefined,
            type: sp.get("type") ?? undefined,
            since: num(sp.get("since")),
            limit: num(sp.get("limit")) ?? 200,
          }),
        });
      }

      // L1 项目列表(分页,会话/报表模块首屏用):项目汇总 + 全局 totals,无 sessions 明细。
      if (path === "/api/projects" && req.method === "GET") {
        const since = num(url.searchParams.get("since")) ?? 0;
        const page = Math.max(1, parseInt(url.searchParams.get("page") ?? "1", 10) || 1);
        const pageSize = Math.max(1, parseInt(url.searchParams.get("pageSize") ?? "50", 10) || 50);
        return json(await getProjects(store, since, page, pageSize));
      }

      if (path === "/api/sessions" && req.method === "GET") {
        const since = num(url.searchParams.get("since")) ?? 0;
        const cwdParam = url.searchParams.get("cwd");
        // L2: ?cwd=<path> → 该项目 session 列表(富化 title/activeMs/linesTotal + 服务端分页)
        if (cwdParam) {
          const page = Math.max(1, parseInt(url.searchParams.get("page") ?? "1", 10) || 1);
          const pageSize = Math.max(
            1,
            Math.min(
              parseInt(url.searchParams.get("pageSize") ?? String(SESSION_TOKEN_ENRICH_LIMIT), 10) || SESSION_TOKEN_ENRICH_LIMIT,
              2000,
            ),
          );
          return json(await getProjectSessions(store, cwdParam, since, page, pageSize));
        }
        // 旧行为(无 cwd):全量 SessionSummary[],P3 前端不再用,保留向后兼容。
        const hookMap = buildHookCwdMap(store.sessions());
        const sessions: SessionSummary[] = store.getTranscriptSessions({ since, limit: 10000 })
          .map(rowToScannedSession)
          .map((sc) => {
            const h = hookMap.get(sc.sessionId);
            return {
              sessionId: sc.sessionId,
              cwd: h?.cwd ?? sc.cwd ?? decodeProjectCwd(sc.project),
              lastActive: Math.max(sc.lastActivity, h?.lastActive ?? 0),
              eventCount: h?.eventCount ?? 0,
              lastType: h?.lastType ?? null,
              tokenTotal: sc.tokenTotal,
            };
          });
        sessions.sort((a, b) => b.lastActive - a.lastActive);
        return json({ sessions });
      }

      // 对话视图：从该 session 任一事件的 payload.transcript_path 读完整 transcript
      if (path === "/api/transcript" && req.method === "GET") {
        const sessionId = url.searchParams.get("sessionId");
        if (!sessionId) return json({ error: "missing sessionId" }, 400);
        const tp = findTranscriptPath(store, sessionId);
        if (!tp) return json({ error: "no transcript_path found for session" }, 404);
        try {
          const messages = parseTranscript(tp);
          // tokenTotal 走 sumSessionUsage(父 + subagents/*.jsonl,ccusage 去重),与会话列表/报表/SQLite 同口径;
          // 不能用 sumUsage(messages)——它只读父文件、不去重、不过滤,用了 subagent 的会话会少算、重放行会多算。
          return json({ transcriptPath: tp, messages, tokenTotal: sumSessionUsage(tp) });
        } catch (err) {
          return json({ error: "read transcript failed", detail: String(err) }, 500);
        }
      }

      // 提交视图：在某 cwd 跑 git log 取最近提交 + 行数（容错，非 git 目录返回空 + error）
      if (path === "/api/commits" && req.method === "GET") {
        const cwd = url.searchParams.get("cwd");
        if (!cwd) return json({ error: "missing cwd" }, 400);
        const limit = num(url.searchParams.get("limit")) ?? 200;
        return json(await getCommits(cwd, limit));
      }

      // 数据上报页：跨项目聚合（会话/token/提交/git 用户/版本），供查看页「数据上报」模块展示。
      // since=0 表示全部；按项目(cwd)汇总每会话 token + 提交次数/行数/时间。
      if (path === "/api/report" && req.method === "GET") {
        const since = num(url.searchParams.get("since")) ?? 0;
        return json(await buildReport(store, since));
      }

      // 禅道配置(读/写 DATA_DIR/zenpilot/config.json,与 setup 同位置)
      if (path === "/api/zentao-config" && req.method === "GET") {
        const cp = join(DATA_DIR, "zenpilot", "config.json");
        try {
          const cfg = JSON.parse(readFileSync(cp, "utf8"));
          return json({ url: cfg.url ?? "", account: cfg.account ?? "", hasPassword: !!cfg.password, projectIds: cfg.projectIds ?? [] });
        } catch {
          return json({ url: "", account: "", hasPassword: false, projectIds: [] });
        }
      }
      if (path === "/api/zentao-config" && req.method === "PUT") {
        const cp = join(DATA_DIR, "zenpilot", "config.json");
        const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
        const cur = existsSync(cp) ? (JSON.parse(readFileSync(cp, "utf8")) as Record<string, unknown>) : {};
        if (typeof body.url === "string") cur.url = body.url.replace(/\/+$/, "");
        if (typeof body.account === "string") cur.account = body.account;
        if (typeof body.password === "string" && body.password) cur.password = body.password; // 非空才更新(留空=不改)
        mkdirSync(dirname(cp), { recursive: true });
        writeFileSync(cp, JSON.stringify(cur, null, 2) + "\n", "utf8");
        return json({ ok: true, url: cur.url, account: cur.account, hasPassword: !!cur.password });
      }

      // 手动上报:构建报表并 POST 到 settings.reportUrl(与定时器同一逻辑)。
      if (path === "/api/report/upload" && req.method === "POST") {
        try {
          const full = url.searchParams.get("full") === "1";
          const r = await uploadReport(store, { full });
          return json(r.uploaded ? { status: "ok", full } : { status: "skipped", reason: r.reason });
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          return json({ error: msg }, 500);
        }
      }

      // 用户设置:GET 读、PUT 写(字段级合并)。目前只有 reportUrl(上报地址)。
      if (path === "/api/settings" && req.method === "GET") {
        return json(readSettings());
      }
      // 手动检查更新:force(不受 autoUpdate 开关限制)。有新版 → spawn npx install(VBS 隐藏,daemon 自动重启);无新版 → updated:false。
      if (path === "/api/update" && req.method === "POST") {
        const r = await autoUpdateIfNeeded(true);
        return json({ updated: r.updated, latest: r.latest ?? null, current: SERVICE_VERSION });
      }
      // 禅道缓存只读展示:cache.json + TTL 过期判断 + 禅道地址(daemon 不调禅道,仅读本地 JSON)。
      if (path === "/api/zentao-cache" && req.method === "GET") {
        return json(readZentaoCachePayload());
      }
      // 手动触发禅道刷新:spawn zentao.ts refresh(登录禅道重拉,慢;禅道逻辑在 skill 层)。
      if (path === "/api/zentao-cache/refresh" && req.method === "POST") {
        return json(await refreshZentaoCache());
      }
      if (path === "/api/settings" && req.method === "PUT") {
        let body: unknown;
        try {
          body = await req.json();
        } catch {
          return json({ error: "bad json" }, 400);
        }
        const cur = readSettings();
        const b = (body ?? {}) as Record<string, unknown>;
        if (typeof b.reportUrl === "string") cur.reportUrl = b.reportUrl.trim() || null;
        if (typeof b.reportIntervalMin === "number") {
          cur.reportIntervalMin = Number.isFinite(b.reportIntervalMin) && b.reportIntervalMin > 0
            ? Math.floor(b.reportIntervalMin)
            : null;
        }
        if (typeof b.autoUpdate === "boolean") cur.autoUpdate = b.autoUpdate;
        if (typeof b.autoUpdateIntervalMin === "number") {
          cur.autoUpdateIntervalMin = Number.isFinite(b.autoUpdateIntervalMin) && b.autoUpdateIntervalMin > 0
            ? Math.floor(b.autoUpdateIntervalMin)
            : null;
        }
        if (typeof b.zentaoCacheTtlMin === "number") {
          cur.zentaoCacheTtlMin = Number.isFinite(b.zentaoCacheTtlMin) && b.zentaoCacheTtlMin > 0
            ? Math.floor(b.zentaoCacheTtlMin)
            : null;
        }
        if (b.aiSubmitMark && typeof b.aiSubmitMark === "object") {
          const m = b.aiSubmitMark as { enabled?: unknown; text?: unknown };
          cur.aiSubmitMark = {
            enabled: typeof m.enabled === "boolean" ? m.enabled : true,
            text: typeof m.text === "string" && m.text ? m.text.trim() : null,
          };
        }
        writeSettings(cur);
        return json(cur);
      }

      if (path === "/api/shutdown" && req.method === "POST") {
        log.info("shutdown requested via api");
        setTimeout(() => deps.shutdown(), 50); // 先响应再退
        return json({ status: "shutting down" });
      }

      // 日报/周报 HTML 报表(由 /daily /weekly skill 生成到 DATA_DIR/reports/,dashboard 日报/周报模块消费)
      if (path === "/api/reports/daily" && req.method === "GET") {
        return json(listReports("daily"));
      }
      if (path === "/api/reports/weekly" && req.method === "GET") {
        return json(listReports("weekly"));
      }
      const dm = path.match(/^\/api\/reports\/daily\/(\d{4}-\d{2}-\d{2})$/);
      if (dm && req.method === "GET") {
        const fn = findReportFile("daily", dm[1]);
        const html = fn ? readReportHtml(fn) : null;
        if (!html) return json({ error: "not found" }, 404);
        return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
      }
      const wm = path.match(/^\/api\/reports\/weekly\/(\d{4}-\d{2}-\d{2}~\d{4}-\d{2}-\d{2})$/);
      if (wm && req.method === "GET") {
        const fn = findReportFile("weekly", wm[1]);
        const html = fn ? readReportHtml(fn) : null;
        if (!html) return json({ error: "not found" }, 404);
        return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
      }
      // DELETE 日报/周报(按 date 段定位实际文件再删,兼容带/不带姓名段)
      const dmDel = path.match(/^\/api\/reports\/daily\/(\d{4}-\d{2}-\d{2})$/);
      if (dmDel && req.method === "DELETE") {
        const n = deleteReportFiles("daily", dmDel[1]);
        return n > 0 ? json({ ok: true, deleted: n }) : json({ error: "not found" }, 404);
      }
      const wmDel = path.match(/^\/api\/reports\/weekly\/(\d{4}-\d{2}-\d{2}~\d{4}-\d{2}-\d{2})$/);
      if (wmDel && req.method === "DELETE") {
        const n = deleteReportFiles("weekly", wmDel[1]);
        return n > 0 ? json({ ok: true, deleted: n }) : json({ error: "not found" }, 404);
      }

      return json({ error: "not found" }, 404);
    },
    websocket: {
      open: (ws: ServerWebSocket<unknown>) => deps.onWsOpen?.(ws),
      message: () => {
        /* 查看页不发消息 */
      },
      close: (ws: ServerWebSocket<unknown>) => deps.onWsClose?.(ws),
    },
  });
}

function num(v: string | null): number | undefined {
  if (v == null) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

/** 从某 session 的事件 payload 里找 transcript_path（取最近 50 条里第一个带值的）。 */
function findTranscriptPath(store: Store, sessionId: string): string | null {
  for (const e of store.query({ sessionId, limit: 50 })) {
    const p = e.payload as Record<string, unknown> | null;
    if (p && typeof p.transcript_path === "string") return p.transcript_path;
  }
  // hook 未提供 transcript_path 时查 SQLite(消费者已发现);冷启动消费者未跑完 fullScanBackstop 时可能 null,前端重试即可
  return store.getTranscriptSession(sessionId)?.parent_path ?? null;
}

/** 构建 /api/report:token 扫所有 transcript(ccusage 口径),按项目聚合。
 *  复用 aggregate(decodeProjectCwd/groupScannedByCwd/buildProjectDetail/sumTokens)保证与 /api/projects、/api/sessions?cwd= 同口径。
 *  同名项目消歧 + sort 是 /api/report 专属展示上报逻辑(L1 项目表不消歧,用 cwd 列区分)。 */
async function buildReport(store: Store, since: number): Promise<ReportResponse> {
  const hookCwd = buildHookCwdMap(store.sessions());
  const scanned = store.getTranscriptSessions({ since, limit: 10000 }).map(rowToScannedSession);
  const byCwd = groupScannedByCwd(scanned, hookCwd);

  const projects = await Promise.all(
    [...byCwd.entries()].map(([cwd, ss]) => buildProjectDetail(cwd, ss, store, since)),
  );

  // 同名项目消歧：用「父目录/项目名」区分（如两个 test → workspace/test、ai/test）
  const nameCount: Record<string, number> = {};
  for (const p of projects) nameCount[p.name] = (nameCount[p.name] ?? 0) + 1;
  for (const p of projects) {
    if ((nameCount[p.name] ?? 0) > 1) {
      const segs = p.cwd.split(/[\\/]+/).filter(Boolean);
      const prev = segs[segs.length - 2];
      if (prev) p.name = `${prev}/${p.name}`;
    }
  }

  projects.sort(
    (a, b) =>
      b.sessionCount - a.sessionCount ||
      b.totalTokens.input + b.totalTokens.output - (a.totalTokens.input + a.totalTokens.output),
  );

  // gitUser:增量(since>0)时 projects 只含变化项目,可能无 gitUser 项目 → 从全量 scanned 任一 cwd 补取
  // (getGitUser 读全局 user.name,任何 cwd 都行;全量 since=0 时 scanned 已全量,不重复查)
  let gitUser = projects.find((p) => p.gitUser)?.gitUser ?? null;
  if (!gitUser) {
    const allForGit = since > 0 ? store.getTranscriptSessions({ limit: 10000 }).map(rowToScannedSession) : scanned;
    for (const s of allForGit) {
      const cwd = hookCwd.get(s.sessionId)?.cwd ?? s.cwd ?? decodeProjectCwd(s.project);
      if (cwd) {
        gitUser = await getGitUser(cwd);
        if (gitUser) break;
      }
    }
  }
  const worklogs = collectWorklogs();
  return {
    version: SERVICE_VERSION,
    generatedAt: Date.now(),
    since,
    gitUser,
    projects,
    totals: {
      projects: projects.length,
      sessions: scanned.length,
      tokens: sumTokens(projects.map((p) => p.totalTokens)),
      lines: sumLines(projects.map((p) => p.totalLines)),
    },
    worklogs,
  };
}

/** L1 /api/projects:项目汇总(无 sessions 明细)+ 全局 totals,服务端分页。
 *  项目数通常几十,先全算再 slice(totals 需全量);git/lines 走缓存,稳态快。 */
async function getProjects(store: Store, since: number, page: number, pageSize: number): Promise<ProjectsResponse> {
  const hookCwd = buildHookCwdMap(store.sessions());
  const scanned = store.getTranscriptSessions({ since, limit: 10000 }).map(rowToScannedSession);
  const byCwd = groupScannedByCwd(scanned, hookCwd);

  const all = await Promise.all(
    [...byCwd.entries()].map(([cwd, ss]) => buildProjectSummary(cwd, ss, store)),
  );
  all.sort(
    (a, b) =>
      b.sessionCount - a.sessionCount ||
      b.totalTokens.input + b.totalTokens.output - (a.totalTokens.input + a.totalTokens.output),
  );

  const total = all.length;
  const start = (page - 1) * pageSize;
  const projects = all.slice(start, start + pageSize);

  return {
    version: SERVICE_VERSION,
    generatedAt: Date.now(),
    since,
    gitUser: all.find((p) => p.gitUser)?.gitUser ?? null,
    totals: {
      projects: total,
      sessions: scanned.length,
      tokens: sumTokens(all.map((p) => p.totalTokens)),
      lines: sumLines(all.map((p) => p.totalLines)),
    },
    projects,
    page,
    pageSize,
    total,
  };
}

/** L2 /api/sessions?cwd=:该项目 session 列表(富化 title/activeMs/linesTotal),服务端分页。
 *  totalTokens/totalLines/sessionCount 为该项目全量汇总(与 /api/report 同项目逐字段相等,供校验)。 */
async function getProjectSessions(
  store: Store,
  cwd: string,
  since: number,
  page: number,
  pageSize: number,
): Promise<ProjectSessionsResponse> {
  const hookMap = buildHookCwdMap(store.sessions());
  // 该 cwd 的 hook sessions(per sessionId 取首个=最新),补 eventCount/lastType
  const hookBySid = new Map<string, SessionSummary>();
  for (const s of store.sessions()) {
    if (normCwd(s.cwd) === normCwd(cwd) && !hookBySid.has(s.sessionId)) hookBySid.set(s.sessionId, s);
  }
  // 该 cwd 的 scanned sessions(真实 cwd:hookMap 优先,无则解码项目名),按 lastActive 倒序
  const all = store.getTranscriptSessions({ since, limit: 10000 })
    .map(rowToScannedSession)
    .filter((s) => normCwd(hookMap.get(s.sessionId)?.cwd ?? s.cwd ?? decodeProjectCwd(s.project)) === normCwd(cwd))
    .sort((a, b) => b.lastActivity - a.lastActivity);

  const total = all.length;
  const start = (page - 1) * pageSize;
  const pageItems = all.slice(start, start + pageSize);
  const sessions: ProjectSession[] = pageItems.map((sc) => {
    const h = hookBySid.get(sc.sessionId);
    return {
      sessionId: sc.sessionId,
      cwd,
      lastActive: Math.max(sc.lastActivity, h?.lastActive ?? 0),
      eventCount: h?.eventCount ?? 0,
      lastType: h?.lastType ?? null,
      tokenTotal: sc.tokenTotal,
      title: sc.title,
      activeMs: sc.activeMs,
      linesTotal: getSessionLines(store, sc.sessionId, sc.lastActivity),
    };
  });

  return {
    cwd,
    sessions,
    totalTokens: sumTokens(all.map((s) => s.tokenTotal)),
    totalLines: sumLines(all.map((s) => getSessionLines(store, s.sessionId, s.lastActivity))),
    sessionCount: total,
    page,
    pageSize,
    total,
  };
}

/** 上报结果:uploaded=true 已 POST;false=主动跳过(附 reason);抛错=网络/服务端失败。 */
type UploadOutcome = { uploaded: boolean; reason?: string; status?: number };

/** 构建 report 并 POST 到 settings.reportUrl(自动/手动上报共用)。
 *  无 reportUrl,或采集不到 git user.name(上报身份缺失,tokenserver 只会落「未知用户」) 则跳过不报,返回原因由调用方记日志/回前端;失败抛错。 */
async function uploadReport(store: Store, opts?: { full?: boolean }): Promise<UploadOutcome> {
  const s = readSettings();
  const url = s.reportUrl;
  if (!url) return { uploaded: false, reason: "reportUrl 未配置" };
  // 全量条件:手动(opts.full) 或 定期校准(距上次全量 > 24h,防 tokenserver 数据漂移/丢失后不自愈)
  const FULL_REPORT_INTERVAL = 24 * 60 * 60 * 1000;
  const dueFull = opts?.full || Date.now() - (s.lastFullReportAt ?? 0) >= FULL_REPORT_INTERVAL;
  const since = dueFull ? 0 : (s.lastReportAt ?? 0);
  const report = await buildReport(store, since);
  if (!report.gitUser) {
    return { uploaded: false, reason: "未采集到 git user.name,跳过上报(无上报身份)" };
  }
  // 增量无变化:跳过但推进水位(避免每 tick 重查);全量不走此分支
  if (!dueFull && since > 0 && report.projects.length === 0) {
    writeSettings({ ...readSettings(), lastReportAt: Date.now() });
    return { uploaded: false, reason: "增量无变化" };
  }
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", "content-encoding": "gzip" },
    body: gzipSync(Buffer.from(JSON.stringify(report), "utf8")),
    signal: AbortSignal.timeout(60000),
  });
  // fetch 对 4xx/5xx 不抛错:不检查 res.ok 会在失败时也推水位,该增量数据永久丢失(等 24h 全量才补)
  if (!res.ok) {
    return { uploaded: false, reason: `tokenserver HTTP ${res.status}`, status: res.status };
  }
  // 成功推进水位:增量水位总推进;全量额外推进 lastFullReportAt(定期校准锚点)
  const cur = readSettings();
  const patch: { lastReportAt: number; lastFullReportAt?: number } = { lastReportAt: Date.now() };
  if (dueFull) patch.lastFullReportAt = Date.now();
  writeSettings({ ...cur, ...patch });
  return { uploaded: true };
}

function normalizeEvent(type: HookEventType, body: unknown): HookEvent | null {
  if (typeof body !== "object" || body === null) return null;
  const b = body as Record<string, unknown>;
  const cwd = typeof b.cwd === "string" ? b.cwd : "";
  const sessionId = typeof b.sessionId === "string" ? b.sessionId : "";
  if (!cwd || !sessionId) return null;
  const payload = "payload" in b ? b.payload : b;
  return {
    eventId: deriveStableEventId({ type, sessionId, payload }), // 内容派生，保证多路采集幂等
    type,
    timestamp: typeof b.timestamp === "number" ? b.timestamp : Date.now(),
    cwd,
    sessionId,
    pid: typeof b.pid === "number" ? b.pid : 0,
    payload,
  };
}
