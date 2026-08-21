import { describe, test, expect, afterAll } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { unionMinutes, hhmmToMin, minToHHMM } from "../zentao";

describe("unionMinutes(时间区间并集,元会话聚合用)", () => {
  test("重叠区间去重", () => {
    expect(unionMinutes([[585, 597], [594, 606], [626, 641]])).toEqual({ total: 36, first: 585, last: 641 });
  });
  test("完全包含/相邻段", () => {
    expect(unionMinutes([[600, 660], [610, 620]]).total).toBe(60); // 包含
    expect(unionMinutes([[600, 630], [630, 660]]).total).toBe(60); // 相接
    expect(unionMinutes([[600, 630], [700, 720]]).total).toBe(50); // 分离
  });
  test("非法区间忽略/空", () => {
    expect(unionMinutes([]).total).toBe(0);
    expect(unionMinutes([[NaN, 10]]).total).toBe(0);
  });
  test("hhmmToMin/minToHHMM 互转", () => {
    expect(hhmmToMin("09:45")).toBe(585);
    expect(hhmmToMin("bad")).toBeNaN();
    expect(minToHHMM(641)).toBe("10:41");
  });
});

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

const runPlanFull = async (fixtures: any): Promise<any> => {
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
  return r;
};
const runPlan = async (fixtures: any) => (await runPlanFull(fixtures)).items as any[];

