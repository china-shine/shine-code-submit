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
