/** zentao.ts 本地命令端到端(不联网):config / collect / note / prepare / learn / mappings / mark / render。
 *  走真实 CLI 子进程(main 分发 + parseArgs + die 路径),沙箱隔离见 cli-harness。
 *  collect 的 daemon 可达分支(127.0.0.1:36666 端口硬编码)无法在不绑端口的前提下注入,
 *  这里只覆盖 token 缺失 / daemon 拒访两条静默路径;映射层 toZenSession 已有 transcript.test.ts 单测。 */
import { describe, test, expect, afterAll } from "bun:test";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { sandbox, cleanupSandboxes } from "./cli-harness";

// 安全校验:测试跑完真实项目数据不得出现假 session id(plan.test.ts 同款守卫,双保险)
const REAL_PROJ = "C:/Users/ren/AppData/Local/shine-worklog/zenpilot/projects/C--Users-ren-Desktop-workspace-livesetting";
afterAll(() => {
  cleanupSandboxes();
  let sessions = "", summary = "";
  try { sessions = readFileSync(path.join(REAL_PROJ, "sessions.json"), "utf8"); } catch {}
  try { summary = readFileSync(path.join(REAL_PROJ, "summary-2026-08-06.json"), "utf8"); } catch {}
  if (/"id": "s\d/.test(sessions)) throw new Error("污染!真实 sessions 出现假 s* id");
  if (/"session": "s\d"/.test(summary)) throw new Error("污染!真实 summary 出现假 s* session");
});

const CACHE = { projects: [{ id: 1, name: "P1" }], tasks: [{ id: 100, name: "T100", project: 1, status: "doing", left: 8 }], executions: [], taskDetails: {} };
const SESSIONS = (arr: any[]) => ({ date: "2026-08-06", sessions: arr });

describe("config 命令", () => {
  test("写四字段:尾斜杠剥/projectIds 解析/密码落盘明文但输出脱敏", async () => {
    const s = sandbox();
    const r = await s.run(["config", "--url", "https://zt.example.com///", "--account", "me", "--password", "secret", "--projects", "1, 2"]);
    expect(r.code).toBe(0);
    expect(r.json.config).toEqual({ url: "https://zt.example.com", account: "me", password: "***", projectIds: [1, 2] });
    expect(r.json.missing).toEqual([]);
    expect(s.read("config")).toEqual({ url: "https://zt.example.com", account: "me", password: "secret", projectIds: [1, 2] }); // 落盘明文(权限 600)
  }, 20000);

  test("--show 只读:无文件不创建,missing 列全", async () => {
    const s = sandbox();
    const r = await s.run(["config", "--show"]);
    expect(r.code).toBe(0);
    expect(s.exists("config")).toBe(false); // show 不写
    expect(r.json.missing).toEqual(["url", "account", "password"]);
  }, 20000);

  test("增量合并:已写 url 再补 account,url 保留", async () => {
    const s = sandbox();
    await s.run(["config", "--url", "https://a"]);
    const r = await s.run(["config", "--account", "a2"]);
    expect(r.code).toBe(0);
    expect(s.read("config")).toEqual({ url: "https://a", account: "a2" });
  }, 20000);
});

describe("collect 命令(hook 模式,daemon 不可达)", () => {
  test("无 daemon.pid(token 读不到)→ skipped,不写 sessions.json", async () => {
    const s = sandbox();
    const r = await s.run(["collect"]);
    expect(r.code).toBe(0);
    expect(r.json.mode).toBe("hook");
    expect(r.json.skipped).toBe("daemon token unavailable");
    expect(s.exists("sessions")).toBe(false); // hook 静默:不留半成品
  }, 20000);

  test("有 daemon.pid 但 daemon 拒访(假 token 401/连接拒绝)→ skipped daemon fetch failed", async () => {
    const s = sandbox();
    s.write("daemonPid", { pid: 1, token: "x".repeat(24) });
    const r = await s.run(["collect"]);
    expect(r.code).toBe(0);
    expect(r.json.mode).toBe("hook");
    expect(r.json.skipped).toBe("daemon fetch failed");
    expect(s.exists("sessions")).toBe(false);
  }, 20000);
});

describe("note 命令", () => {
  test("缺 --work → die 缺少必填参数", async () => {
    const s = sandbox();
    const r = await s.run(["note", "--task", "100"]);
    expect(r.code).toBe(1);
    expect(r.json.error).toContain("缺少必填参数");
    expect(r.json.error).toContain("--work");
  }, 20000);

  test("显式 --session/--task:cache 补全 taskName/projectName + 拍水位,静默无输出", async () => {
    const s = sandbox();
    s.write("cache", CACHE);
    s.write("sessions", SESSIONS([{ id: "s1", repo: "r", branch: "main", activeMinutes: 60, start: "09:00", end: "10:00" }]));
    const r = await s.run(["note", "--session", "s1", "--work", "完成A", "--task", "100"]);
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toBe(""); // 设计为静默
    const notes = s.read("summary:2026-08-06");
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ session: "s1", work: "完成A", task: 100, taskName: "T100", project: 1, projectName: "P1", notedActiveMinutes: 60 });
  }, 20000);

  test("--task -1 → inferProjectTask 项目历史回退(防 AI 偷懒传 -1 丢归属)", async () => {
    const s = sandbox();
    s.write("cache", CACHE);
    s.write("sessions", SESSIONS([{ id: "s2", repo: "r", branch: "main", activeMinutes: 30, start: "09:00", end: "09:30" }]));
    s.write("submitted", { "2026-08-06": { other: { tasks: [100], hours: 1, minutes: 60 } } });
    const r = await s.run(["note", "--session", "s2", "--work", "B", "--task", "-1"]);
    expect(r.code).toBe(0);
    expect(s.read("summary:2026-08-06")[0].task).toBe(100);
  }, 20000);
});

