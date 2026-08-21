// tokenserver 全功能 HTTP 测试:首次为 tokenserver 建立测试覆盖。
//
// 覆盖范围(与 server.ts/store.ts 功能一一对应):
//   - /api/health 探活(鉴权豁免)
//   - POST /api/report:HMac 验签(x-report-ts 13位毫秒 / x-report-sig hex,±15min 窗口,
//     先验签再解压,坏 JSON 400、缺 projects 400、gzip 传输、幂等 upsert、linesTotal null → COALESCE 保留旧值)
//   - viewToken 鉴权(GET /api/* 除 health/report 必须 ?t= 或 Bearer;未配则开放)
//   - /api/stats 全局聚合(totals/trend/daily/composition/tokenRank/codeRank/sizeBuckets/members+version)
//   - /api/denominator-breakdown(AI 占比分母构成;host 白名单过滤)
//   - /api/sessions 分页(token>0 过滤,{rows,total,page,pageSize},row.name=cwd basename)
//   - /api/member/:gitUser 与 /api/member/:gitUser/worklog(分页 + totalHours + date 范围过滤)
//   - 静态资源 / 与 /docs(开放,text/html)
//   - 配置热更新(改 config.json 即时生效:删 viewToken 开放读接口 / 删 reportSecret 放行上报)
//
// 数据隔离:TOKENSERVER_DATA_DIR → mkdtemp 临时目录;PORT=0 随机端口(防本地 36667 冲突)。
// 每次跑完 afterAll 停 server,临时目录留在系统 tmp(不清理,方便排查)。

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { gzipSync } from "node:zlib";
import { createHmac } from "node:crypto";

const REPORT_SECRET = "test-secret-123";
const VIEW_TOKEN = "test-view-token-abc";
const AI_HOSTS = ["8.130.168.121"];

let DATA_DIR = "";
let base = "";
let server: { port: number; stop(): void } | null = null;

// ---------- helpers ----------

function writeConfig(over: Record<string, unknown | null> = {}) {
  const cfg: Record<string, unknown> = { aiStatsHosts: AI_HOSTS, reportSecret: REPORT_SECRET, viewToken: VIEW_TOKEN };
  for (const [k, v] of Object.entries(over)) {
    if (v === null) delete cfg[k]; // null = 删除该键(测「未配置」分支)
    else cfg[k] = v;
  }
  writeFileSync(join(DATA_DIR, "config.json"), JSON.stringify(cfg));
}

function sign(ts: string, raw: Uint8Array): string {
  return createHmac("sha256", REPORT_SECRET).update(ts).update(raw).digest("hex");
}

/** POST /api/report。默认按原始字节正确签名;可覆盖 ts/sig/gzip 模拟各种验签场景。 */
async function postReport(body: unknown, opts: { gzip?: boolean; ts?: string; sig?: string } = {}) {
  const ts = opts.ts ?? String(Date.now());
  const jsonStr = JSON.stringify(body);
  const raw = opts.gzip ? gzipSync(Buffer.from(jsonStr, "utf8")) : Buffer.from(jsonStr, "utf8");
  const headers: Record<string, string> = { "content-type": "application/json", "x-report-ts": ts };
  headers["x-report-sig"] = opts.sig ?? sign(ts, raw);
  if (opts.gzip) headers["content-encoding"] = "gzip";
  return fetch(base + "/api/report", { method: "POST", headers, body: raw });
}

/** 主测试上报数据:
 *  - projA host=8.130.168.121 命中白名单 → git_changes 计入 denominator/stats
 *  - projB host=evil.com 不命中 → commit 被过滤(AI 占比 host 白名单验证)
 *  - s2 token 全 0 → /api/sessions 过滤掉(token>0),stats 仍计入
 */
