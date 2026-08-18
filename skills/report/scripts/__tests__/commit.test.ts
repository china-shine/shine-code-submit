/** cmdCommit 提交流水落盘测试(子进程隔离,不打真禅道):
 *  覆盖 commit → submitted/<date>.jsonl 逐笔 append → daemon collectWorklogs 读回(subId=行号)。
 *  核心回归:同会话同任务多笔提交不得互相顶替(旧 plan.json 方案的丢笔根因)。 */
import { describe, test, expect } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

const RUNNER = path.join(import.meta.dir, "commit-runner.ts");

const runCommit = async (fixtures: any) => {
  const tmp = mkdtempSync(path.join(tmpdir(), "zen-commit-"));
  const inputPath = path.join(tmp, "input.json");
  writeFileSync(inputPath, JSON.stringify({ claudDir: tmp, localAppDir: tmp, fixtures }));
  const proc = Bun.spawn(["bun", "run", RUNNER, inputPath], { stdout: "pipe", stderr: "pipe" });
  const out = await new Response(proc.stdout).text();
  const err = await new Response(proc.stderr).text();
  const code = await proc.exited;
  rmSync(tmp, { recursive: true, force: true });
  if (code !== 0) throw new Error("runner exit " + code + ": " + err);
  return JSON.parse(out.trim().split("\n").pop()!);
};

const PLAN = (items: any[]) => ({ date: "2026-08-06", items });

describe("cmdCommit 提交流水落盘", () => {
  test("每条 resolved 提交成功后逐笔 append,collectWorklogs 读回带 subId", async () => {
    const r = await runCommit({
      plan: PLAN([
        { status: "resolved", session: "s1", repo: "r1", branch: "main", start: "09:00", end: "10:00", minutes: 55, hours: 1, task: 100, taskName: "T100", project: 1, projectName: "P1", work: "3.0 升级依赖;做A\n做B" },
        { status: "resolved", session: "s2", repo: "r1", branch: "main", start: "11:00", end: "12:00", minutes: 25, hours: 0.5, task: 101, taskName: "T101", project: 1, projectName: "P1", work: "做B" },
        { status: "skipped", session: "s3", hours: 1, task: 100, work: "跳过的不落流水" },
      ]),
    });
    expect(r.ok).toBe(true);
    expect(r.calls.length).toBe(2); // skipped 不提交
    const lines = r.logText.trim().split("\n").map((l: string) => JSON.parse(l));
    expect(lines.length).toBe(2);
    // 多条 work:逐条编号换行,每条行尾带 AI 标识(与禅道记录逐字一致);
    // 版本号开头「3.0 升级依赖」不被去旧序号误剥;\n 分隔的多 note 合并也逐条拆
    expect(lines[0]).toMatchObject({ date: "2026-08-06", session: "s1", hours: 1, task: 100, work: "1. 3.0 升级依赖(本次内容由AI填报)\n2. 做A(本次内容由AI填报)\n3. 做B(本次内容由AI填报)", repo: "r1" });
    expect(lines[1]).toMatchObject({ session: "s2", hours: 0.5, task: 101, work: "1. 做B(本次内容由AI填报)" });
    // daemon 读回:subId = <date>:<行号>,skipped 条目不出现
    expect(r.worklogs.length).toBe(2);
    expect(r.worklogs[0]).toMatchObject({ sessionId: "s1", subId: "2026-08-06:0", hours: 1, taskId: 100 });
    expect(r.worklogs[1]).toMatchObject({ sessionId: "s2", subId: "2026-08-06:1", hours: 0.5, taskId: 101 });
  });

  test("同会话同任务二次提交(amend 补差)两笔并存不顶替", async () => {
    const item = { status: "resolved", session: "s1", repo: "r1", branch: "main", minutes: 55, hours: 0.5, task: 100, taskName: "T100", project: 1, projectName: "P1", work: "补报:做A" };
    const r = await runCommit({
      plan: PLAN([item]),
      amend: true,
      // 上午已 commit 过 s1(冷却聚合里有 lastCommit),amend 允许同会话补差
      submitted: { "2026-08-06": { s1: { tasks: [100], hours: 1, minutes: 55 }, _meta: { lastCommitAt: "2026-08-06T08:00:00+08:00", lastCommit: [{ session: "s1", task: 100, hours: 1 }] } } },
    });
    expect(r.ok).toBe(true);
    const lines = r.logText.trim().split("\n").map((l: string) => JSON.parse(l));
    expect(lines.length).toBe(1); // 本次 amend 的差额 0.5 追加为新行
    expect(lines[0]).toMatchObject({ session: "s1", hours: 0.5, work: "1. 补报:做A(本次内容由AI填报)" });
    expect(r.worklogs.length).toBe(1);
    expect(r.worklogs[0]).toMatchObject({ subId: "2026-08-06:0", hours: 0.5 });
  });

  test("AI 提交标识关闭时流水落原始文案(无标识)", async () => {
    const r = await runCommit({
      plan: PLAN([{ status: "resolved", session: "s1", repo: "r1", minutes: 55, hours: 1, task: 100, work: "做A" }]),
      settings: { aiSubmitMark: { enabled: false } },
    });
    expect(r.ok).toBe(true);
    const line = JSON.parse(r.logText.trim());
    expect(line.work).toBe("1. 做A"); // 标识关 → 与禅道记录(同样无标识、含序号)逐字一致
  });
});