describe("cmdPlan — 已提交会话", () => {
  test("delta<15 → 已提交条目不进 items,仅 alreadyCount 计数(08-18 用户定:流程不复述已提交)", async () => {
    const r = await runPlanFull({
      sessions: [{ id: "s1", repo: "r", branch: "main", activeMinutes: 60, start: "09:00", end: "10:00" }],
      submitted: { "2026-08-06": { s1: { tasks: [100], hours: 1, minutes: 55 } } },
      cache: { projects: [{ id: 1, name: "P1" }], tasks: [{ id: 100, name: "T1", project: 1 }], executions: [], taskDetails: {} },
    });
    expect(r.items.length).toBe(0); // 不出现在草稿/汇报的任何环节
    expect(r.alreadyCount).toBe(1); // 仅计数留排查
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
    expect(items[0].deltaMinutes).toBe(60); // 增量原始分钟(render 显示「新增 Nmin」用)
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

  test("mappings 缺失 key(历史 `{}` 残留)→ loadMappings 补默认不崩", async () => {
    const items = await runPlan({
      sessions: [{ id: "s9", repo: "r", branch: "main", activeMinutes: 60, start: "09:00", end: "10:00" }],
      mappings: {}, // 缺 repoToProject/branchToTask:loadMappings 必须补默认而不是读 undefined 崩
      cache: { projects: [{ id: 1, name: "P1" }], tasks: [{ id: 100, name: "T1", project: 1 }], executions: [], taskDetails: {} },
    });
    expect(items[0].status).toBe("needs_semantic");
    expect(items[0].candidates.map((c: any) => c.id)).toEqual([100]); // 空 repoToProject → 不收窄,候选=全部
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

  test("增量水位严格大于:note 水位 == 提交水位的旧 note 不混入(08-15 踩坑回归)", async () => {
    const items = await runPlan({
      date: "2026-08-06",
      sessions: [{ id: "s13", repo: "r", branch: "main", activeMinutes: 140, start: "20:00", end: "22:20" }],
      // 已提交 rec.minutes=120(2h 取整回写);旧 note 水位恰为 120(已随上次提交)
      submitted: { "2026-08-06": { s13: { tasks: [100], hours: 2, minutes: 120 } } },
      summaries: { "2026-08-06": [
        { session: "s13", work: "已提交旧段", task: 100, notedActiveMinutes: 120 },
        { session: "s13", work: "真正新增", task: 100, notedActiveMinutes: 140 },
      ] },
      cache: { projects: [{ id: 1, name: "P1" }], tasks: [{ id: 100, name: "T1", project: 1 }], executions: [], taskDetails: {} },
    });
    expect(items[0].status).toBe("resolved");
    expect(items[0].increment).toBe(true);
    expect(items[0].hours).toBe(0.5); // 140-120=20min → 0.5h
    expect(items[0].work).toBe("真正新增"); // 旧段(水位==120)不混入
  });

  test("多条新 note → 合并旧→新(08-18 实测踩坑:单取最新丢增量区间内关键改动)", async () => {
    const items = await runPlan({
      sessions: [{ id: "s14", repo: "r", branch: "main", activeMinutes: 200, start: "09:00", end: "12:00" }],
      submitted: { "2026-08-06": { s14: { tasks: [100], hours: 1, minutes: 60 } } },
      summaries: { "2026-08-06": [
        { session: "s14", work: "已提交旧段", task: 100, notedActiveMinutes: 60 },
        { session: "s14", work: "完成多天补报功能收尾", task: 100, notedActiveMinutes: 90 },
        { session: "s14", work: "实现auto-note自动归纳功能", task: 100, notedActiveMinutes: 140 },
        { session: "s14", work: "实现auto-note自动归纳功能并通过全部测试", task: 100, notedActiveMinutes: 200 },
      ] },
      cache: { projects: [{ id: 1, name: "P1" }], tasks: [{ id: 100, name: "T1", project: 1 }], executions: [], taskDetails: {} },
    });
    // 旧段(水位==60)不混入;三条新 note 按时间合并,互含的只留长者
    expect(items[0].work).toBe("完成多天补报功能收尾\n实现auto-note自动归纳功能并通过全部测试");
  });

  test("增量多条 note 跨条重复行去重(十次踩坑:commit subject 在相邻窗口重复 → 回声行)", async () => {
    const items = await runPlan({
      sessions: [{ id: "s17", repo: "r", branch: "main", activeMinutes: 120, start: "09:00", end: "11:00" }],
      submitted: { "2026-08-06": { s17: { tasks: [100], hours: 1, minutes: 60 } } },
      summaries: { "2026-08-06": [
        { session: "s17", work: "已提交旧段", task: 100, notedActiveMinutes: 60 },
        { session: "s17", work: "做X\nauto-note 代码围栏状态机", task: 100, notedActiveMinutes: 80 },
        { session: "s17", work: "auto-note 代码围栏状态机\n做Z", task: 100, notedActiveMinutes: 120 },
      ] },
      cache: { projects: [{ id: 1, name: "P1" }], tasks: [{ id: 100, name: "T1", project: 1 }], executions: [], taskDetails: {} },
    });
    expect(items[0].increment).toBe(true);
    expect(items[0].work).toBe("做X\nauto-note 代码围栏状态机\n做Z"); // 跨 note 重复行只留一次
  });

  test("新 note 超过 MAX_INCREMENT_WORK_LINES → 保留最新 10 行 + 顶部省略标记", async () => {
    const notes = Array.from({ length: 12 }, (_, i) => ({
      session: "s15", work: `增量W${String(i + 1).padStart(2, "0")}`, task: 100, notedActiveMinutes: 70 + i * 10,
    }));
    const items = await runPlan({
      sessions: [{ id: "s15", repo: "r", branch: "main", activeMinutes: 200, start: "09:00", end: "12:00" }],
      submitted: { "2026-08-06": { s15: { tasks: [100], hours: 1, minutes: 60 } } },
      summaries: { "2026-08-06": notes },
      cache: { projects: [{ id: 1, name: "P1" }], tasks: [{ id: 100, name: "T1", project: 1 }], executions: [], taskDetails: {} },
    });
    expect(items[0].work).toBe(`…(更早 2 条略)\n${Array.from({ length: 10 }, (_, i) => `增量W${String(i + 3).padStart(2, "0")}`).join("\n")}`);
    // 折叠发生时附全部行(incrementAllLines),供 /report 的 AI 归纳替换折叠标记
    expect(items[0].incrementAllLines).toEqual(Array.from({ length: 12 }, (_, i) => `增量W${String(i + 1).padStart(2, "0")}`));
  });

  test("增量 note ≤ MAX_INCREMENT_WORK_LINES → 无折叠、不带 incrementAllLines", async () => {
    const notes = Array.from({ length: 10 }, (_, i) => ({
      session: "s16", work: `增量V${String(i + 1).padStart(2, "0")}`, task: 100, notedActiveMinutes: 70 + i * 10,
    }));
    const items = await runPlan({
      sessions: [{ id: "s16", repo: "r", branch: "main", activeMinutes: 200, start: "09:00", end: "12:00" }],
      submitted: { "2026-08-06": { s16: { tasks: [100], hours: 1, minutes: 60 } } },
      summaries: { "2026-08-06": notes },
      cache: { projects: [{ id: 1, name: "P1" }], tasks: [{ id: 100, name: "T1", project: 1 }], executions: [], taskDetails: {} },
    });
    expect(items[0].incrementAllLines).toBeUndefined();
    expect(items[0].work).not.toContain("更早");
  });
});

describe("cmdPlan — 多天补报(自上次提交以来)", () => {
  test("昨天未提交会话 → item.date=昨天(needs_semantic 带归属日)", async () => {
    const items = await runPlan({
      date: "2026-08-06",
      sessions: [{ id: "s20", repo: "r", branch: "main", date: "2026-08-05", activeMinutes: 60, start: "09:00", end: "10:00" }],
      submitted: {},
      mappings: { repoToProject: { r: 1 }, branchToTask: {} },
      cache: { projects: [{ id: 1, name: "P1" }], tasks: [{ id: 100, name: "T1", project: 1 }], executions: [], taskDetails: {} },
    });
    expect(items[0].status).toBe("needs_semantic");
    expect(items[0].date).toBe("2026-08-05"); // commit 按此提交禅道(补报记会话实际日)
  });

  test("昨天已提交会话水位后增量 → increment 且 item.date=昨天", async () => {
    const items = await runPlan({
      date: "2026-08-06",
      sessions: [{ id: "s21", repo: "r", branch: "main", date: "2026-08-05", activeMinutes: 374, start: "09:00", end: "17:07" }],
      submitted: { "2026-08-05": { s21: { tasks: [100], hours: 5.5, minutes: 336 } } },
      cache: { projects: [{ id: 1, name: "P1" }], tasks: [{ id: 100, name: "T1", project: 1 }], executions: [], taskDetails: {} },
    });
    expect(items[0].status).toBe("resolved");
    expect(items[0].increment).toBe(true);
    expect(items[0].hours).toBe(0.5); // 374-336=38min → 0.5h
    expect(items[0].date).toBe("2026-08-05"); // 增量归属会话日,不落今天
  });

  test("fallbackSid 今天优先:昨天的 end 更晚也不抢走 session=null 的 note", async () => {
    const items = await runPlan({
      date: "2026-08-06",
      sessions: [
        { id: "s22-yd", repo: "r", branch: "main", date: "2026-08-05", activeMinutes: 60, start: "16:00", end: "22:00" },
        { id: "s23-td", repo: "r", branch: "main", date: "2026-08-06", activeMinutes: 60, start: "09:00", end: "10:00" },
      ],
      submitted: {},
      summaries: { "2026-08-06": [{ session: null, work: "今天的note", task: 100, notedActiveMinutes: null }] },
      cache: { projects: [{ id: 1, name: "P1" }], tasks: [{ id: 100, name: "T1", project: 1 }], executions: [], taskDetails: {} },
    });
    const td = items.find((i: any) => i.session === "s23-td");
    expect(td).toBeDefined();
    expect(td.work).toBe("今天的note"); // 归今天的 session,不是 end 22:00 的昨天会话
  });

  test("跨天会话(昨天延续到今早,date=今天)→ 整体归今天(2026-08-20 已拍板)", async () => {
    // daemon toZenSession 已按 lastActive=今早 10:00 把跨天会话 date 归今天(昨天 19:00→今早 10:00,15h)
    const items = await runPlan({
      date: "2026-08-20",
      sessions: [{ id: "s25", repo: "r", branch: "main", date: "2026-08-20", activeMinutes: 900, start: "19:00", end: "10:00" }],
      submitted: {},
      summaries: { "2026-08-20": [{ session: "s25", work: "跨天完成Z", task: 100, notedActiveMinutes: 900 }] },
      cache: { projects: [{ id: 1, name: "P1" }], tasks: [{ id: 100, name: "T1", project: 1 }], executions: [], taskDetails: {} },
    });
    expect(items[0].date).toBe("2026-08-20"); // 整体归最后活跃日(今天),不拆昨天
    expect(items[0].hours).toBe(15); // 900min 全量计今天
  });

  test("老数据:会话无 date 字段 → item.date 兜底采集日", async () => {
    const items = await runPlan({
      date: "2026-08-06",
      sessions: [{ id: "s24", repo: "r", branch: "main", activeMinutes: 60, start: "09:00", end: "10:00" }],
      submitted: {},
    });
    expect(items[0].date).toBe("2026-08-06");
  });

  test("lastSubmitSinceEpoch:无提交回退今天 0 点;上次提交日 0 点;超 14 天 clamp", async () => {
    // 无记录 → 今天 0 点(runner 侧对照,主进程 TZ=UTC 不能比)
    const a = await runPlanFull({ date: "2026-08-06", sessions: [], submitted: {} });
    expect(a.sinceEpoch).toBe(a.midnightEpoch);
    // 最后提交 08-16 → 起点 = 08-16 0 点(含该日全天,增量靠水位判);ISO 在 runner 侧转好(主进程 TZ=UTC)
    const b = await runPlanFull({ date: "2026-08-06", sessions: [], submitted: { "2026-08-16": { x: { tasks: [1], hours: 1, minutes: 60 } } } });
    expect(b.sinceISO).toBe("2026-08-16");
    // 最后提交 3 个月前 → clamp 到 14 天前
    const c = await runPlanFull({ date: "2026-08-06", sessions: [], submitted: { "2026-05-01": { x: { tasks: [1], hours: 1, minutes: 60 } } } });
    expect(c.sinceEpoch).toBe(c.midnightEpoch - 14 * 86400_000);
  });
});

describe("cmdPlan — 元会话聚合(填报流程会话合并)", () => {
  // 元会话 fixture:daemon title(skill 展开路径)+ 小活跃时长
  const metaS = (id: string, start: string, end: string, activeMinutes: number, extra: any = {}) => ({
    id, repo: "r", branch: "main", date: "2026-08-06", start, end, activeMinutes,
    summary: `Base directory for this skill: C:\\x\\shine-worklog\\1.3.50\\skills\\report # 工时填报 ${id}`, ...extra,
  });

  test("3 个重叠 meta 会话 → 1 条 resolved,工时=时间轴并集,sourceSessions 保留", async () => {
    const items = await runPlan({
      date: "2026-08-06",
      sessions: [
        metaS("m1", "09:45", "09:57", 12),
        metaS("m2", "09:54", "10:06", 12),
        metaS("m3", "10:26", "10:41", 15),
      ],
      submitted: {},
      summaries: { "2026-08-06": [
        { session: "m1", work: "执行填报A", task: 100, notedActiveMinutes: 10 },
        { session: "m2", work: "执行填报B", task: 100, notedActiveMinutes: 10 },
      ] },
      cache: { projects: [{ id: 1, name: "P1" }], tasks: [{ id: 100, name: "T1", project: 1 }], executions: [], taskDetails: {} },
    });
    expect(items.length).toBe(1); // 聚合成一条
    const m = items[0];
    expect(m.status).toBe("resolved");
    expect(m.task).toBe(100);
    expect(m.work).toBe("执行 shine-worklog 工时填报流程"); // 固定文案,消重复标题
    expect(m.hours).toBe(0.5); // 并集 12+9+15=36min?→ [09:45-10:06]=21 + [10:26-10:41]=15 → 36min → 0.5h
    expect(m.start).toBe("09:45"); // 并集首尾
    expect(m.end).toBe("10:41");
    expect(m.sourceSessions.map((x: any) => x.session).sort()).toEqual(["m1", "m2", "m3"]); // m3 无 note 也并入
    expect(m.reason).toContain("3 会话");
  });

  test("不误伤:weekly 会话、≥45min 的 report 会话、已提交 meta 均不并入", async () => {
    const r = await runPlanFull({
      date: "2026-08-06",
      sessions: [
        // weekly 开头(报表会话=正常工作,不 meta)
        { id: "w1", repo: "r", branch: "main", date: "2026-08-06", start: "08:00", end: "08:20", activeMinutes: 18, summary: "Base directory ... skills\\weekly # 周报" },
        // report 开头但活跃 50min(可能干了真开发,双保险不并入)
        metaS("big1", "09:00", "10:00", 50),
        // 已提交过水位的 meta(delta<15 → already,不并入)
        metaS("a1", "11:00", "11:12", 12),
        // 普通可聚合 meta
        metaS("m1", "13:00", "13:12", 12),
      ],
      submitted: { "2026-08-06": { a1: { tasks: [100], hours: 0.5, minutes: 12 } } },
      summaries: { "2026-08-06": [{ session: "w1", work: "生成周报", task: 100, notedActiveMinutes: 15 }] },
      cache: { projects: [{ id: 1, name: "P1" }], tasks: [{ id: 100, name: "T1", project: 1 }], executions: [], taskDetails: {} },
    });
    const items = r.items;
    const ids = items.map((i: any) => i.session);
    expect(ids).toContain("w1"); // weekly 独立
    expect(ids).toContain("big1"); // 50min 不并入
    expect(ids).not.toContain("a1"); // 已提交(delta<15)不进 items
    expect(r.alreadyCount).toBe(1);
    const m = items.find((i: any) => Array.isArray(i.sourceSessions));
    expect(m).toBeDefined();
    expect(m.sourceSessions.length).toBe(1); // 只有 m1
    expect(m.work).toBe("执行 shine-worklog 工时填报流程"); // 单条也规范化文案
  });

  test("needs_semantic 的 meta:有历史 → resolved 按历史归属;无历史 → unmatched 留问", async () => {
    const items = await runPlan({
      date: "2026-08-06",
      sessions: [metaS("n1", "09:00", "09:12", 12)],
      submitted: { "2026-08-06": { other: { tasks: [100], hours: 1, minutes: 60 } } }, // 项目历史 → 77563 场景
      mappings: { repoToProject: { r: 1 }, branchToTask: {} },
      cache: { projects: [{ id: 1, name: "P1" }], tasks: [{ id: 100, name: "T1", project: 1 }], executions: [], taskDetails: {} },
    });
    expect(items.length).toBe(1);
    expect(items[0].status).toBe("resolved"); // inferProjectTask 项目级回退取 100
    expect(items[0].task).toBe(100);
    expect(items[0].reason).toContain("自动聚合"); // 归属语义体现在 task,reason 是聚合的
  });

  test("盲区兜底:summary=(无文本提示)(斜杠命令会话抓不到标题)但 signals 有填报系 skill 标签 → 仍并入聚合", async () => {
    const items = await runPlan({
      date: "2026-08-06",
      sessions: [
        { id: "cmd1", repo: "r", branch: "main", date: "2026-08-06", start: "09:00", end: "09:12", activeMinutes: 12, summary: "(无文本提示)" },
        // 对照组:同样无标题,但 signals 无填报系标签(如 weekly)→ 不聚合
        { id: "w1", repo: "r", branch: "main", date: "2026-08-06", start: "13:00", end: "13:20", activeMinutes: 18, summary: "(无文本提示)" },
      ],
      signals: { "2026-08-06": [
        { id: "cmd1", signals: { aiTitle: "禅道工时提交流程", turns: [{ skills: ["shine-worklog:report"] }] } },
        { id: "w1", signals: { aiTitle: "生成周报", turns: [{ skills: ["shine-worklog:weekly"] }] } },
      ] },
      submitted: {},
      summaries: { "2026-08-06": [{ session: "w1", work: "生成周报", task: 100, notedActiveMinutes: 15 }] },
      cache: { projects: [{ id: 1, name: "P1" }], tasks: [{ id: 100, name: "T1", project: 1 }], executions: [], taskDetails: {} },
    });
    expect(items.length).toBe(2); // cmd1 聚合条 + w1 正常条目,各独立
    const meta = items.find((i: any) => Array.isArray(i.sourceSessions));
    expect(meta).toBeDefined();
    expect(meta.sourceSessions.map((x: any) => x.session)).toEqual(["cmd1"]); // cmd1 被并入聚合
    expect(meta.work).toBe("执行 shine-worklog 工时填报流程");
    const w = items.find((i: any) => i.session === "w1");
    expect(w).toBeDefined(); // w1(weekly 标签)不聚合
    expect(w.meta).toBe(false);
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

  test("跨 note 重复行去重(十次踩坑:相邻 note 窗口各含同一 commit subject → 回声行)", async () => {
    const items = await runPlan({
      sessions: [{ id: "s16", repo: "r", branch: "main", activeMinutes: 18, start: "09:00", end: "09:18" }],
      submitted: {},
      summaries: { "2026-08-06": [
        { session: "s16", work: "做A", task: 100, notedActiveMinutes: 5 },
        { session: "s16", work: "auto-note 代码围栏状态机\n做B", task: 100, notedActiveMinutes: 10 },
        { session: "s16", work: "auto-note 代码围栏状态机", task: 100, notedActiveMinutes: 15 }, // 与上条 note 重复的行
      ] },
      cache: { projects: [{ id: 1, name: "P1" }], tasks: [{ id: 100, name: "T1", project: 1 }], executions: [], taskDetails: {} },
    });
    expect(items.length).toBe(1);
    expect(items[0].work).toBe("做A\nauto-note 代码围栏状态机\n做B"); // 重复行只留一次
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

describe("cmdPlan — session=null note 归属", () => {
  test("session=null 的 note → 归当天最新 session", async () => {
    const items = await runPlan({
      sessions: [{ id: "s15", repo: "r", branch: "main", activeMinutes: 60, start: "09:00", end: "10:00" }],
      submitted: {},
      summaries: { "2026-08-06": [{ session: null, work: "无session的note", task: 100, notedActiveMinutes: null }] },
      cache: { projects: [{ id: 1, name: "P1" }], tasks: [{ id: 100, name: "T1", project: 1 }], executions: [], taskDetails: {} },
    });
    expect(items.length).toBe(1);
    expect(items[0].session).toBe("s15");
    expect(items[0].work).toBe("无session的note");
    expect(items[0].task).toBe(100);
  });
});

describe("cmdNote(note 命令,CLI 子进程)— 不传 session 的默认归属", () => {
  // cmdNote 无 export,走真实 CLI 入口;多天 sessions 下默认 session 必须归今天(不归 end 更晚的昨天会话)。
  // LOCALAPPDATA 必须指 tmp(env 隔离同 runner 模式)——否则 note 会写到真实 DATA_DIR 污染生产项目目录。
  const runNote = async (fixtures: any): Promise<any> => {
    const tmp = mkdtempSync(path.join(tmpdir(), "zen-note-"));
    const projDir = path.join(tmp, "shine-worklog", "zenpilot", "projects", tmp.replace(/[^a-zA-Z0-9]/g, "-"));
    mkdirSync(projDir, { recursive: true });
    writeFileSync(path.join(projDir, "sessions.json"), JSON.stringify({ date: fixtures.date ?? "2026-08-06", sessions: fixtures.sessions }));
    const script = path.join(import.meta.dir, "..", "zentao.ts");
    const proc = Bun.spawn(["bun", "run", script, "note", "--cwd", tmp, "--work", "W", "--task", "100"], {
      stdout: "pipe", stderr: "pipe", env: { ...process.env, LOCALAPPDATA: tmp },
    });
    const out = await new Response(proc.stdout).text();
    const err = await new Response(proc.stderr).text();
    const code = await proc.exited;
    const summary = readFileSync(path.join(projDir, "summary-2026-08-06.json"), "utf8");
    rmSync(tmp, { recursive: true, force: true });
    if (code !== 0) throw new Error("note exit " + code + ": " + err + out); // note 设计为静默,失败才 die 输出
    return { summary: JSON.parse(summary) };
  };

  test("多天 sessions:默认归今天 end 最晚,不归昨天 22:00 的(与 fallbackSid 同口径)", async () => {
    const r = await runNote({
      sessions: [
        { id: "yd-22h", repo: "r", branch: "main", date: "2026-08-05", activeMinutes: 60, start: "16:00", end: "22:00" },
        { id: "td-10h", repo: "r", branch: "main", date: "2026-08-06", activeMinutes: 60, start: "09:00", end: "10:00" },
      ],
    });
    expect(r.summary[0].session).toBe("td-10h"); // 不是 yd-22h(end 22:00 更晚但属昨天)
    expect(r.summary[0].work).toBe("W");
    expect(r.summary[0].notedActiveMinutes).toBe(60); // 水位拍自归属 session
  });
});