function mainReport() {
  const now = Date.now();
  return {
    version: "1.4.7",
    generatedAt: now,
    since: 0,
    gitUser: "testuser",
    projects: [
      {
        cwd: "/workspace/projA",
        name: "projA",
        gitUser: "testuser",
        gitRemote: "https://8.130.168.121/team/projA.git",
        sessionCount: 2,
        sessions: [
          {
            sessionId: "s1",
            lastActive: now,
            tokenTotal: { input: 100, output: 50, cacheCreation: 10, cacheRead: 5 },
            linesTotal: { added: 30, deleted: 10, modified: 5 },
            activeMs: 3_600_000,
            title: "test session A",
          },
          {
            sessionId: "s2",
            lastActive: now - 86_400_000,
            tokenTotal: { input: 0, output: 0, cacheCreation: 0, cacheRead: 0 },
            linesTotal: { added: 5, deleted: 1, modified: 0 },
            activeMs: 600_000,
            title: "zero token session",
          },
        ],
        totalTokens: { input: 100, output: 50, cacheCreation: 10, cacheRead: 5 },
        totalLines: { added: 35, deleted: 11, modified: 5 },
        gitCommits: [{ hash: "abc111", ts: now, added: 20, deleted: 5, aiAdded: 15, aiDeleted: 3 }],
      },
      {
        cwd: "/workspace/projB",
        name: "projB",
        gitUser: "testuser",
        gitRemote: "https://evil.com/team/projB.git",
        sessionCount: 1,
        sessions: [
          {
            sessionId: "s3",
            lastActive: now,
            tokenTotal: { input: 10, output: 5, cacheCreation: 0, cacheRead: 0 },
            linesTotal: { added: 8, deleted: 2, modified: 1 },
            activeMs: 900_000,
            title: "test session B",
          },
        ],
        totalTokens: { input: 10, output: 5, cacheCreation: 0, cacheRead: 0 },
        totalLines: { added: 8, deleted: 2, modified: 1 },
        gitCommits: [{ hash: "abc222", ts: now, added: 100, deleted: 50, aiAdded: 0, aiDeleted: 0 }],
      },
    ],
    worklogs: [
      {
        date: "2026-08-21",
        sessionId: "s1",
        cwd: "/workspace/projA",
        repo: "projA",
        branch: "main",
        start: "09:00",
        end: "11:00",
        minutes: 120,
        hours: 2,
        taskId: 77563,
        taskName: "AI提效工具开发",
        projectId: 6924,
        projectName: "日常工作/AI智能体",
        work: "测试工时报报",
        status: "done",
        zentaoUrl: "https://easy.shine.com.cn/index.php?m=task&f=view&taskID=77563",
        subId: "2026-08-21:0",
      },
      {
        date: "2026-08-20",
        sessionId: "s2",
        cwd: "/workspace/projA",
        repo: "projA",
        branch: "main",
        start: "10:00",
        end: "10:30",
        minutes: 30,
        hours: 0.5,
        taskId: 78363,
        taskName: "为门诊部门搭建dify环境",
        projectId: 6924,
        projectName: "日常工作/AI智能体",
        work: "环境打包备份",
        status: "done",
        zentaoUrl: "https://easy.shine.com.cn/index.php?m=task&f=view&taskID=78363",
        subId: "2026-08-20:0",
      },
    ],
  };
}

beforeAll(async () => {
  DATA_DIR = mkdtempSync(join(tmpdir(), "tokenserver-test-"));
  writeConfig();
  process.env.TOKENSERVER_DATA_DIR = DATA_DIR;
  process.env.PORT = "0";
  const mod = await import("../server");
  server = mod.startServer();
  base = `http://127.0.0.1:${server.port}`;
  // 首次上报走 gzip + 正确签名路径(同时覆盖 gzip 传输链路)
  const res = await postReport(mainReport(), { gzip: true });
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ status: "ok" });
});

afterAll(() => {
  server?.stop();
  delete process.env.TOKENSERVER_DATA_DIR;
  delete process.env.PORT;
});

// ---------- health ----------

describe("/api/health", () => {
  test("探活(无鉴权豁免)", async () => {
    const res = await fetch(base + "/api/health");
    expect(res.status).toBe(200);
    const j = (await res.json()) as { service: string; ok: boolean };
    expect(j.service).toBe("tokenserver");
    expect(j.ok).toBe(true);
  });
});

// ---------- viewToken 鉴权 ----------

describe("viewToken 读接口鉴权", () => {
  test("无 token → 401", async () => {
    const res = await fetch(base + "/api/stats");
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
  });

  test("错 token → 401", async () => {
    const res = await fetch(base + "/api/stats?t=wrong-token");
    expect(res.status).toBe(401);
  });

  test("?t= 正确 → 200", async () => {
    const res = await fetch(base + `/api/stats?t=${VIEW_TOKEN}`);
    expect(res.status).toBe(200);
  });

  test("Authorization: Bearer 正确 → 200", async () => {
    const res = await fetch(base + "/api/stats", { headers: { authorization: `Bearer ${VIEW_TOKEN}` } });
    expect(res.status).toBe(200);
  });

  test("其它 /api/* 同样受保护(worklog 无 token → 401)", async () => {
    const res = await fetch(base + "/api/member/testuser/worklog");
    expect(res.status).toBe(401);
  });

  test("静态页 / 开放(免鉴权)", async () => {
    const res = await fetch(base + "/");
    expect(res.status).toBe(200);
  });

  test("/docs 开放(免鉴权)", async () => {
    const res = await fetch(base + "/docs");
    expect(res.status).toBe(200);
  });
});

