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
import { parseTranscript, sumUsage } from "./transcript";
import { scanSessions, findTranscriptPathByScan, invalidateScanCache, type ScannedSession } from "./claude-scan";
import { getCommits } from "./git";
import { getSessionLines, sumLines } from "./lines";
import {
  buildHookCwdMap,
  groupScannedByCwd,
  buildProjectDetail,
  buildProjectSummary,
  decodeProjectCwd,
  rowToScannedSession,
  sumTokens,
} from "./aggregate";
import { readSettings, writeSettings } from "./settings";
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
  let lastReportAt = Date.now();
  setInterval(async () => {
    let url: string | null;
    let intervalMin: number;
    try {
      const s = readSettings();
      url = s.reportUrl ?? null;
      intervalMin = typeof s.reportIntervalMin === "number" ? s.reportIntervalMin : 0;
    } catch {
      return;
    }
    if (!url || !intervalMin || intervalMin <= 0) return;
    if (Date.now() - lastReportAt < intervalMin * 60_000) return;
    lastReportAt = Date.now();
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

  return Bun.serve({
    hostname: LISTEN_HOST,
    port: PORT,
    async fetch(req, server) {
      const url = new URL(req.url);
      const path = url.pathname;

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
          // 新会话可能新增 session 文件，清扫描缓存让下次轮询立即可见（其余事件靠 10s TTL 兜底，避免高频失效）
          if (event.type === "SessionStart") invalidateScanCache();
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
        const sessions: SessionSummary[] = scanSessions()
          .filter((sc) => since <= 0 || sc.lastActivity >= since)
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
          return json({ transcriptPath: tp, messages, tokenTotal: sumUsage(messages) });
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

      // 手动上报:构建报表并 POST 到 settings.reportUrl(与定时器同一逻辑)。
      if (path === "/api/report/upload" && req.method === "POST") {
        try {
          const r = await uploadReport(store);
          return json(r.uploaded ? { status: "ok" } : { status: "skipped", reason: r.reason });
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          return json({ error: msg }, 500);
        }
      }

      // 用户设置:GET 读、PUT 写(字段级合并)。目前只有 reportUrl(上报地址)。
      if (path === "/api/settings" && req.method === "GET") {
        return json(readSettings());
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
        writeSettings(cur);
        return json(cur);
      }

      if (path === "/api/shutdown" && req.method === "POST") {
        log.info("shutdown requested via api");
        setTimeout(() => deps.shutdown(), 50); // 先响应再退
        return json({ status: "shutting down" });
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
  // hook 未提供 transcript_path 时查 SQLite(消费者已发现);SQLite 也没有则扫描兜底
  return store.getTranscriptSession(sessionId)?.parent_path ?? findTranscriptPathByScan(sessionId);
}

/** 构建 /api/report:token 扫所有 transcript(ccusage 口径),按项目聚合。
 *  复用 aggregate(decodeProjectCwd/groupScannedByCwd/buildProjectDetail/sumTokens)保证与 /api/projects、/api/sessions?cwd= 同口径。
 *  同名项目消歧 + sort 是 /api/report 专属展示上报逻辑(L1 项目表不消歧,用 cwd 列区分)。 */
async function buildReport(store: Store, since: number): Promise<ReportResponse> {
  const hookCwd = buildHookCwdMap(store.sessions());
  const scanned = store.getTranscriptSessions({ since, limit: 10000 }).map(rowToScannedSession);
  const byCwd = groupScannedByCwd(scanned, hookCwd);

  const projects = await Promise.all(
    [...byCwd.entries()].map(([cwd, ss]) => buildProjectDetail(cwd, ss, store)),
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

  return {
    version: SERVICE_VERSION,
    generatedAt: Date.now(),
    since,
    gitUser: projects.find((p) => p.gitUser)?.gitUser ?? null,
    projects,
    totals: {
      projects: projects.length,
      sessions: scanned.length,
      tokens: sumTokens(projects.map((p) => p.totalTokens)),
      lines: sumLines(projects.map((p) => p.totalLines)),
    },
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
    if (s.cwd === cwd && !hookBySid.has(s.sessionId)) hookBySid.set(s.sessionId, s);
  }
  // 该 cwd 的 scanned sessions(真实 cwd:hookMap 优先,无则解码项目名),按 lastActive 倒序
  const all = store.getTranscriptSessions({ since, limit: 10000 })
    .map(rowToScannedSession)
    .filter((s) => (hookMap.get(s.sessionId)?.cwd ?? s.cwd ?? decodeProjectCwd(s.project)) === cwd)
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
type UploadOutcome = { uploaded: boolean; reason?: string };

/** 构建 report 并 POST 到 settings.reportUrl(自动/手动上报共用)。
 *  无 reportUrl,或采集不到 git user.name(上报身份缺失,tokenserver 只会落「未知用户」) 则跳过不报,返回原因由调用方记日志/回前端;失败抛错。 */
async function uploadReport(store: Store): Promise<UploadOutcome> {
  const s = readSettings();
  const url = s.reportUrl;
  if (!url) return { uploaded: false, reason: "reportUrl 未配置" };
  const report = await buildReport(store, 0);
  if (!report.gitUser) {
    return { uploaded: false, reason: "未采集到 git user.name,跳过上报(无上报身份)" };
  }
  await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", "content-encoding": "gzip" },
    body: gzipSync(Buffer.from(JSON.stringify(report), "utf8")),
    signal: AbortSignal.timeout(15000),
  });
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
