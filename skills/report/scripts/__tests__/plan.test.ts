import { describe, test, expect, afterAll } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

// 主进程绝不 import shared/zentao(杜绝模块缓存污染)。每个测试起独立子进程跑 cmdPlan。
const RUNNER = path.join(import.meta.dir, "plan-runner.ts");
const REAL_PROJ = "C:/Users/ren/AppData/Local/shine-worklog/zenpilot/projects/C--Users-ren-Desktop-workspace-livesetting";

// 安全校验:跑后真实数据不得出现假 session id(s1-s9 fixture 痕迹)。
// 不要求内容完全不变(daemon 会更新 activeMinutes),只查污染标志。
afterAll(() => {
  let sessions = "", summary = "";
  try { sessions = readFileSync(path.join(REAL_PROJ, "sessions.json"), "utf8"); } catch {}
  try { summary = readFileSync(path.join(REAL_PROJ, "summary-2026-08-06.json"), "utf8"); } catch {}
  if (/"id": "s\d"/.test(sessions)) throw new Error("污染!真实 sessions 出现假 s* id");
  if (/"session": "s\d"/.test(summary)) throw new Error("污染!真实 summary 出现假 s* session");
});

const runPlan = async (fixtures: any) => {
  const tmp = mkdtempSync(path.join(tmpdir(), "zen-plan-"));
  const inputPath = path.join(tmp, "input.json");
  writeFileSync(inputPath, JSON.stringify({ claudDir: tmp, localAppDir: tmp, fixtures }));
  const proc = Bun.spawn(["bun", "run", RUNNER, inputPath], { stdout: "pipe", stderr: "pipe" });
  const out = await new Response(proc.stdout).text();
  const err = await new Response(proc.stderr).text();
  const code = await proc.exited;
  rmSync(tmp, { recursive: true, force: true });
  if (code !== 0) throw new Error("runner exit " + code + ": " + err);
  const r = JSON.parse(out.trim().split("\n").pop()!);
  if (!r.ok) throw new Error("cmdPlan error: " + r.error);
  return r.items as any[];
};

describe("cmdPlan — 已提交会话", () => {
  test("delta<15 → already", async () => {
    const items = await runPlan({
      sessions: [{ id: "s1", repo: "r", branch: "main", activeMinutes: 60, start: "09:00", end: "10:00" }],
      submitted: { "2026-08-06": { s1: { tasks: [100], hours: 1, minutes: 55 } } },
      cache: { projects: [{ id: 1, name: "P1" }], tasks: [{ id: 100, name: "T1", project: 1 }], executions: [], taskDetails: {} },
    });
    expect(items[0].status).toBe("already");
    expect(items[0].task).toBe(100);
    expect(items[0].submittedHours).toBe(1);
    expect(items[0].taskName).toBe("T1");
  });

  test("delta≥15 + 有新 note → increment resolved", async () => {
    const items = await runPlan({
      sessions: [{ id: "s2", repo: "r", branch: "main", activeMinutes: 120, start: "09:00", end: "11:00" }],
      submitted: { "2026-08-06": { s2: { tasks: [100], hours: 1, minutes: 60 } } },
      summaries: { "2026-08-06": [{ session: "s2", work: "增量工作", task: 100, notedActiveMinutes: 90 }] },
      cache: { projects: [{ id: 1, name: "P1" }], tasks: [{ id: 100, name: "T1", project: 1 }], executions: [], taskDetails: {} },
    });
    expect(items[0].status).toBe("resolved");
    expect(items[0].increment).toBe(true);
    expect(items[0].task).toBe(100);
    expect(items[0].hours).toBe(1); // hoursFromMinutes(120-60=60)=1
    expect(items[0].work).toBe("增量工作");
    expect(items[0].reason).toContain("增量补报");
  });

  test("delta≥15 + 无新 note → increment 但 work=null", async () => {
    const items = await runPlan({
      sessions: [{ id: "s2", repo: "r", branch: "main", activeMinutes: 120, start: "09:00", end: "11:00" }],
      submitted: { "2026-08-06": { s2: { tasks: [100], hours: 1, minutes: 60 } } },
      summaries: { "2026-08-06": [{ session: "s2", work: "旧 note", task: 100, notedActiveMinutes: 30 }] },
      cache: { projects: [{ id: 1, name: "P1" }], tasks: [{ id: 100, name: "T1", project: 1 }], executions: [], taskDetails: {} },
    });
    expect(items[0].status).toBe("resolved");
    expect(items[0].increment).toBe(true);
    expect(items[0].work).toBeNull();
  });
});