// ---------- 上报验签(4xx / 鉴权失败不落库) ----------

describe("POST /api/report 验签与校验", () => {
  test("正确签名 → 200 {status:ok}", async () => {
    const res = await postReport(mainReport());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
  });

  test("错误签名 → 401", async () => {
    const res = await postReport(mainReport(), { sig: "deadbeef".padEnd(64, "0") });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
  });

  test("ts 非 13 位毫秒 → 401", async () => {
    const res = await postReport(mainReport(), { ts: "abc123" });
    expect(res.status).toBe(401);
  });

  test("ts 超 ±15min 窗口 → 401", async () => {
    const res = await postReport(mainReport(), { ts: String(Date.now() - 20 * 60_000) });
    expect(res.status).toBe(401);
  });

  test("签名对但 body 非 JSON → 400 bad json", async () => {
    const raw = Buffer.from("not json {{{", "utf8");
    const ts = String(Date.now());
    const res = await fetch(base + "/api/report", {
      method: "POST",
      headers: { "content-type": "application/json", "x-report-ts": ts, "x-report-sig": sign(ts, raw) },
      body: raw,
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "bad json" });
  });

  test("JSON 但缺 projects → 400 invalid report", async () => {
    const res = await postReport({ version: "1.4.7", generatedAt: Date.now() });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid report: projects missing" });
  });
});

// ---------- 幂等 + COALESCE(linesTotal null 保留旧值) ----------

describe("幂等与 linesTotal COALESCE", () => {
  test("同 report 重放 → 200,会话数不翻倍", async () => {
    const before = (await (await fetch(base + `/api/stats?t=${VIEW_TOKEN}`)).json()) as any;
    const res = await postReport(mainReport());
    expect(res.status).toBe(200);
    const after = (await (await fetch(base + `/api/stats?t=${VIEW_TOKEN}`)).json()) as any;
    expect(after.totals.sessions).toBe(before.totals.sessions);
  });

  test("s1 linesTotal=null 上报 → COALESCE 保留旧值(不归零/不出 NaN)", async () => {
    const r = mainReport() as any;
    r.projects[0].sessions[0].linesTotal = null; // 模拟 events 7 天修剪后老会话行数无数据
    const res = await postReport(r);
    expect(res.status).toBe(200);
    const stats = (await (await fetch(base + `/api/stats?t=${VIEW_TOKEN}`)).json()) as any;
    // s1 保留旧 {30,10,5};s2 {5,1,0};s3 {8,2,1}
    expect(stats.totals.lines).toEqual({ added: 43, deleted: 13, modified: 6 });
  });
});

// ---------- stats 全局聚合 ----------

