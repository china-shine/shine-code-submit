/** auto-note(Stop 自动归纳 work+task,零 LLM)测试:
 *  纯函数(simplifyConclusion/buildAutoWork)主进程直测;autoNote/noteWatermark 走子进程 runner
 *  (env 隔离 + sig 注入,不打 daemon、不碰真实 DATA_DIR)。 */
import { describe, test, expect } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { simplifyConclusion, buildAutoWork, AUTO_NOTE_MIN_INTERVAL_MS } from "../zentao";

const RUNNER = path.join(import.meta.dir, "autonote-runner.ts");

const runAutoNote = async (fixtures: any): Promise<any> => {
  const tmp = mkdtempSync(path.join(tmpdir(), "zen-autonote-"));
  const inputPath = path.join(tmp, "input.json");
  writeFileSync(inputPath, JSON.stringify({ claudDir: tmp, localAppDir: tmp, fixtures }));
  const proc = Bun.spawn(["bun", "run", RUNNER, inputPath], { stdout: "pipe", stderr: "pipe" });
  const out = await new Response(proc.stdout).text();
  const err = await new Response(proc.stderr).text();
  const code = await proc.exited;
  rmSync(tmp, { recursive: true, force: true });
  if (code !== 0) throw new Error("runner exit " + code + ": " + err);
  const r = JSON.parse(out.trim().split("\n").pop()!);
  if (!r.ok) throw new Error("autoNote error: " + r.error);
  return r;
};

// fixture 速写:一条带 conclusion 的 turn
const turn = (endMs: number, conclusion: string | null, commits: string[] = []) => ({ endMs, conclusion, commits });

describe("simplifyConclusion(conclusion → 一句话 work)", () => {
  test("多行:跳过标题/列表行取正文首句", () => {
    expect(simplifyConclusion("## 完成情况\n- 改了A\n- 改了B\n\n已实现多天补报功能,测试通过。后面继续。")).toBe("已实现多天补报功能,测试通过。");
  });
  test("去行内 markdown + 全角句截断", () => {
    expect(simplifyConclusion("修复了 `collect` 的 **范围** bug,回归通过;细节略。")).toBe("修复了 collect 的 范围 bug,回归通过;");
  });
  test("无句号长文 → 100 字截断加省略号", () => {
    const long = "这是一段没有任何句号结束的超长结论".repeat(10);
    const r = simplifyConclusion(long)!;
    expect(r.length).toBe(101); // 100 字 + …
    expect(r.endsWith("…")).toBe(true);
  });
  test("短于10字(无信息量)→ null", () => {
    expect(simplifyConclusion("好的。")).toBeNull();
    expect(simplifyConclusion("已取消")).toBeNull();
  });
  test("纯标题/列表 → null", () => {
    expect(simplifyConclusion("## 标题\n- a\n- b")).toBeNull();
  });
});

describe("buildAutoWork(水位后新 turns → work)", () => {
  test("水位过滤 + 最新非空 conclusion", () => {
    const r = buildAutoWork([turn(1000, "旧结论。"), turn(2000, null), turn(3000, "新结论:完成X功能。")], 1500)!;
    expect(r.work).toBe("新结论:完成X功能。");
    expect(r.lastMs).toBe(3000);
  });
  test("最新 conclusion 为 null → 取前一条非空", () => {
    const r = buildAutoWork([turn(1000, "上一轮完成了工时脚本的重构工作。"), turn(2000, null)], 0)!;
    expect(r.work).toBe("上一轮完成了工时脚本的重构工作。");
    expect(r.lastMs).toBe(2000); // lastMs 仍取新 turns 最大 endMs
  });
  test("conclusion 全空 → 回退 commits subjects(新在前)", () => {
    const r = buildAutoWork([turn(1000, null, ["feat: A"]), turn(2000, null, ["fix: B"])], 0)!;
    expect(r.work).toBe("fix: B;feat: A");
  });
  test("全空且无 commits → null(不推进水位,下次自愈)", () => {
    expect(buildAutoWork([turn(1000, null), turn(2000, null)], 0)).toBeNull();
  });
  test("无新 turns(全部 ≤ 水位)→ null", () => {
    expect(buildAutoWork([turn(1000, "已记过。")], 1000)).toBeNull();
    expect(buildAutoWork([], 0)).toBeNull();
  });
  test("节流常量 = 10 分钟", () => {
    expect(AUTO_NOTE_MIN_INTERVAL_MS).toBe(10 * 60_000);
  });
});