describe("cmdPlan — summary 多 note 水位拆分", () => {
  test("全有水位 → 按段拆成多 item", async () => {
    const items = await runPlan({
      sessions: [{ id: "s3", repo: "r", branch: "main", activeMinutes: 120, start: "09:00", end: "11:00" }],
      submitted: {},
      summaries: { "2026-08-06": [
        { session: "s3", work: "A", task: 100, notedActiveMinutes: 40 },
        { session: "s3", work: "B", task: 200, notedActiveMinutes: 80 },
      ] },
      cache: { projects: [{ id: 1, name: "P1" }], tasks: [
        { id: 100, name: "T1", project: 1 }, { id: 200, name: "T2", project: 1 },
      ], executions: [], taskDetails: {} },
    });
    expect(items.length).toBe(2);
    expect(items[0].task).toBe(100);
    expect(items[0].work).toBe("A");
    expect(items[0].minutes).toBe(40);
    expect(items[1].task).toBe(200);
    expect(items[1].work).toBe("B");
    expect(items[1].minutes).toBe(120);
  });

  test("0 工时会话 → 跳过(不产 item)", async () => {
    const items = await runPlan({
      sessions: [{ id: "s4", repo: "r", branch: "main", activeMinutes: 0 }],
      summaries: { "2026-08-06": [{ session: "s4", work: "x", task: 100, notedActiveMinutes: 0 }] },
    });
    expect(items.length).toBe(0);
  });
});

describe("cmdPlan — 分支/映射/语义", () => {
  test("分支名 task-(\\d+) → resolved", async () => {
    const items = await runPlan({
      sessions: [{ id: "s5", repo: "r", branch: "task-789", activeMinutes: 60, start: "09:00", end: "10:00" }],
      submitted: {},
    });
    expect(items[0].status).toBe("resolved");
    expect(items[0].task).toBe(789);
    expect(items[0].reason).toContain("分支名含任务号");
  });

  test("branchToTask 映射 → resolved", async () => {
    const items = await runPlan({
      sessions: [{ id: "s6", repo: "r", branch: "feature-x", activeMinutes: 60, start: "09:00", end: "10:00" }],
      mappings: { repoToProject: {}, branchToTask: { "r:feature-x": 555 } },
    });
    expect(items[0].status).toBe("resolved");
    expect(items[0].task).toBe(555);
    expect(items[0].reason).toContain("branchToTask");
  });

  test("无任何线索 → needs_semantic(候选=全部任务)", async () => {
    const items = await runPlan({
      sessions: [{ id: "s7", repo: "r", branch: "main", activeMinutes: 60, start: "09:00", end: "10:00" }],
      mappings: { repoToProject: {}, branchToTask: {} },
      cache: { projects: [{ id: 1, name: "P1" }], tasks: [
        { id: 100, name: "T1", project: 1 }, { id: 200, name: "T2", project: 2 },
      ], executions: [], taskDetails: {} },
    });
    expect(items[0].status).toBe("needs_semantic");
    expect(items[0].candidates.length).toBe(2);
  });

  test("repoToProject 收窄候选", async () => {
    const items = await runPlan({
      sessions: [{ id: "s8", repo: "r", branch: "main", activeMinutes: 60, start: "09:00", end: "10:00" }],
      mappings: { repoToProject: { r: 1 }, branchToTask: {} },
      cache: { projects: [{ id: 1, name: "P1" }, { id: 2, name: "P2" }], tasks: [
        { id: 100, name: "T1", project: 1 }, { id: 200, name: "T2", project: 2 },
      ], executions: [], taskDetails: {} },
    });
    expect(items[0].status).toBe("needs_semantic");
    expect(items[0].candidates.map((c: any) => c.id)).toEqual([100]);
    expect(items[0].reason).toContain("仓库映射到项目 1");
  });
});

describe("cmdPlan — 跨午夜", () => {
  test("提交水位在昨天 date key 仍能识别 → increment", async () => {
    const items = await runPlan({
      date: "2026-08-06",
      sessions: [{ id: "s9", repo: "r", branch: "main", activeMinutes: 120, start: "20:00", end: "22:00" }],
      submitted: { "2026-08-05": { s9: { tasks: [100], hours: 1, minutes: 50 } } },
      summaries: { "2026-08-06": [{ session: "s9", work: "跨夜新增", task: 100, notedActiveMinutes: 80 }] },
      cache: { projects: [{ id: 1, name: "P1" }], tasks: [{ id: 100, name: "T1", project: 1 }], executions: [], taskDetails: {} },
    });
    expect(items[0].status).toBe("resolved");
    expect(items[0].increment).toBe(true);
    expect(items[0].hours).toBe(1); // hoursFromMinutes(120-50=70)=1
    expect(items[0].work).toBe("跨夜新增");
  });
});