describe("/api/stats", () => {
  let j: any;
  beforeAll(async () => {
    j = await (await fetch(base + `/api/stats?t=${VIEW_TOKEN}`)).json();
  });

  test("totals 汇总(session 数含 token=0 的 s2;members/projects 计数)", () => {
    expect(j.totals.token).toEqual({ input: 110, output: 55, cacheCreation: 10, cacheRead: 5 });
    expect(j.totals.rawTotal).toBe(180);
    expect(j.totals.lines).toEqual({ added: 43, deleted: 13, modified: 6 });
    expect(j.totals.activeMs).toBe(5_100_000);
    expect(j.totals.sessions).toBe(3);
    expect(j.totals.members).toBe(1);
    expect(j.totals.projects).toBe(2); // projA + projB 都是真项目
  });

  test("codeLines/aiCodeLines 只统计 host 白名单命中(projB 被过滤)", () => {
    expect(j.totals.codeLines).toEqual({ added: 20, deleted: 5 });
    expect(j.totals.aiCodeLines).toEqual({ added: 15, deleted: 3 });
  });

  test("trend/daily/composition", () => {
    expect(j.trend.length).toBeGreaterThanOrEqual(1);
    expect(j.daily.length).toBeGreaterThanOrEqual(1);
    expect(j.composition).toEqual({ input: 110, output: 55, cache: 15 });
  });

  test("tokenRank:member + project(仅真项目,projA token 大)", () => {
    expect(j.tokenRank.member).toEqual([{ gitUser: "testuser", token: 180 }]);
    const proj = j.tokenRank.project as Array<{ cwd: string; token: number }>;
    expect(proj.length).toBe(2);
    expect(proj[0].cwd).toBe("/workspace/projA");
    expect(proj[0].token).toBe(165);
  });

  test("codeRank:成员按总行数排序,含行数/会话/token", () => {
    expect(j.codeRank.length).toBe(1);
    expect(j.codeRank[0].gitUser).toBe("testuser");
    expect(j.codeRank[0].lines).toBe(62); // 43+13+6
    expect(j.codeRank[0].convs).toBe(3);
  });

  test("sizeBuckets:token 桶(0-10K 两个;token=0 的 s2 跳过)", () => {
    const b = j.sizeBuckets as Array<{ range: string; count: number }>;
    expect(b[0].range).toBe("0–10K");
    expect(b[0].count).toBe(2);
    expect(b.reduce((s, x) => s + x.count, 0)).toBe(2);
  });

  test("members[]:含 version=最新上报版本(非字典序 MAX)与 realProjects", () => {
    expect(j.members.length).toBe(1);
    const m = j.members[0];
    expect(m.gitUser).toBe("testuser");
    expect(m.version).toBe("1.4.7");
    expect(m.sessionCount).toBe(3);
    expect(m.realProjects).toBe(2);
    expect(m.codeLines).toEqual({ added: 20, deleted: 5 });
    expect(m.aiCodeLines).toEqual({ added: 15, deleted: 3 });
  });

  test("granularity=week → 桶按周(周一)聚合,数据结构一致", async () => {
    const w = (await (await fetch(base + `/api/stats?t=${VIEW_TOKEN}&granularity=week`)).json()) as any;
    expect(Array.isArray(w.trend)).toBe(true);
    expect(w.trend.length).toBeGreaterThanOrEqual(1);
  });

  test("start/end 过滤:只看今天(排除昨天 s2)", async () => {
    const today = new Date().toISOString().slice(0, 10);
    const s = (await (await fetch(base + `/api/stats?t=${VIEW_TOKEN}&start=${today}`)).json()) as any;
    expect(s.totals.sessions).toBe(2); // s1 + s3(今天),s2(昨天)被滤
    expect(s.totals.rawTotal).toBe(180); // s2 token=0 不影响
  });
});

// ---------- denominator-breakdown ----------

describe("/api/denominator-breakdown", () => {
  test("host 白名单:只统计命中 commit,byAi 分 AI/无覆盖两桶", async () => {
    const j = (await (await fetch(base + `/api/denominator-breakdown?t=${VIEW_TOKEN}`)).json()) as any;
    // projA commit {added:20,deleted:5,aiAdded:15,aiDeleted:3};projB(eval.com)被过滤
    expect(j.total).toEqual({ denom: 25, ai: 18, commits: 1 });
    expect(j.byCwd.length).toBe(1);
    expect(j.byCwd[0]).toEqual({ cwd: "/workspace/projA", denom: 25, ai: 18, commits: 1 });
    expect(j.byAi[0]).toEqual({ bucket: "ai", denom: 25, ai: 18, commits: 1 });
    expect(j.byAi[1]).toEqual({ bucket: "no-ai", denom: 0, ai: 0, commits: 0 });
  });
});

// ---------- sessions 分页 ----------

describe("/api/sessions", () => {
  test("分页结构 + token>0 过滤(s2 被滤) + row.name=cwd basename", async () => {
    const res = await fetch(base + `/api/sessions?t=${VIEW_TOKEN}&page=1&pageSize=10`);
    expect(res.status).toBe(200);
    const j = (await res.json()) as any;
    expect(j.page).toBe(1);
    expect(j.pageSize).toBe(10);
    expect(j.total).toBe(2); // s1(165)+s3(15);s2 token=0 被滤
    expect(j.rows.length).toBe(2);
    const ids = j.rows.map((r: any) => r.sessionId);
    expect(ids).toEqual(["s1", "s3"]); // lastActive desc
    expect(j.rows[0].name).toBe("projA");
    expect(j.rows[0].input).toBe(100);
    expect(typeof j.rows[0].lastActive).toBe("number");
  });

  test("member 过滤参数生效", async () => {
    const j = (await (await fetch(base + `/api/sessions?t=${VIEW_TOKEN}&member=testuser`)).json()) as any;
    expect(j.total).toBe(2);
  });

  test("不存在的成员 → 空 rows,结构仍完整", async () => {
    const j = (await (await fetch(base + `/api/sessions?t=${VIEW_TOKEN}&member=nobody`)).json()) as any;
    expect(j.rows).toEqual([]);
    expect(j.total).toBe(0);
  });
});

