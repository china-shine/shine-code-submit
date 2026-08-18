/** 报表命令端到端:daily / weekly / lastweek(子进程 + mock 禅道)。
 *  覆盖:实时源(zentao)与缓存源(cache,0 网络)、HTML 落盘命名(日报/周报/realname)、
 *  AI 代报工时对账(aiHours)、空区间、cache 源发现旧于最后一笔提交时的同步自动刷新(autoRefreshed)。 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import * as path from "node:path";
import { sandbox, cleanupSandboxes, startMockZentao, withLogin, nearDate, type Route } from "./cli-harness";

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

const near = nearDate();
const sb = () => sandbox({ url: mock.url, account: "me", password: "p" });

/** 报表侧标准 cache(含未完成任务,供 pendingTasks 与任务名解析)。 */
const CACHE = () => ({
  fetchedAt: "2026-08-06T00:00:00",
  projects: [{ id: 1, name: "P1" }],
  tasks: [{ id: 100, name: "T100", project: 1, status: "doing", estimate: 10, consumed: 2, left: 8 }],
  executions: [],
  taskDetails: {},
});
const USER: Route = (c) => (c.p.endsWith("/user") ? { status: 200, body: { profile: { account: "me", realname: "张三", role: {} } } } : null);
const effort = (records: any[]) => (c: any) =>
  c.p.endsWith("/tasks/100/estimate") ? { status: 200, body: { effort: Object.fromEntries(records.map((r, i) => [String(i), { account: "me", deleted: "0", ...r }])) } } : null;

describe("daily 命令", () => {
  test("实时源:拉 efforts → HTML 落盘(日报-日期-姓名)+ AI 代报对账", async () => {
    const s = sb();
    s.write("cache", CACHE());
    mock.setRoutes(withLogin((c) => USER(c) ?? effort([{ date: "2026-08-06", consumed: "1.5", work: "做A(本次内容由AI填报)" }])(c)));
    const r = await s.run(["daily", "--from", "2026-08-06", "--to", "2026-08-06"]);
    expect(r.code).toBe(0);
    expect(r.json.ok).toBe(true);
    expect(r.json.empty).toBe(false);
    expect(r.json.title).toBe("日报 2026-08-06");
    expect(path.basename(r.json.file)).toBe("日报-2026-08-06-张三.html");
    expect(existsSync(r.json.file)).toBe(true);
    const html = readFileSync(r.json.file, "utf8");
    expect(html).toContain("本日合计");
    expect(html).toContain('class="task"'); // 任务折叠块
    expect(html).toContain("做A(本次内容由AI填报)");
    expect(r.json.text).toContain("合计 1.5h");
    expect(r.json.text).toContain("其中 AI 代报 1.5h"); // isAiWork 括号格式命中
    expect(r.json.pendingTasks[0]).toMatchObject({ id: 100, name: "T100", left: 8 }); // 未完成任务透出(供 AI 写总结)
  }, 30000);

  test("缓存源:读 efforts/ 目录,0 网络拉记录(仅登录+/user)", async () => {
    const s = sb();
    s.write("cache", CACHE());
    s.write("efforts:100", { taskId: 100, fetchedAt: "2026-08-06T00:00:00", efforts: [{ date: "2026-08-06", consumed: 2, work: "缓存里的记录" }] });
    mock.setRoutes(withLogin(USER));
    const before = mock.requests.length;
    const r = await s.run(["daily", "--from", "2026-08-06", "--to", "2026-08-06", "--source", "cache"]);
    expect(r.code).toBe(0);
    expect(r.json.text).toContain("缓存里的记录");
    expect(r.json.text).toContain("合计 2h");
    expect(mock.requests.slice(before).some((x) => x.p.includes("/estimate"))).toBe(false); // 不实时拉记录
  }, 30000);

  test("缓存旧于最后一笔提交 → 同步自动刷新(cacheStaleVsSubmissions → autoRefreshed)", async () => {
    const s = sb();
    s.write("cache", { ...CACHE(), fetchedAt: "2026-01-01T00:00:00" }); // 缓存极旧
    s.write("submittedLog:2026-08-06", JSON.stringify({ ts: "2026-08-06T12:00:00", date: "2026-08-06", session: "s1", hours: 1, task: 100, work: "刚提交的" }) + "\n");
    // 自动刷新会走完整 refresh 链:项目→执行→任务→工时
    mock.setRoutes(withLogin((c) => {
      if (USER(c)) return USER(c);
      if (c.p.includes("/projects") && !c.p.includes("/executions") && c.method === "GET")
        return { status: 200, body: { projects: [{ id: 1, name: "P1", status: "doing", left: 5, lastEditedDate: near }] } };
      if (c.p.includes("/projects/1/executions"))
        return { status: 200, body: { executions: [{ id: 20, status: "doing", name: "E1", end: "2030-01-01" }] } };
      if (c.p.includes("/executions/20/tasks"))
        return { status: 200, body: { tasks: [{ id: 100, name: "T100", status: "doing", assignedTo: { account: "me" }, estimate: 10, consumed: 2, left: 8, lastEditedDate: near }] } };
      if (c.p.endsWith("/tasks/100/estimate"))
        return { status: 200, body: { effort: { a: { account: "me", deleted: "0", date: "2026-08-06", consumed: "1.5", work: "刷新后的记录" } } } };
      return null;
    }));
    const before = mock.requests.length;
    const r = await s.run(["daily", "--from", "2026-08-06", "--to", "2026-08-06", "--source", "cache"]);
    expect(r.code).toBe(0);
    expect(r.json.autoRefreshed).toBe(true);
    expect(mock.requests.slice(before).some((x) => x.p.endsWith("/projects") && x.q.includes("involved=1"))).toBe(true); // 真的去刷新了
    expect(r.json.text).toContain("刷新后的记录"); // 报表读的是刷新后的缓存
    expect(s.read("cache").fetchedAt).not.toBe("2026-01-01T00:00:00"); // cache.json 已被覆盖
  }, 30000);

  test("区间内无记录 → empty:true + 空态文案,文件照常落盘", async () => {
    const s = sb();
    s.write("cache", CACHE());
    mock.setRoutes(withLogin((c) => USER(c) ?? effort([{ date: "2026-01-01", consumed: "1", work: "区间外" }])(c)));
    const r = await s.run(["daily", "--from", "2026-08-06", "--to", "2026-08-06"]);
    expect(r.code).toBe(0);
    expect(r.json.empty).toBe(true);
    expect(r.json.text).toContain("没有禅道提交记录");
    expect(existsSync(r.json.file)).toBe(true);
  }, 30000);
});