describe("prepare 命令(纯本地,不联网)", () => {
  test("无 cache.json → needs_cache 提示先 refresh", async () => {
    const s = sandbox();
    s.write("sessions", SESSIONS([]));
    const r = await s.run(["prepare"]);
    expect(r.code).toBe(0);
    expect(r.json.action).toBe("needs_cache");
    expect(r.json.hint).toContain("refresh");
  }, 20000);

  test("全 resolved(有 note)→ ready,条目带 task/hours", async () => {
    const s = sandbox();
    s.write("cache", CACHE);
    s.write("sessions", SESSIONS([{ id: "s1", repo: "r", branch: "main", activeMinutes: 60, start: "09:00", end: "10:00" }]));
    s.write("summary:2026-08-06", [{ session: "s1", work: "完成A", task: 100, notedActiveMinutes: 60, taskName: "T100", project: 1, projectName: "P1" }]);
    const r = await s.run(["prepare"]);
    expect(r.code).toBe(0);
    expect(r.json.action).toBe("ready");
    expect(r.json.summary).toEqual({ totalSessions: 1, ready: 1, pending: 0 });
    expect(r.json.ready[0]).toMatchObject({ session: "s1", task: 100, taskName: "T100", hours: 1 });
  }, 20000);

  test("无 note 会话 → prepare_needed:pending 带 candidates,signals/transcript 双 null(daemon 不可达+无 jsonl)", async () => {
    const s = sandbox();
    s.write("cache", CACHE);
    s.write("sessions", SESSIONS([{ id: "s1", repo: "r", branch: "main", activeMinutes: 60, start: "09:00", end: "10:00", summary: "做某功能" }]));
    const r = await s.run(["prepare"]);
    expect(r.code).toBe(0);
    expect(r.json.action).toBe("prepare_needed");
    const p = r.json.pending[0];
    expect(p).toMatchObject({ session: "s1", status: "needs_semantic", submittedState: "unsubmitted", daemonSummary: "做某功能" });
    expect(p.candidates.map((c: any) => c.id)).toEqual([100]);
    expect(p.signals).toBeNull();
    expect(p.transcript).toBeNull();
  }, 20000);
});