// ---------- member 详情 + 禅道工时 ----------

describe("/api/member/:gitUser", () => {
  test("成员 KPI + 趋势", async () => {
    const j = (await (await fetch(base + `/api/member/testuser?t=${VIEW_TOKEN}`)).json()) as any;
    expect(j.gitUser).toBe("testuser");
    expect(j.totals.sessions).toBe(3);
    expect(j.totals.realProjects).toBe(2);
    expect(j.totals.activeMs).toBe(5_100_000);
    expect(j.totals.codeLines).toEqual({ added: 20, deleted: 5 });
    expect(j.totals.aiCodeLines).toEqual({ added: 15, deleted: 3 });
    expect(j.trend.length).toBeGreaterThanOrEqual(1);
    expect(j.daily.length).toBeGreaterThanOrEqual(1);
    expect(j.lastActive).toBeGreaterThan(0);
  });
});

describe("/api/member/:gitUser/worklog", () => {
  test("分页 + totalHours(全量口径)+ date DESC", async () => {
    const j = (await (await fetch(base + `/api/member/testuser/worklog?t=${VIEW_TOKEN}`)).json()) as any;
    expect(j.total).toBe(2);
    expect(j.totalHours).toBe(2.5);
    expect(j.rows.length).toBe(2);
    expect(j.rows[0].date).toBe("2026-08-21");
    expect(j.rows[0].hours).toBe(2);
    expect(j.rows[0].taskName).toBe("AI提效工具开发");
    expect(j.rows[1].date).toBe("2026-08-20");
  });

  test("date 范围过滤(start=2026-08-21 → 只当天)", async () => {
    const j = (await (await fetch(base + `/api/member/testuser/worklog?t=${VIEW_TOKEN}&start=2026-08-21`)).json()) as any;
    expect(j.total).toBe(1);
    expect(j.totalHours).toBe(2);
    expect(j.rows[0].date).toBe("2026-08-21");
  });

  test("date 范围过滤(end=2026-08-20 → 只当天)", async () => {
    const j = (await (await fetch(base + `/api/member/testuser/worklog?t=${VIEW_TOKEN}&end=2026-08-20`)).json()) as any;
    expect(j.total).toBe(1);
    expect(j.totalHours).toBe(0.5);
  });
});

// ---------- 静态资源 + docs ----------

describe("静态资源", () => {
  test("GET / → 200 text/html(ui/index.html)", async () => {
    const res = await fetch(base + "/");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type") ?? "").toContain("text/html");
  });

  test("GET /docs → 200 text/html(数据说明.md 渲染)", async () => {
    const res = await fetch(base + "/docs");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type") ?? "").toContain("text/html");
    const text = await res.text();
    expect(text).toContain("数据说明");
  });

  test("未知路径带 token → 404(无 token 的 401 已在鉴权组覆盖)", async () => {
    const res = await fetch(base + `/api/no-such-route?t=${VIEW_TOKEN}`);
    expect(res.status).toBe(404);
  });
});

// ---------- 配置热更新(readAuthConfig 每次请求重读) ----------

describe("配置热更新(改 config.json 即时生效)", () => {
  test("删除 viewToken → 读接口开放;恢复后重新收紧", async () => {
    try {
      writeConfig({ viewToken: null }); // 未配 viewToken
      const res = await fetch(base + "/api/stats");
      expect(res.status).toBe(200);
    } finally {
      writeConfig();
    }
    const closed = await fetch(base + "/api/stats");
    expect(closed.status).toBe(401);
  });

  test("删除 reportSecret → POST 不验签放行;恢复后重新验签", async () => {
    try {
      writeConfig({ reportSecret: null }); // 未配 reportSecret
      const res = await postReport(mainReport(), { sig: "garbage" });
      expect(res.status).toBe(200); // 放行(迁移期兼容老 daemon)
    } finally {
      writeConfig();
    }
    const signed = await postReport(mainReport(), { sig: "garbage" });
    expect(signed.status).toBe(401);
  });
});
