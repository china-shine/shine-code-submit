// HTTP/WS 路由与鉴权。组装 Bun.serve。
// 健康端点与静态页不鉴权；其余端点（事件接收、stats、events、sessions、ws、shutdown）需 token。
import type { ServerWebSocket } from "bun";
import { LISTEN_HOST, PORT, SERVICE_NAME, SERVICE_VERSION, LOG_TAIL_LINES, SESSION_TOKEN_ENRICH_LIMIT } from "../shared/config";
import type {
  HookEvent,
  HookEventType,
  PidFile,
  ReportProject,
  ReportResponse,
  ReportSession,
  ReportTotals,
  SessionSummary,
  TokenUsage,
} from "../shared/types";
import { deriveStableEventId } from "../shared/id";
import { checkToken } from "./auth";
import { parseTranscript, sumUsage } from "./transcript";
import { getSessionTokenTotal } from "./token-cache";
import { scanSessions, type ScannedSession } from "./claude-scan";
import { getCommits, getGitUser, getGitRemote } from "./git";
import { getSessionLines, sumLines } from "./lines";
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

      if (path === "/api/sessions" && req.method === "GET") {
        const sessions = store.sessions();
        // 仅对最近 N 个 session enrich tokenTotal（读 transcript 较重，走 mtime 缓存）；
        // 更老的留 undefined，避免每 2s 轮询时重读大量旧 transcript。
        for (let i = 0; i < Math.min(sessions.length, SESSION_TOKEN_ENRICH_LIMIT); i++) {
          const s = sessions[i];
          if (!s) continue;
          const tp = findTranscriptPath(store, s.sessionId);
          s.tokenTotal = tp ? getSessionTokenTotal(tp) : null;
        }
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
  return null;
}

/** 解码 Claude 项目目录名 → 真实 cwd：':' '\' '/' 都被编码成 '-'。
 *  Windows 盘符 C--… → C:\…（其余 - → \）；无盘符时原样返回（posix 情形，少見）。 */
function decodeProjectCwd(project: string): string {
  const m = /^([A-Za-z])--(.*)$/.exec(project);
  if (m && m[1] && m[2]) return `${m[1]}:\\${m[2].replace(/-/g, "\\")}`;
  return project;
}

/** 构建 /api/report：token 直接扫所有 transcript（ccusage 口径，与 `ccusage claude session` 的 totals 逐字段相等），
 *  按项目(projects/<project>)聚合；cwd/git/代码行数尽量按 sessionId 匹配 hook session 取真实值，匹配不上则解码项目名。
 *  窗口 since(ms，0=全部)；since>0 时按 session 文件 mtime(session 级)过滤。 */
async function buildReport(store: Store, since: number): Promise<ReportResponse> {
  // hook session 的 sessionId → 真实 cwd，用于给 scan session 补 cwd/git/行数
  const hookCwd = new Map<string, string>();
  for (const s of store.sessions()) {
    if (!hookCwd.has(s.sessionId)) hookCwd.set(s.sessionId, s.cwd);
  }

  // 扫描所有 transcript（ccusage 口径，含子代理），按 since 过滤
  const scanned = scanSessions().filter((s) => since <= 0 || s.lastActivity >= since);

  // 按编码项目名分组
  const byProject = new Map<string, ScannedSession[]>();
  for (const s of scanned) {
    const arr = byProject.get(s.project);
    if (arr) arr.push(s);
    else byProject.set(s.project, [s]);
  }

  const projects = await Promise.all(
    [...byProject.keys()].map(
      async (project): Promise<ReportProject> => {
        const ss = byProject.get(project) ?? [];
        // cwd：优先 hook 匹配的真实 cwd，否则解码项目名
        const cwd =
          ss.map((s) => hookCwd.get(s.sessionId)).find((c) => !!c) ?? decodeProjectCwd(project);
        const rs: ReportSession[] = ss.map((s) => ({
          sessionId: s.sessionId,
          lastActive: s.lastActivity,
          tokenTotal: s.tokenTotal,
          linesTotal: getSessionLines(store, s.sessionId, s.lastActivity),
        }));
        const totalTokens = sumTokens(rs.map((r) => r.tokenTotal));
        const totalLines = sumLines(rs.map((r) => r.linesTotal));

        const [gitUser, gitRemote] = await Promise.all([getGitUser(cwd), getGitRemote(cwd)]);

        return {
          cwd,
          name: shortName(cwd),
          gitUser,
          gitRemote,
          sessionCount: ss.length,
          sessions: rs,
          totalTokens,
          totalLines,
        };
      },
    ),
  );

  projects.sort(
    (a, b) =>
      b.sessionCount - a.sessionCount ||
      b.totalTokens.input + b.totalTokens.output - (a.totalTokens.input + a.totalTokens.output),
  );

  const totals: ReportTotals = {
    projects: projects.length,
    sessions: scanned.length,
    tokens: sumTokens(projects.map((p) => p.totalTokens)),
    lines: sumLines(projects.map((p) => p.totalLines)),
  };

  return {
    version: SERVICE_VERSION,
    generatedAt: Date.now(),
    since,
    gitUser: projects.find((p) => p.gitUser)?.gitUser ?? null,
    projects,
    totals,
  };
}

/** 累加若干 TokenUsage（可 null/undefined），返回合计。 */
function sumTokens(arr: (TokenUsage | null | undefined)[]): TokenUsage {
  const t: TokenUsage = { input: 0, output: 0, cacheCreation: 0, cacheRead: 0 };
  for (const u of arr) {
    if (u) {
      t.input += u.input;
      t.output += u.output;
      t.cacheCreation += u.cacheCreation;
      t.cacheRead += u.cacheRead;
    }
  }
  return t;
}

/** 路径取末段作项目名（服务端版，与 ui/lib/util.ts shortDir 一致）。 */
function shortName(p: string): string {
  if (!p) return "";
  const t = p.replace(/[\\/]+$/, "");
  const i = Math.max(t.lastIndexOf("/"), t.lastIndexOf("\\"));
  return i >= 0 ? t.slice(i + 1) : t;
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
    headers: { "content-type": "application/json" },
    body: JSON.stringify(report),
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
