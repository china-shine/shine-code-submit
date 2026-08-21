/** zentao.ts 网络命令端到端:mock 禅道(Bun.serve)承接全部 HTTP,
 *  子进程真实走 loadConfig→Client.login→分发。覆盖:check / projects / my-tasks / executions /
 *  create-task / refresh / plan(--source zentao)/ commit --dry-run / auto(4 分支)/ amend / efforts / submit /
 *  未知命令、登录失败、服务器不可达。断言既看 stdout JSON,也看 mock 记录的请求(参数/未发请求)。 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { sandbox, cleanupSandboxes, startMockZentao, withLogin, nearDate, noBizPost, type Route } from "./cli-harness";

const REAL_PROJ = "C:/Users/ren/AppData/Local/shine-worklog/zenpilot/projects/C--Users-ren-Desktop-workspace-livesetting";
afterAll(() => {
  cleanupSandboxes();
  let sessions = "", summary = "";
  try { sessions = readFileSync(path.join(REAL_PROJ, "sessions.json"), "utf8"); } catch {}
  try { summary = readFileSync(path.join(REAL_PROJ, "summary-2026-08-06.json"), "utf8"); } catch {}
  if (/"id": "s\d/.test(sessions)) throw new Error("污染!真实 sessions 出现假 s* id");
  if (/"session": "s\d"/.test(summary)) throw new Error("污染!真实 summary 出现假 s* session");
});

const mock = startMockZentao();
beforeAll(() => { mock.setRoutes(withLogin(() => null)); });
afterAll(() => { mock.stop(); });

const sb = () => sandbox({ url: mock.url, account: "me", password: "p", projectIds: [1] });
const SESSIONS = (arr: any[]) => ({ date: "2026-08-06", sessions: arr });
const near = nearDate();

// ---------- 单端点类 ----------
describe("check 命令", () => {
  test("登录 + /user → ok/account/realname/role", async () => {
    const s = sb();
    mock.setRoutes(withLogin((c) =>
      c.p.endsWith("/user") ? { status: 200, body: { profile: { account: "me", realname: "张三", role: { name: "研发" } } } } : null));
    const r = await s.run(["check"]);
    expect(r.code).toBe(0);
    expect(r.json).toEqual({ ok: true, account: "me", realname: "张三", role: "研发" });
  }, 20000);
});

describe("登录失败路径", () => {
  test("token 空(账密错)→ die 获取 token 失败", async () => {
    const s = sb();
    mock.setRoutes((c) => (c.p.endsWith("/tokens") ? { status: 200, body: { token: "" } } : null));
    const r = await s.run(["check"]);
    expect(r.code).toBe(1);
    expect(r.json.error).toContain("获取 token 失败");
  }, 20000);

  test("服务器不可达(拒绝连接)→ die 无法连接禅道服务器", async () => {
    const s = sandbox({ url: "http://127.0.0.1:9", account: "me", password: "p" });
    const r = await s.run(["check"]);
    expect(r.code).toBe(1);
    expect(r.json.error).toContain("无法连接禅道服务器");
  }, 30000);
});

describe("projects 命令", () => {
  const ROUTE: Route = (c) =>
    c.p.includes("/projects") && c.method === "GET"
      ? {
          status: 200,
          body: { projects: [
            { id: 1, name: "Alpha", status: "doing", left: 5, lastEditedDate: "2026-08-01" },
            { id: 2, name: "Beta", status: "closed", left: 0 },
            { id: 3, name: "Gamma", status: "doing", left: 0 },
            { id: 4, name: "Delta", status: "doing", left: 2 },
          ] },
        }
      : null;

  test("默认只留进行中(doing 且 left>0)", async () => {
    const s = sb();
    mock.setRoutes(withLogin(ROUTE));
    const r = await s.run(["projects"]);
    expect(r.json.map((p: any) => p.id)).toEqual([1, 4]);
  }, 20000);
  test("--all 含已关闭/无剩余", async () => {
    const s = sb();
    mock.setRoutes(withLogin(ROUTE));
    const r = await s.run(["projects", "--all"]);
    expect(r.json.map((p: any) => p.id)).toEqual([1, 2, 3, 4]);
  }, 20000);
  test("--search 大小写不敏感过滤;--limit 透传到请求 URL", async () => {
    const s = sb();
    mock.setRoutes(withLogin(ROUTE));
    const r = await s.run(["projects", "--search", "alpha"]);
    expect(r.json.map((p: any) => p.id)).toEqual([1]);
    const r2 = await s.run(["projects", "--limit", "2"]);
    expect(r2.json.map((p: any) => p.id)).toEqual([1, 4]);
    expect(mock.requests.some((x) => x.p.includes("/projects") && x.q.includes("limit=2"))).toBe(true);
  }, 20000);
});

describe("my-tasks 命令", () => {
  const ROUTE: Route = (c) => {
    if (c.p.includes("/projects/1/executions"))
      return { status: 200, body: { executions: [{ id: 20, status: "doing", name: "E1" }] } };
    if (c.p.includes("/executions/20/tasks"))
      return { status: 200, body: { tasks: [
        { id: 100, name: "T100", status: "doing", assignedTo: { account: "me" }, estimate: 10, consumed: 2, left: 8 },
        { id: 101, name: "T101", status: "doing", assignedTo: { account: "other" } },
        { id: 102, name: "T102", status: "done", assignedTo: "me" },
        { id: 103, name: "T103", status: "wait", assignedTo: "me" },
      ] } };
    return null;
  };

  test("默认 doing/wait + 只看我自己的(cfg.projectIds 兜底)", async () => {
    const s = sb();
    mock.setRoutes(withLogin(ROUTE));
    const r = await s.run(["my-tasks"]);
    expect(r.json.map((t: any) => t.id)).toEqual([100, 103]);
    expect(r.json[0]).toMatchObject({ executionName: "E1", project: 1, left: 8 });
  }, 20000);
  test("--all-status 含 done;--projects 显式覆盖", async () => {
    const s = sb();
    mock.setRoutes(withLogin(ROUTE));
    const r = await s.run(["my-tasks", "--all-status", "--projects", "1"]);
    expect(r.json.map((t: any) => t.id)).toEqual([100, 102, 103]);
  }, 20000);
});

describe("executions 命令", () => {
  test("--projects → 实时拉,只留 doing", async () => {
    const s = sb();
    mock.setRoutes(withLogin((c) =>
      c.p.includes("/projects/1/executions")
        ? { status: 200, body: { executions: [
            { id: 20, status: "doing", name: "E1", end: "2030-01-01" },
            { id: 21, status: "closed", name: "E2" },
          ] } }
        : null));
    const r = await s.run(["executions", "--projects", "1"]);
    expect(r.json).toEqual([{ id: 20, name: "E1", project: 1, end: "2030-01-01" }]);
  }, 20000);
  test("无 --projects → 读本地 cache.executions(0 网络)", async () => {
    const s = sb();
    s.write("cache", { projects: [], tasks: [], executions: [{ id: 30, name: "缓存执行" }], taskDetails: {} });
    mock.setRoutes(withLogin(() => null));
    const before = mock.requests.length;
    const r = await s.run(["executions"]);
    expect(r.json).toEqual([{ id: 30, name: "缓存执行" }]);
    expect(mock.requests.slice(before).filter((x) => !x.p.endsWith("/tokens")).length).toBe(0); // 只有登录,无业务请求
  }, 20000);
});

describe("create-task 命令", () => {
  const ROUTE: Route = (c) =>
    c.p.includes("/executions/20/tasks") && c.method === "POST"
      ? { status: 200, body: { id: 999, name: "新任务" } }
      : null;

  test("建任务并指派给自己,新任务自动进 cache", async () => {
    const s = sb();
    s.write("cache", { projects: [{ id: 1, name: "P1" }], tasks: [], executions: [{ id: 20, project: 1, name: "E1" }], taskDetails: {} });
    mock.setRoutes(withLogin(ROUTE));
    const r = await s.run(["create-task", "--execution", "20", "--name", "新任务", "--estimate", "3", "--desc", "描述"]);
    expect(r.code).toBe(0);
    expect(r.json).toEqual({ created: true, task: { id: 999, name: "新任务" }, execution: 20, estimate: 3 });
    const t = s.read("cache").tasks.find((x: any) => x.id === 999);
    expect(t).toMatchObject({ name: "新任务", status: "wait", estimate: 3, left: 3, project: 1, execution: 20 });
    const post = mock.requests.find((x) => x.method === "POST" && x.p.includes("/executions/20/tasks"));
    expect(post?.body).toMatchObject({ name: "新任务", assignedTo: ["me"], estimate: 3, left: 3, desc: "描述", type: "devel" });
  }, 20000);
  test("缺 --name → die", async () => {
    const s = sb();
    mock.setRoutes(withLogin(ROUTE));
    const r = await s.run(["create-task", "--execution", "20", "--estimate", "3"]);
    expect(r.code).toBe(1);
    expect(r.json.error).toContain("--name");
  }, 20000);
});

describe("efforts 命令", () => {
  test("过滤 account=自己 + 未删除,映射 effortId/日期/工时", async () => {
    const s = sb();
    mock.setRoutes(withLogin((c) =>
      c.p.endsWith("/tasks/100/estimate")
        ? { status: 200, body: { effort: {
            a: { id: 1, account: "me", deleted: "0", date: "2026-08-06", consumed: "2", left: "8", work: "做A" },
            b: { id: 2, account: "other", deleted: "0", date: "2026-08-06", consumed: "1", work: "别人的" },
            c: { id: 3, account: "me", deleted: "1", date: "2026-08-05", consumed: "3", work: "已删的" },
          } } }
        : null));
    const r = await s.run(["efforts", "--task", "100"]);
    expect(r.json).toEqual([{ effortId: 1, date: "2026-08-06", consumed: "2", left: "8", work: "做A" }]);
  }, 20000);
  test("缺 --task → die", async () => {
    const s = sb();
    mock.setRoutes(withLogin(() => null));
    const r = await s.run(["efforts"]);
    expect(r.code).toBe(1);
    expect(r.json.error).toContain("--task");
  }, 20000);
});

// ---------- 提交类 ----------
const PLAN_ITEM = (over: any = {}) => ({
  session: "s1", repo: "r1", branch: "main", date: "2026-08-06", start: "09:00", end: "10:00",
  minutes: 60, hours: 1, summary: "", meta: false, increment: false, status: "resolved",
  task: 100, taskName: "T100", project: 1, projectName: "P1", work: "做A",
  confidence: 100, reason: "summary 记录", left: 7, ...over,
});

describe("commit --dry-run", () => {
  test("不发 POST、不写台账/映射/流水,返回预览 payload(left 用 plan 值免 GET)", async () => {
    const s = sb();
    s.write("cache", { projects: [{ id: 1, name: "P1" }], tasks: [{ id: 100, name: "T100", project: 1, status: "doing", left: 8 }], executions: [], taskDetails: {} });
    s.write("plan", { date: "2026-08-06", draftSeq: 0, items: [PLAN_ITEM()] });
    const before = mock.requests.length;
    const r = await s.run(["commit", "--dry-run"]);
    expect(r.code).toBe(0);
    expect(r.json.dryRun).toBe(true);
    expect(r.json.submitted).toBe(0); // dryRun 无 submitted 字段
    const payload = r.json.results[0].payload;
    expect(payload).toEqual({ date: ["2026-08-06"], work: ["1. 做A(本次内容由AI填报)"], consumed: [1], left: [7] });
    expect(noBizPost(mock.requests.slice(before))).toBe(true); // 零业务 POST(登录不算)
    expect(s.exists("submitted")).toBe(false); // 不记台账
    expect(s.exists("mappings")).toBe(false); // 不写映射
    expect(s.exists("submittedLog:2026-08-06")).toBe(false); // 不落流水
  }, 20000);
});

describe("auto 命令(4 分支)", () => {
  const CACHE = () => ({ projects: [{ id: 1, name: "P1" }], tasks: [{ id: 100, name: "T100", project: 1, status: "doing", left: 8 }], executions: [], taskDetails: {} });
  const OK_ESTIMATE: Route = (c) =>
    c.method === "POST" && c.p.endsWith("/tasks/100/estimate") ? { status: 200, body: { consumed: 9, left: 7 } } : null;

  test("全 resolved → committed:提交禅道+记水位+学映射+落流水", async () => {
    const s = sb();
    s.write("cache", CACHE());
    s.write("sessions", SESSIONS([{ id: "s1", repo: "r1", branch: "main", activeMinutes: 60, start: "09:00", end: "10:00" }]));
    s.write("summary:2026-08-06", [{ session: "s1", work: "做A", task: 100, notedActiveMinutes: 60, taskName: "T100", project: 1, projectName: "P1" }]);
    mock.setRoutes(withLogin(OK_ESTIMATE));
    const r = await s.run(["auto"]);
    expect(r.code).toBe(0);
    expect(r.json.action).toBe("committed");
    expect(r.json.result.submitted).toBe(1);
    expect(r.json.draft).toContain("工时草稿");
    // 禅道 POST 内容:编号+AI 标识、plan 算好的 left
    const post = mock.requests.find((x) => x.method === "POST" && x.p.endsWith("/tasks/100/estimate"));
    expect(post?.body).toEqual({ date: ["2026-08-06"], work: ["1. 做A(本次内容由AI填报)"], consumed: [1], left: [7] });
    // 台账水位 + 映射学习 + 流水
    expect(s.read("submitted")["2026-08-06"].s1).toMatchObject({ tasks: [100], hours: 1, minutes: 60 });
    expect(s.read("mappings").repoToProject).toEqual({ r1: 1 });
    const logLine = JSON.parse(s.readText("submittedLog:2026-08-06").trim());
    expect(logLine).toMatchObject({ session: "s1", hours: 1, task: 100, work: "1. 做A(本次内容由AI填报)" });
  }, 20000);

  test("有 unmatched(note task=-1)→ needs_review,不提交", async () => {
    const s = sb();
    s.write("cache", CACHE());
    s.write("sessions", SESSIONS([{ id: "s1", repo: "r1", branch: "main", activeMinutes: 60, start: "09:00", end: "10:00" }]));
    s.write("summary:2026-08-06", [{ session: "s1", work: "待匹配", task: -1, notedActiveMinutes: 60 }]);
    const before = mock.requests.length;
    const r = await s.run(["auto"]);
    expect(r.json.action).toBe("needs_review");
    expect(r.json.pending).toContain("s1");
    expect(r.json.unmatched[0].candidates.map((c: any) => c.id)).toEqual([100]);
    expect(noBizPost(mock.requests.slice(before))).toBe(true);
  }, 20000);

  test("全部已提交(增量<15)→ nothing,渲染提示无可提交", async () => {
    const s = sb();
    s.write("cache", CACHE());
    s.write("sessions", SESSIONS([{ id: "s1", repo: "r1", branch: "main", activeMinutes: 60, start: "09:00", end: "10:00" }]));
    s.write("submitted", { "2026-08-06": { s1: { tasks: [100], hours: 1, minutes: 60 } } });
    const r = await s.run(["auto"]);
    expect(r.json.action).toBe("nothing");
    expect(r.json.draft).toContain("本次无可提交条目");
    expect(s.exists("submittedLog:2026-08-06")).toBe(false);
  }, 20000);

  test("冷却中(最近提交过)→ cooldown 带 waitMinutes,不提交", async () => {
    const s = sb();
    s.write("cache", CACHE());
    s.write("sessions", SESSIONS([{ id: "s1", repo: "r1", branch: "main", activeMinutes: 60, start: "09:00", end: "10:00" }]));
    s.write("summary:2026-08-06", [{ session: "s1", work: "做A", task: 100, notedActiveMinutes: 60, taskName: "T100", project: 1, projectName: "P1" }]);
    // 未来时间戳:任何时区下都判「刚提交过」(跨进程 TZ 坑,见 bun-test-tz-utc-runner-trap)
    s.write("submitted", { "2026-08-01": { _meta: { lastCommitAt: "2030-01-01T00:00:00", lastCommit: [{ session: "x", task: 1, hours: 1 }] } } });
    const before = mock.requests.length;
    const r = await s.run(["auto"]);
    expect(r.json.action).toBe("cooldown");
    expect(r.json.waitMinutes).toBeGreaterThanOrEqual(30);
    expect(noBizPost(mock.requests.slice(before))).toBe(true);
  }, 20000);

  test("填报流程会话(auto 无 AI 核对)→ 排除 meta 条目,只提交正常工作会话(报工时时间不计入)", async () => {
    const s = sb();
    s.write("cache", CACHE());
    s.write("sessions", SESSIONS([
      { id: "s1", repo: "r1", branch: "main", activeMinutes: 60, start: "09:00", end: "10:00" },
      // 填报元会话:标题含 skills\report、活跃<45min(aggregateMetaItems 会并成「执行 shine-worklog 工时填报流程」)
      { id: "m1", repo: "r1", branch: "main", activeMinutes: 20, start: "11:00", end: "11:20", summary: "Base directory for this skill: C:\\x\\shine-worklog\\1.3.50\\skills\\report # 工时填报" },
    ]));
    s.write("summary:2026-08-06", [
      { session: "s1", work: "做A", task: 100, notedActiveMinutes: 60, taskName: "T100", project: 1, projectName: "P1" },
      { session: "m1", work: "执行填报", task: 100, notedActiveMinutes: 20, taskName: "T100", project: 1, projectName: "P1" },
    ]);
    mock.setRoutes(withLogin(OK_ESTIMATE));
    const beforePosts = mock.requests.filter((x) => x.method === "POST" && x.p.endsWith("/tasks/100/estimate")).length;
    const r = await s.run(["auto"]);
    expect(r.code).toBe(0);
    expect(r.json.action).toBe("committed");
    expect(r.json.result.submitted).toBe(1); // 只提交 s1,m1(填报会话)被排除
    expect(r.json.draft).not.toContain("执行 shine-worklog 工时填报流程"); // 草稿不含填报条目
    const posts = mock.requests.filter((x) => x.method === "POST" && x.p.endsWith("/tasks/100/estimate"));
    expect(posts.length - beforePosts).toBe(1); // 只发一次提交请求
    expect(posts[posts.length - 1].body.work[0]).toContain("做A");
    expect(s.read("submitted")["2026-08-06"].s1).toBeDefined();
    expect(s.read("submitted")["2026-08-06"].m1).toBeUndefined(); // 填报会话不记台账
  }, 20000);
});

describe("amend 命令", () => {
  test("含非最后一次提交的会话 → die 拒绝", async () => {
    const s = sb();
    s.write("plan", { date: "2026-08-06", draftSeq: 0, items: [PLAN_ITEM(), PLAN_ITEM({ session: "s2", work: "B" })] });
    s.write("submitted", { "2026-08-06": { _meta: { lastCommitAt: "2030-01-01T00:00:00", lastCommit: [{ session: "s1", task: 100, hours: 1 }] } } });
    mock.setRoutes(withLogin(() => null));
    const r = await s.run(["amend"]);
    expect(r.code).toBe(1);
    expect(r.json.error).toContain("amend 只能修正最后一次提交");
    expect(r.json.sessions).toContain("s2");
  }, 20000);

  test("只含最后会话 → 绕冷却提交,台账记 amendedAt + lastCommit 追加", async () => {
    const s = sb();
    s.write("plan", { date: "2026-08-06", draftSeq: 0, items: [PLAN_ITEM({ hours: 0.5, work: "补差 0.5h" })] });
    s.write("submitted", { "2026-08-06": { s1: { tasks: [100], hours: 1, minutes: 60 }, _meta: { lastCommitAt: "2030-01-01T00:00:00", lastCommit: [{ session: "s1", task: 100, hours: 1 }] } } });
    mock.setRoutes(withLogin((c) => {
      if (c.p.endsWith("/tasks/100") && c.method === "GET") return { status: 200, body: { name: "T100", left: 10 } };
      if (c.method === "POST" && c.p.endsWith("/tasks/100/estimate")) return { status: 200, body: { consumed: 9.5, left: 6.5 } };
      return null;
    }));
    const r = await s.run(["amend"]);
    expect(r.code).toBe(0);
    expect(r.json.amend).toBe(true);
    expect(r.json.submitted).toBe(1); // lastCommitAt 在未来仍放行(amend 绕 30min 冷却)
    const meta = s.read("submitted")["2026-08-06"]._meta;
    expect(meta.amendedAt).toBeTruthy();
    expect(meta.lastCommit).toHaveLength(2); // 原 1 笔 + 本次补差
  }, 20000);
});

describe("submit 命令(计划外手工补)", () => {
  test("--dry-run:算 left(GET task)但不 POST", async () => {
    const s = sb();
    mock.setRoutes(withLogin((c) =>
      c.p.endsWith("/tasks/100") && c.method === "GET" ? { status: 200, body: { name: "T100", left: 10 } } : null));
    const before = mock.requests.length;
    const r = await s.run(["submit", "--task", "100", "--date", "2026-08-06", "--hours", "1.5", "--work", "手工补", "--dry-run"]);
    expect(r.code).toBe(0);
    expect(r.json.dryRun).toBe(true);
    expect(r.json.payload.left).toEqual([8.5]); // roundPy(10-1.5,1)
    expect(noBizPost(mock.requests.slice(before))).toBe(true);
    expect(s.exists("submitted")).toBe(false);
  }, 20000);

  test("实提交:applyMark 拼标识 + 台账 + 流水;--session/--minutes 记水位", async () => {
    const s = sb();
    mock.setRoutes(withLogin((c) => {
      if (c.p.endsWith("/tasks/100") && c.method === "GET") return { status: 200, body: { name: "T100", left: 10 } };
      if (c.method === "POST" && c.p.endsWith("/tasks/100/estimate")) return { status: 200, body: { consumed: 6.5, left: 8.5 } };
      return null;
    }));
    const before = mock.requests.length;
    const r = await s.run(["submit", "--task", "100", "--date", "2026-08-06", "--hours", "1.5", "--work", "手工补", "--session", "s9", "--minutes", "30"]);
    expect(r.code).toBe(0);
    expect(r.json.submitted).toBe(true);
    expect(r.json.recorded).toMatchObject({ tasks: [100], hours: 1.5, minutes: 30 });
    const post = mock.requests.slice(before).find((x) => x.method === "POST" && x.p.endsWith("/tasks/100/estimate"));
    expect(post?.body.work).toEqual(["手工补(本次内容由AI填报)"]); // applyMark 行内标识
    expect(s.read("submitted")["2026-08-06"].s9).toMatchObject({ tasks: [100], hours: 1.5, minutes: 30 });
    expect(JSON.parse(s.readText("submittedLog:2026-08-06").trim())).toMatchObject({ session: "s9", hours: 1.5, work: "手工补(本次内容由AI填报)" });
  }, 20000);

  test("缺 --task → die", async () => {
    const s = sb();
    mock.setRoutes(withLogin(() => null));
    const r = await s.run(["submit", "--date", "2026-08-06", "--hours", "1", "--work", "x"]);
    expect(r.code).toBe(1);
    expect(r.json.error).toContain("--task");
  }, 20000);
});

// ---------- 缓存与计划 ----------
describe("refresh 命令(四层 20 天滚动窗口)", () => {
  test("项目/任务/记录三层过滤 + efforts 按任务拆盘 + 窗口外修剪", async () => {
    const s = sandbox({ url: mock.url, account: "me", password: "p", projectIds: [1, 2] });
    // 预置两个陈旧 efforts 文件:555 全过期应删;666 有一条窗口内应留
    s.write("efforts:555", { taskId: 555, efforts: [{ date: "2020-01-01", consumed: 1, work: "老" }] });
    s.write("efforts:666", { taskId: 666, efforts: [{ date: "2020-01-01", consumed: 1, work: "老" }, { date: near, consumed: 2, work: "新" }] });
    mock.setRoutes(withLogin((c) => {
      if (c.p.endsWith("/user"))
        return { status: 200, body: { profile: { account: "me", realname: "张三", role: {} } } }; // refresh 把中文名写进缓存
      if (c.p.includes("/projects") && !c.p.includes("/executions") && c.method === "GET")
        return { status: 200, body: { projects: [
          { id: 1, name: "P1", status: "doing", left: 5 },
          { id: 2, name: "P2", status: "closed", left: 0, lastEditedDate: near }, // 关闭但近窗口有编辑 → 留
          { id: 3, name: "P3", status: "doing", left: 5 }, // 不在 projectIds → 弃
          { id: 4, name: "P4", status: "closed", left: 0 }, // 关且无编辑 → 弃
        ] } };
      if (c.p.includes("/projects/1/executions"))
        return { status: 200, body: { executions: [{ id: 20, status: "doing", name: "E1", end: "2030-01-01" }] } };
      if (c.p.includes("/projects/2/executions"))
        return { status: 200, body: { executions: [] } };
      if (c.p.includes("/executions/20/tasks"))
        return { status: 200, body: { tasks: [
          { id: 100, name: "T100", status: "doing", assignedTo: { account: "me" }, left: 8, lastEditedDate: near },
          { id: 200, name: "T200", status: "done", assignedTo: { account: "me" }, lastEditedDate: near }, // 完成但近窗口 → 记 taskDetails + 拉 efforts
          { id: 300, name: "T300", status: "done", assignedTo: { account: "me" }, lastEditedDate: "2020-01-01" }, // 完成且老 → 弃
        ] } };
      if (c.p.endsWith("/tasks/100/estimate") || c.p.endsWith("/tasks/200/estimate"))
        return { status: 200, body: { effort: { a: { account: "me", deleted: "0", date: near, consumed: "1.5", work: "窗口内" }, b: { account: "me", deleted: "0", date: "2020-01-01", consumed: "1", work: "窗口外" } } } };
      return null;
    }));
    const r = await s.run(["refresh"]);
    expect(r.code).toBe(0);
    expect(r.json).toMatchObject({ projects: 2, tasks: 1, executions: 1 });
    const cache = s.read("cache");
    expect(cache.realname).toBe("张三"); // refresh 把禅道中文名写进缓存,cache 源离线显示用
    expect(cache.projects.map((p: any) => p.id)).toEqual([1, 2]);
    expect(cache.tasks.map((t: any) => t.id)).toEqual([100]); // 只留未完成
    expect(cache.taskDetails["200"]).toEqual({ name: "T200", project: 1 }); // 已完成进 details
    expect(s.read("efforts:100").efforts).toEqual([{ date: near, consumed: 1.5, work: "窗口内" }]); // 记录按窗口过滤
    expect(s.read("efforts:200").efforts).toHaveLength(1);
    expect(s.exists("efforts:555")).toBe(false); // 全过期 → 删
    expect(s.read("efforts:666").efforts).toEqual([{ date: near, consumed: 2, work: "新" }]); // 保留窗口内
    expect(r.stderr).toContain("[1/4]"); // 分步进度走 stderr(daemon 调用时忽略,cli 透传)
  }, 30000);
});

describe("plan --source zentao(联网刷新缓存后建计划)", () => {
  test("无本地缓存 → 拉禅道建 cache → 会话按分支任务号 resolved;cooldown 预判为空", async () => {
    const s = sb();
    s.write("sessions", SESSIONS([{ id: "s1", repo: "r1", branch: "task-100", activeMinutes: 60, start: "09:00", end: "10:00" }]));
    mock.setRoutes(withLogin((c) => {
      if (c.p.includes("/projects") && !c.p.includes("/executions") && c.method === "GET")
        return { status: 200, body: { projects: [{ id: 1, name: "P1", status: "doing", left: 5 }] } };
      if (c.p.includes("/projects/1/executions"))
        return { status: 200, body: { executions: [{ id: 20, status: "doing", name: "E1", end: "2030-01-01" }] } };
      if (c.p.includes("/executions/20/tasks"))
        return { status: 200, body: { tasks: [{ id: 100, name: "T100", status: "doing", assignedTo: { account: "me" }, left: 8 }] } };
      if (c.p.endsWith("/tasks/100/estimate"))
        return { status: 200, body: { effort: {} } };
      return null;
    }));
    const r = await s.run(["plan", "--source", "zentao"]);
    expect(r.code).toBe(0);
    expect(s.exists("cache")).toBe(true); // 联网刷新后落盘
    expect(r.json.items).toHaveLength(1);
    expect(r.json.items[0]).toMatchObject({ session: "s1", status: "resolved", task: 100, hours: 1, left: 7 });
    expect(r.json.cooldown).toBeNull();
  }, 30000);
});

describe("未知命令", () => {
  test("登录成功后仍 die 未知命令(走完网络前置)", async () => {
    const s = sb();
    mock.setRoutes(withLogin(() => null));
    const r = await s.run(["bogus"]);
    expect(r.code).toBe(1);
    expect(r.json.error).toBe("未知命令: bogus");
  }, 20000);
});
