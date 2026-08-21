/** 报表命令端到端:daily / weekly / lastweek(子进程 + mock 禅道)。
 *  覆盖:实时源(zentao)与缓存源(cache,真离线 0 网络、跳过登录)、HTML 落盘命名(日报/周报/realname)、
 *  AI 代报工时对账(aiHours)、空区间、cache 源缓存旧于最后一笔提交时的明确报错(不静默产出缺数报表)。 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import * as path from "node:path";
import { sandbox, cleanupSandboxes, startMockZentao, withLogin, type Route } from "./cli-harness";

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

  test("缓存源:读 efforts/ 目录,真离线 0 网络(连登录+/user 都不发)", async () => {
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

  test("缓存源:realname 从缓存读(禅道中文名),不退化英文 account", async () => {
    const s = sb();
    s.write("cache", { ...CACHE(), realname: "李四" }); // refresh 存进缓存的禅道中文名
    s.write("efforts:100", { taskId: 100, fetchedAt: "2026-08-06T00:00:00", efforts: [{ date: "2026-08-06", consumed: 2, work: "缓存里的记录" }] });
    mock.setRoutes(withLogin(USER)); // /user 返回张三——但离线 cache 源不该发请求,应显示缓存里的李四
    const before = mock.requests.length;
    const r = await s.run(["daily", "--from", "2026-08-06", "--to", "2026-08-06", "--source", "cache"]);
    expect(r.code).toBe(0);
    expect(r.json.text).toContain("李四");
    expect(path.basename(r.json.file)).toBe("日报-2026-08-06-李四.html"); // 文件名也用中文名
    expect(mock.requests.slice(before).length).toBe(0); // 0 网络:不因取 realname 联网
  }, 30000);

  test("缓存缺失 + cache 源(真离线)→ 明确报错提示联网,不静默产出空报表", async () => {
    const s = sb(); // 不写 cache → getCacheLocal() 为 null,离线无法联网刷新
    const before = mock.requests.length;
    const r = await s.run(["daily", "--from", "2026-08-06", "--to", "2026-08-06", "--source", "cache"]);
    expect(r.code).not.toBe(0);
    expect(r.json.error).toContain("离线");
    expect(mock.requests.slice(before).length).toBe(0); // 0 网络:缺失也不联网拉
  }, 30000);

  test("缓存损坏(JSON 截断)+ cache 源(真离线)→ getCacheLocal 退化 null → 明确报错", async () => {
    const s = sb();
    s.write("cache", '{"fetchedAt":"2026-08-06T00:00:00","projects":[{'); // 手改/写一半截断 → JSON.parse throw
    const before = mock.requests.length;
    const r = await s.run(["daily", "--from", "2026-08-06", "--to", "2026-08-06", "--source", "cache"]);
    expect(r.code).not.toBe(0);
    expect(r.json.error).toContain("离线");
    expect(mock.requests.slice(before).length).toBe(0);
  }, 30000);

  test("缓存旧于最后一笔提交 + cache 源(真离线)→ 明确报错提示联网,不静默产出缺数报表", async () => {
    const s = sb();
    s.write("cache", { ...CACHE(), fetchedAt: "2026-01-01T00:00:00" }); // 缓存极旧(旧于区间内最后一笔提交)
    s.write("submittedLog:2026-08-06", JSON.stringify({ ts: "2026-08-06T12:00:00", date: "2026-08-06", session: "s1", hours: 1, task: 100, work: "刚提交的" }) + "\n");
    const before = mock.requests.length;
    const r = await s.run(["daily", "--from", "2026-08-06", "--to", "2026-08-06", "--source", "cache"]);
    expect(r.code).not.toBe(0); // 离线无法联网刷新 → 明确报错,不静默产出缺数报表
    expect(r.json.error).toContain("离线"); // 报错明确提示离线/需联网
    expect(mock.requests.slice(before).length).toBe(0); // 0 网络请求:cache 源真离线,连 login 都不发
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

  test("缓存源:真离线 0 网络,读 efforts/ 聚合,任务名从缓存解析", async () => {
    const s = sb();
    s.write("cache", CACHE());
    s.write("efforts:100", { taskId: 100, fetchedAt: "2026-08-06T00:00:00", efforts: [
      { date: "2026-08-04", consumed: 1.5, work: "周一缓存记录" },
      { date: "2026-08-05", consumed: 1.5, work: "周二缓存记录" },
      { date: "2026-08-06", consumed: 1.5, work: "周三缓存记录" },
    ] });
    mock.setRoutes(withLogin(USER));
    const before = mock.requests.length;
    const r = await s.run(["weekly", "--from", "2026-08-04", "--to", "2026-08-06", "--source", "cache"]);
    expect(r.code).toBe(0);
    expect(r.json.text).toContain("周一缓存记录");
    expect(r.json.text).toContain("本周合计 4.5h");
    expect(r.json.text).toContain("T100"); // 任务名来自 cache.tasks,不联网
    expect(mock.requests.slice(before).length).toBe(0); // 0 网络:连 login 都不发
  }, 30000);

  test("缓存旧于最近提交 + cache 源(真离线)→ 明确报错,不静默产出缺数周报", async () => {
    const s = sb();
    s.write("cache", { ...CACHE(), fetchedAt: "2026-01-01T00:00:00" });
    s.write("submittedLog:2026-08-06", JSON.stringify({ ts: "2026-08-06T12:00:00", date: "2026-08-06", session: "s1", hours: 1, task: 100, work: "刚提交的" }) + "\n");
    const before = mock.requests.length;
    const r = await s.run(["weekly", "--from", "2026-08-04", "--to", "2026-08-06", "--source", "cache"]);
    expect(r.code).not.toBe(0);
    expect(r.json.error).toContain("离线");
    expect(mock.requests.slice(before).length).toBe(0);
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

  test("缓存源:真离线 0 网络,自动算上周窗口读 efforts/", async () => {
    const s = sb();
    s.write("cache", CACHE());
    // 与 zentao 源版同样铺满近 16 天(覆盖任意上周窗口),断言不依赖具体日期
    s.write("efforts:100", { taskId: 100, fetchedAt: "2026-08-06T00:00:00", efforts: Array.from({ length: 16 }, (_, i) => {
      const d = new Date(Date.now() - i * 86400e3).toISOString().slice(0, 10);
      return { date: d, consumed: 1, work: `缓存day-${d}` };
    }) });
    mock.setRoutes(withLogin(USER));
    const before = mock.requests.length;
    const r = await s.run(["lastweek", "--source", "cache"]);
    expect(r.code).toBe(0);
    expect(r.json.title).toMatch(/^周报 \d{4}-\d{2}-\d{2} ~ \d{4}-\d{2}-\d{2}$/);
    expect(r.json.empty).toBe(false);
    expect(r.json.text).toContain("本周合计 7h"); // 上周整周 7 天 × 1h,读缓存
    expect(mock.requests.slice(before).length).toBe(0); // 0 网络
  }, 30000);

  test("缓存旧于最近提交 + cache 源(真离线)→ 明确报错", async () => {
    const s = sb();
    s.write("cache", { ...CACHE(), fetchedAt: "2026-01-01T00:00:00" });
    // 与铺 16 天 efforts 同理:近 16 天每天都写一笔流水 → 任意上周窗口必命中 stale(日期生成在 runner 侧,跨进程时区差 8h 也不偏)
    for (let i = 0; i < 16; i++) {
      const d = new Date(Date.now() - i * 86400e3).toISOString().slice(0, 10);
      s.write(`submittedLog:${d}`, JSON.stringify({ ts: `${d}T23:59:00`, date: d, session: "s1", hours: 1, task: 100, work: "刚提交的" }) + "\n");
    }
    const before = mock.requests.length;
    const r = await s.run(["lastweek", "--source", "cache"]);
    expect(r.code).not.toBe(0);
    expect(r.json.error).toContain("离线");
    expect(mock.requests.slice(before).length).toBe(0);
  }, 30000);
});