describe("learn / mappings 命令", () => {
  test("learn repo→project,再 learn branch→task,两级映射共存", async () => {
    const s = sandbox();
    const r1 = await s.run(["learn", "--repo", "r1", "--project", "5"]);
    expect(r1.code).toBe(0);
    expect(r1.json.repoToProject).toEqual({ r1: 5 });
    const r2 = await s.run(["learn", "--repo", "r1", "--branch", "feat", "--task", "7"]);
    expect(r2.code).toBe(0);
    expect(s.read("mappings")).toEqual({ repoToProject: { r1: 5 }, branchToTask: { "r1:feat": 7 } });
  }, 20000);

  test("mappings 列表带 projectName;--forget-repo 删除;删不存在的 die", async () => {
    const s = sandbox();
    s.write("mappings", { repoToProject: { r1: 5, r2: 6 }, branchToTask: {}, projectNames: { "5": "P5" } });
    const list = await s.run(["mappings"]);
    expect(list.json.repoToProject).toEqual([
      { repo: "r1", project: 5, projectName: "P5" },
      { repo: "r2", project: 6, projectName: null },
    ]);
    const del = await s.run(["mappings", "--forget-repo", "r1"]);
    expect(del.code).toBe(0);
    expect(del.json.repoToProject.map((x: any) => x.repo)).toEqual(["r2"]);
    const ghost = await s.run(["mappings", "--forget-repo", "ghost"]);
    expect(ghost.code).toBe(1);
    expect(ghost.json.error).toContain("映射不存在");
  }, 20000);
});

describe("mark 命令(AI 提交标识)", () => {
  test("无参只读:返回默认值(开+默认文案),不写 settings.json", async () => {
    const s = sandbox();
    const r = await s.run(["mark"]);
    expect(r.code).toBe(0);
    expect(r.json.aiSubmitMark).toEqual({ enabled: true, text: "本次内容由AI填报" });
    expect(s.exists("settings")).toBe(false);
  }, 20000);

  test("--off → 关;--text 改文案;--on 再开(状态累积)", async () => {
    const s = sandbox();
    const off = await s.run(["mark", "--off"]);
    expect(off.json.aiSubmitMark.enabled).toBe(false);
    const txt = await s.run(["mark", "--text", "[AI代报]"]);
    expect(txt.json.aiSubmitMark).toEqual({ enabled: false, text: "[AI代报]" });
    const on = await s.run(["mark", "--on"]);
    expect(on.json.aiSubmitMark).toEqual({ enabled: true, text: "[AI代报]" });
    expect(s.read("settings").aiSubmitMark).toEqual({ enabled: true, text: "[AI代报]" });
  }, 20000);
});