describe("autoNote(子进程,注入 sig)", () => {
  const SIG = (turns: any[]) => ({ sessionId: "s-auto", cwd: "x", turns });
  // endMs 用相对 Date.now() 的动态 epoch(绝对值无时区问题);offMin=-30 表示 30 分钟前
  const ago = (offMin: number) => Date.now() + offMin * 60000;
  const baseFx = (turns: any[], summaries: Record<string, any[]> = {}) => ({
    sessionId: "s-auto",
    sig: SIG(turns),
    sessions: [{ id: "s-auto", repo: "r", branch: "main", date: "2026-08-06", activeMinutes: 42, start: "09:00", end: "09:42" }],
    summaries,
    cache: { projects: [{ id: 1, name: "P1" }], tasks: [{ id: 100, name: "T1", project: 1 }], executions: [], taskDetails: {} },
  });

  test("正常路径:写 auto note(auto/sigLastMs/task=-1 回退/水位快照)", async () => {
    const endMs = ago(-1);
    const r = await runAutoNote(baseFx([turn(endMs, "实现了auto-note自动归纳功能,测试全部通过。")]));
    const notes = r.summaries["2026-08-06"];
    expect(notes.length).toBe(1);
    expect(notes[0]).toMatchObject({
      session: "s-auto",
      work: "实现了auto-note自动归纳功能,测试全部通过。",
      task: -1, // 无 submitted 历史 → inferProjectTask 回退 -1(留 /report 问)
      notedActiveMinutes: 42, // 从 sessions.json 拍快照
      auto: true,
      sigLastMs: endMs,
    });
    expect(r.watermark.sinceMs).toBe(endMs); // 水位推进
  });

  test("水位去重:已记过的 turns(endMs ≤ sigLastMs)不再记", async () => {
    const summaries = { "2026-08-06": [{ session: "s-auto", ts: "2026-08-05T08:00:00", work: "旧", task: 100, notedActiveMinutes: 10, sigLastMs: ago(-60) }] };
    const r = await runAutoNote(baseFx([turn(ago(-60), "一小时前已记过的结论内容。")], summaries));
    expect(r.summaries["2026-08-06"].length).toBe(1); // 只有旧 note,没新增
  });

  test("手动 note 计入水位 + 节流:5 分钟前手动记过 → auto 跳过", async () => {
    const summaries = { "2026-08-06": [{ session: "s-auto", tsOffsetMin: -5, work: "AI 手动记的", task: 100, notedActiveMinutes: 20 }] };
    const r = await runAutoNote(baseFx([turn(ago(-1), "新结论不该被记,因为刚刚手动记过了。")], summaries));
    expect(r.summaries["2026-08-06"].length).toBe(1); // 不追加
  });

  test("手动 note 超过节流间隔(2h 前)→ auto 照常记(手动 ts 计入水位,更早 turn 不重记)", async () => {
    // 手动 note 2h 前;新 turn 在其后 1h 前(> 手动 ts 才算新)
    const summaries = { "2026-08-06": [{ session: "s-auto", tsOffsetMin: -120, work: "AI 手动记的", task: 100, notedActiveMinutes: 20 }] };
    const r = await runAutoNote(baseFx([turn(ago(-60), "手动记录之后的新工作结论出来了。")], summaries));
    const notes = r.summaries["2026-08-06"];
    expect(notes.length).toBe(2);
    expect(notes[1].auto).toBe(true);
  });

  test("开关 off:settings.autoNote=false → 不记", async () => {
    const fx = { ...baseFx([turn(ago(-1), "开关关了,这条结论不该被记录下来。")]), settings: { autoNote: false } };
    const r = await runAutoNote(fx);
    expect(r.summaries["2026-08-06"]).toBeUndefined(); // summary 文件未创建
  });

  test("无可用素材(conclusion 空且无 commits)→ 不记、水位不推进", async () => {
    const r = await runAutoNote(baseFx([turn(ago(-1), null)]));
    expect(r.summaries["2026-08-06"]).toBeUndefined();
    expect(r.watermark.sinceMs).toBe(0); // 未推进 → 下次 Stop 重看这批 turns 自愈
  });

  test("task 沿用:该会话有提交历史 → inferProjectTask 取最近 task", async () => {
    const fx = baseFx([turn(ago(-1), "继续既有任务的开发工作并完成验证环节。")]);
    fx.submitted = { "2026-08-05": { "s-auto": { tasks: [100], hours: 1, minutes: 60 } } };
    const r = await runAutoNote(fx);
    const notes = r.summaries["2026-08-06"];
    expect(notes[0].task).toBe(100);
    expect(notes[0].taskName).toBe("T1"); // appendNote 从 cache 补全
  });
});