describe("weekly 命令", () => {
  test("--from/--to 区间:跨天聚合到任务折叠块,周报文件名带区间", async () => {
    const s = sb();
    s.write("cache", CACHE());
    mock.setRoutes(withLogin((c) => USER(c) ?? effort([
      { date: "2026-08-04", consumed: "1.5", work: "周一做A" },
      { date: "2026-08-05", consumed: "1.5", work: "周二做A" },
      { date: "2026-08-06", consumed: "1.5", work: "周三做B" },
      { date: "2026-08-07", consumed: "9", work: "区间外不该出现" },
    ])(c)));
    const r = await s.run(["weekly", "--from", "2026-08-04", "--to", "2026-08-06"]);
    expect(r.code).toBe(0);
    expect(r.json.title).toBe("周报 2026-08-04 ~ 2026-08-06");
    expect(path.basename(r.json.file)).toBe("周报-2026-08-04~2026-08-06-张三.html");
    expect(r.json.text).toContain("本周合计 4.5h");
    expect(r.json.text).not.toContain("区间外不该出现");
    const html = readFileSync(r.json.file, "utf8");
    expect(html).toContain('<details class="task">');
    expect(html).toContain("08-04"); // 同任务跨天 day-row
    expect(html).toContain("08-06");
  }, 30000);
});

describe("lastweek 命令", () => {
  test("无参固定上周一~周日:近 16 天铺记录,任何当周窗口都有数", async () => {
    const s = sb();
    s.write("cache", CACHE());
    // lastweek 的区间由子进程本地时区决定,测试进程(TZ=UTC)拼日期会有 ±1 天偏差:
    // 铺满近 16 天(覆盖最远 13 天前的上周日),断言不依赖具体窗口。
    const records = Array.from({ length: 16 }, (_, i) => {
      const d = new Date(Date.now() - i * 86400e3).toISOString().slice(0, 10);
      return { date: d, consumed: "1", work: `day-${d}` };
    });
    mock.setRoutes(withLogin((c) => USER(c) ?? effort(records)(c)));
    const r = await s.run(["lastweek"]);
    expect(r.code).toBe(0);
    expect(r.json.title).toMatch(/^周报 \d{4}-\d{2}-\d{2} ~ \d{4}-\d{2}-\d{2}$/);
    expect(path.basename(r.json.file)).toMatch(/^周报-\d{4}-\d{2}-\d{2}~\d{4}-\d{2}-\d{2}-张三\.html$/);
    expect(r.json.empty).toBe(false);
    expect(r.json.text).toContain("本周合计 7h"); // 上周整周 7 天 × 1h
  }, 30000);
});