describe("render 命令", () => {
  const resolvedItem = (over: any = {}) => ({
    session: "s1", repo: "r", branch: "main", date: "2026-08-06", start: "09:00", end: "10:00",
    minutes: 60, hours: 1, summary: "", meta: false, increment: false, status: "resolved",
    task: 100, taskName: "T100", project: 1, projectName: "P1", work: "做A;做B\n做C",
    confidence: 100, reason: "测试", ...over,
  });

  test("无 plan.json → die 计划不存在", async () => {
    const s = sandbox();
    const r = await s.run(["render"]);
    expect(r.code).toBe(1);
    expect(r.json.error).toContain("计划不存在");
  }, 20000);

  test("plan.json 滞后(note 已写齐)→ 自动本地重 plan 再渲染;draftSeq 逐次递增", async () => {
    const s = sandbox();
    s.write("cache", CACHE);
    s.write("sessions", SESSIONS([{ id: "s1", repo: "r", branch: "main", activeMinutes: 60, start: "09:00", end: "10:00" }]));
    s.write("summary:2026-08-06", [{ session: "s1", work: "note 补的文案", task: 100, notedActiveMinutes: 60, taskName: "T100", project: 1, projectName: "P1" }]);
    s.write("plan", { date: "2026-08-06", draftSeq: 3, items: [{ session: "s1", status: "needs_semantic", work: null }] }); // 滞后:还挂着 pending
    const r1 = await s.run(["render"]);
    expect(r1.code).toBe(0);
    expect(r1.stdout).toContain("工时草稿 #ZR-20260806-004"); // 3→4
    expect(r1.stdout).toContain("note 补的文案"); // replan 后 work 来自 note
    expect(s.read("plan").items[0].status).toBe("resolved"); // plan.json 被重写补齐
    const r2 = await s.run(["render"]);
    expect(r2.stdout).toContain("#ZR-20260806-005"); // 再 render 继续 +1(draftSeq 跨 render 保留)
  }, 20000);

  test("replan 后仍 needs_semantic(无 note 无分支号)→ die 尚有会话未完成归属", async () => {
    const s = sandbox();
    s.write("cache", CACHE);
    s.write("sessions", SESSIONS([{ id: "s1", repo: "r", branch: "main", activeMinutes: 60, start: "09:00", end: "10:00" }]));
    s.write("plan", { date: "2026-08-06", draftSeq: 0, items: [{ session: "s1", status: "needs_semantic", work: null }] });
    const r = await s.run(["render"]);
    expect(r.code).toBe(1);
    expect(r.json.error).toContain("尚有会话未完成归属");
    expect(r.json.sessions).toContain("s1");
  }, 20000);

  test("replan 后 resolved 缺 work(分支号归属但无 note)→ die 缺少 work 字段", async () => {
    const s = sandbox();
    s.write("cache", CACHE);
    s.write("sessions", SESSIONS([{ id: "s1", repo: "r", branch: "task-100", activeMinutes: 60, start: "09:00", end: "10:00" }]));
    s.write("plan", { date: "2026-08-06", draftSeq: 0, items: [{ session: "s1", status: "resolved", work: null }] });
    const r = await s.run(["render"]);
    expect(r.code).toBe(1);
    expect(r.json.error).toContain("缺少 work 字段");
  }, 20000);

  test("work 多条(;/；/\\n 混排)→ 逐行编号;skipped 条目单列;补报条目带 [补 MM-DD]", async () => {
    const s = sandbox();
    s.write("plan", {
      date: "2026-08-06", draftSeq: 0,
      items: [
        resolvedItem(),
        resolvedItem({ session: "s2", date: "2026-08-05", start: "17:00", end: "18:00", hours: 0.5, work: "昨天漏报的活" }),
        { session: "s3", status: "skipped", repo: "r", branch: "main", date: "2026-08-06", start: "11:00", end: "12:00", hours: 1, skipReason: "用户选择剔除" },
      ],
    });
    const r = await s.run(["render"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("    内容:"); // 多条 → 编号列表
    expect(r.stdout).toContain("1. 做A");
    expect(r.stdout).toContain("2. 做B");
    expect(r.stdout).toContain("3. 做C");
    expect(r.stdout).toContain("[补 08-05] 17:00—18:00,0.5小时"); // 补报前缀
    expect(r.stdout).toContain("跳过(不提交)");
    expect(r.stdout).toContain("用户选择剔除");
    expect(r.stdout.trimEnd().endsWith("状态:未提交")).toBe(true);
  }, 20000);

  test("增量条目显示「新增 Nmin」消歧(时间窗=全会话,工时只算增量;老 plan 无 deltaMinutes 维持原样)", async () => {
    const s = sandbox();
    s.write("plan", { date: "2026-08-06", draftSeq: 0, items: [
      resolvedItem({ start: "11:33", end: "13:16", minutes: 103, hours: 0.5, increment: true, deltaMinutes: 32 }),
      resolvedItem({ session: "s2", start: "09:00", end: "10:00", hours: 0.5, increment: true }), // 老 plan 无 deltaMinutes
    ] });
    const r = await s.run(["render"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("11:33—13:16,新增 32min,0.5小时(增量)");
    expect(r.stdout).toContain("09:00—10:00,0.5小时(增量)"); // 无 deltaMinutes 不拼「新增」,不炸
  }, 20000);

  test("items 为空(全已提交)→ 本次无可提交条目,仍正常渲染", async () => {
    const s = sandbox();
    s.write("plan", { date: "2026-08-06", draftSeq: 0, items: [] });
    const r = await s.run(["render"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("本次无可提交条目");
    expect(r.stdout).toContain("状态:未提交");
  }, 20000);
});

describe("入口错误路径", () => {
  test("无命令 → die 用法提示(runRaw:die 在读任何文件前退出,无需 --cwd)", async () => {
    const s = sandbox();
    const r = await s.runRaw([]);
    expect(r.code).toBe(1);
    expect(r.json.error).toContain("用法");
  }, 20000);
});