describe("cmdCommit 多天补报(按条目归属日)", () => {
  test("补报条目按 item.date 提交禅道/记台账/分日流水;_meta 同时间戳盖各日期", async () => {
    const r = await runCommit({
      plan: PLAN([
        { status: "resolved", session: "s1", date: "2026-08-05", repo: "r1", branch: "main", start: "17:20", end: "17:59", minutes: 39, hours: 0.5, task: 100, taskName: "T100", project: 1, projectName: "P1", work: "昨天漏报的活" },
        { status: "resolved", session: "s2", repo: "r1", branch: "main", start: "09:00", end: "10:00", minutes: 55, hours: 1, task: 100, taskName: "T100", project: 1, projectName: "P1", work: "今天的活" },
      ]),
    });
    expect(r.ok).toBe(true);
    // 禅道 POST:date 逐条按归属日(补报记昨天,不污染今天)
    expect(r.calls.map((c: any) => c.date)).toEqual(["2026-08-05", "2026-08-06"]);
    // 台账 submitted.json:写各自日期 key
    expect(r.submittedJson["2026-08-05"].s1).toMatchObject({ tasks: [100], hours: 0.5, minutes: 39 });
    expect(r.submittedJson["2026-08-06"].s2).toMatchObject({ tasks: [100], hours: 1, minutes: 55 });
    // _meta:同一次 commit 的各日期 key 盖同一 lastCommitAt(amend 据此合并定位)
    expect(r.submittedJson["2026-08-05"]._meta.lastCommitAt).toBe(r.submittedJson["2026-08-06"]._meta.lastCommitAt);
    // 流水分日文件:subId 前缀区分归属日
    expect(r.worklogs.map((w: any) => w.subId).sort()).toEqual(["2026-08-05:0", "2026-08-06:0"]);
  });

  test("cooldown 全局:历史日期 key 里的 lastCommitAt 也拦(10 分钟前)", async () => {
    // lastCommitAtOffsetMin 在 runner 侧生成(主进程 bun test 是 TZ=UTC,拼的串到 runner 真本地解析差 8h)
    await expect(runCommit({
      plan: PLAN([{ status: "resolved", session: "s1", repo: "r1", minutes: 55, hours: 1, task: 100, work: "做A" }]),
      submitted: { "2026-08-01": { _meta: { lastCommitAt: "", lastCommit: [] } } },
      lastCommitAtOffsetMin: -10,
    })).rejects.toThrow();
  });

  test("元会话合并条:各源会话逐个记防重水位(hours=0/minutes 各自),防填报工时繁殖", async () => {
    const r = await runCommit({
      plan: PLAN([{
        status: "resolved", session: "m2", date: "2026-08-06", repo: "r1", branch: "main",
        start: "09:45", end: "10:41", minutes: 15, hours: 0.5, task: 100, taskName: "T100", project: 1, projectName: "P1",
        work: "执行 shine-worklog 工时填报流程",
        sourceSessions: [
          { session: "m1", minutes: 12 },
          { session: "m2", minutes: 15 },
          { session: "m3", minutes: 12 },
        ],
      }]),
    });
    expect(r.ok).toBe(true);
    expect(r.calls.length).toBe(1); // 禅道只提交 1 条(合并条)
    // 防重:各源会话都有水位(hours=0=工时在合并条)→ 下次 plan 各源 delta=0 → already
    const day = r.submittedJson["2026-08-06"];
    expect(day.m1).toMatchObject({ tasks: [100], hours: 0, minutes: 12 });
    expect(day.m2).toMatchObject({ tasks: [100], hours: 0, minutes: 15 });
    expect(day.m3).toMatchObject({ tasks: [100], hours: 0, minutes: 12 });
    // 流水只落合并条一条
    expect(r.worklogs.length).toBe(1);
    expect(r.worklogs[0]).toMatchObject({ sessionId: "m2", hours: 0.5 });
  });
});