describe("cmdPlan — task=-1 unmatched", () => {
  test("summary note task=-1 → unmatched + candidates", async () => {
    const items = await runPlan({
      sessions: [{ id: "s10", repo: "r", branch: "main", activeMinutes: 60, start: "09:00", end: "10:00" }],
      submitted: {},
      summaries: { "2026-08-06": [{ session: "s10", work: "待匹配工作", task: -1, notedActiveMinutes: 60 }] },
      mappings: { repoToProject: { r: 1 }, branchToTask: {} },
      cache: { projects: [{ id: 1, name: "P1" }], tasks: [
        { id: 100, name: "T1", project: 1 }, { id: 200, name: "T2", project: 1 },
      ], executions: [], taskDetails: {} },
    });
    expect(items[0].status).toBe("unmatched");
    expect(items[0].task).toBe(-1);
    expect(items[0].work).toBe("待匹配工作");
    expect(items[0].candidates.map((c: any) => c.id)).toEqual([100, 200]);
    expect(items[0].reason).toContain("task=-1");
  });

  test("多 note 混合 task>0 与 task=-1 → resolved + unmatched 各一", async () => {
    const items = await runPlan({
      sessions: [{ id: "s11", repo: "r", branch: "main", activeMinutes: 120, start: "09:00", end: "11:00" }],
      submitted: {},
      summaries: { "2026-08-06": [
        { session: "s11", work: "确定任务部分", task: 100, notedActiveMinutes: 50 },
        { session: "s11", work: "不确定部分", task: -1, notedActiveMinutes: 100 },
      ] },
      mappings: { repoToProject: { r: 1 }, branchToTask: {} },
      cache: { projects: [{ id: 1, name: "P1" }], tasks: [
        { id: 100, name: "T1", project: 1 }, { id: 200, name: "T2", project: 1 },
      ], executions: [], taskDetails: {} },
    });
    expect(items.length).toBe(2);
    expect(items[0].status).toBe("resolved");
    expect(items[0].task).toBe(100);
    expect(items[1].status).toBe("unmatched");
    expect(items[1].task).toBe(-1);
    expect(items[1].candidates.map((c: any) => c.id)).toEqual([100, 200]);
  });

  test("增量补报含 task=-1 note → 沿用原 task(已提交会话已归属)", async () => {
    const items = await runPlan({
      sessions: [{ id: "s12", repo: "r", branch: "main", activeMinutes: 120, start: "09:00", end: "11:00" }],
      submitted: { "2026-08-06": { s12: { tasks: [100], hours: 1, minutes: 60 } } },
      summaries: { "2026-08-06": [{ session: "s12", work: "不确定的增量", task: -1, notedActiveMinutes: 90 }] },
      mappings: { repoToProject: { r: 1 }, branchToTask: {} },
      cache: { projects: [{ id: 1, name: "P1" }], tasks: [{ id: 100, name: "T1", project: 1 }], executions: [], taskDetails: {} },
    });
    // increment 沿用原 task(100):会话已归属,note 的 task=-1(不确定)用已知归属
    expect(items[0].status).toBe("resolved");
    expect(items[0].increment).toBe(true);
    expect(items[0].task).toBe(100);
  });
});

describe("cmdPlan — 碎 note 膨胀合并", () => {
  test("小会话多 note 拆段总>整 session → 合并单 item(工时不膨胀)", async () => {
    const items = await runPlan({
      sessions: [{ id: "s13", repo: "r", branch: "main", activeMinutes: 18, start: "09:00", end: "09:18" }],
      submitted: {},
      summaries: { "2026-08-06": [
        { session: "s13", work: "A", task: 100, notedActiveMinutes: 5 },
        { session: "s13", work: "B", task: 100, notedActiveMinutes: 10 },
        { session: "s13", work: "C", task: 100, notedActiveMinutes: 15 },
      ] },
      cache: { projects: [{ id: 1, name: "P1" }], tasks: [{ id: 100, name: "T1", project: 1 }], executions: [], taskDetails: {} },
    });
    expect(items.length).toBe(1); // 合并成 1 个(不拆 3 段膨胀)
    expect(items[0].hours).toBe(0.5); // 整 session(18min→0.5h),不是 1.5h
    expect(items[0].task).toBe(100);
    expect(items[0].work).toContain("A");
    expect(items[0].work).toContain("C"); // work join 所有 note
    expect(items[0].reason).toContain("合并");
  });

  test("大会话多 note 不膨胀 → 正常拆段(不误合并)", async () => {
    const items = await runPlan({
      sessions: [{ id: "s14", repo: "r", branch: "main", activeMinutes: 120, start: "09:00", end: "11:00" }],
      submitted: {},
      summaries: { "2026-08-06": [
        { session: "s14", work: "A", task: 100, notedActiveMinutes: 60 },
        { session: "s14", work: "B", task: 200, notedActiveMinutes: 90 },
      ] },
      mappings: { repoToProject: {}, branchToTask: {} },
      cache: { projects: [{ id: 1, name: "P1" }], tasks: [
        { id: 100, name: "T1", project: 1 }, { id: 200, name: "T2", project: 1 },
      ], executions: [], taskDetails: {} },
    });
    // 120min 拆 2 段各 60min=1h,总 2h=整 session,不膨胀 → 正常拆 2 item
    expect(items.length).toBe(2);
    expect(items[0].hours).toBe(1);
    expect(items[1].hours).toBe(1);
  });
});
