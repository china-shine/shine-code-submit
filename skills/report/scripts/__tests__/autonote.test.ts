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
  test("引导语(开场白)跳过,取后续实质句(2026-08-18 实测踩坑)", () => {
    // 回复以「草稿如下:」开场,后面才是真结论
    expect(simplifyConclusion("文案已改好,草稿如下：\n\n```text\n(代码块)\n```\n\n生成本周工时周报,核对禅道明细并调整总结文案。")).toBe("生成本周工时周报,核对禅道明细并调整总结文案。");
    expect(simplifyConclusion("草稿已渲染，请核对：")).toBeNull(); // 全是引导语 → null(不记,下次自愈)
    expect(simplifyConclusion("完整内容如下:")).toBeNull();
  });
  test("markdown 表格行/流程状态语跳过(2026-08-18 二次踩坑)", () => {
    // 表格表头「| 修复 | 效果 |」曾成为 increment work
    expect(simplifyConclusion("| 修复 | 效果 |\n|---|---|\n| 引导语过滤 | 消垃圾 |\n\n实现 auto-note 引导语过滤,补齐回归测试。")).toBe("实现 auto-note 引导语过滤,补齐回归测试。");
    expect(simplifyConclusion("| 修复 | 效果 |")).toBeNull();
    // 流程状态语(填报交互轮的 conclusion)
    expect(simplifyConclusion("已取消，本次不提交。")).toBeNull();
    expect(simplifyConclusion("工时草稿 ZR-20260818-017")).toBeNull();
  });
  test("草稿引用行跳过(2026-08-18 三次踩坑:重装后新代码仍写下「[1] 日常工作/…」)", () => {
    expect(simplifyConclusion("[1] 日常工作/AI智能体(项目#6924) / AI提效工具开发(任务#77563)\n    09:45—12:11,2.0小时\n\n实现草稿引用行过滤,补齐回归用例。")).toBe("实现草稿引用行过滤,补齐回归用例。");
    expect(simplifyConclusion("[1] 日常工作/AI智能体(项目#6924) / AI提效工具开发(任务#77563)")).toBeNull();
  });
  test("API 错误残行/草稿标签行跳过(2026-08-18 四次踩坑:错误 turn 的 conclusion 即错误文案;render 草稿元数据行被回显)", () => {
    expect(simplifyConclusion("API Error: Connection lost mid-response.")).toBeNull();
    expect(simplifyConclusion("API Error: Connection lost mid-response.\n实现 API 错误残行过滤,补齐回归用例。")).toBe("实现 API 错误残行过滤,补齐回归用例。");
    expect(simplifyConclusion("理由:开发时 summary 记录(多 note 合并,避免拆段工时膨胀)")).toBeNull();
    expect(simplifyConclusion("置信度:100%\n实现草稿标签行过滤,补齐回归用例。")).toBe("实现草稿标签行过滤,补齐回归用例。");
    expect(simplifyConclusion("说明:条目 2 原文中夹了一行正则残片,已在 plan.json 里删掉。")).toBeNull(); // 「说明:」叙述行(八次踩坑余波)
    expect(simplifyConclusion("修法:BOLD_RE = /^\\*\\*/ 直接拦加粗行首(修复报告的开场标题都是结构性行；全跳过由下次自愈兜底)。")).toBeNull(); // 「修法:」叙述行(九次踩坑)
    expect(simplifyConclusion("根因:skip() 在 markdown 剥离前执行,原始行拦不到。")).toBeNull();
  });
  test("报表状态语跳过(2026-08-18 五次踩坑:weekly 会话的 auto note 记成「周报已生成完毕…」状态播报)", () => {
    expect(simplifyConclusion("周报已生成完毕，AI 周总结已写入 HTML 底部。")).toBeNull();
    expect(simplifyConclusion("日报已生成并发送到团队群。")).toBeNull();
    expect(simplifyConclusion("周报已生成完毕，AI 周总结已写入 HTML 底部。\n生成上周工时周报 HTML 并写入 AI 周总结。")).toBe("生成上周工时周报 HTML 并写入 AI 周总结。"); // 跳过播报行取实质句
  });
  test("plan 状态语跳过(2026-08-18 六次踩坑:/report 轮开场结论「plan 已出：…」被记成 work)", () => {
    expect(simplifyConclusion("plan 已出：2 条 resolved(1 条填报流程聚合 + 1 条增量补报)，另有 17 条已提交(不进计划)。")).toBeNull();
    expect(simplifyConclusion("plan 已出：4 条 resolved，无 cooldown。\n扩充 CLI 端到端测试覆盖全部 23 个命令。")).toBe("扩充 CLI 端到端测试覆盖全部 23 个命令。");
  });
  test("半角句点不截断标识符(六次踩坑同轮:config.json/plan.json 的点被当句末,产出「把真实 config.」残句)", () => {
    // 标识符/版本号/域名里的 . 不当句终,取到真正句号为止
    expect(simplifyConclusion("手动复现命令忘设 LOCALAPPDATA,把真实 config.json 的 url 覆盖错了,已找回原值恢复并验证登录。"))
      .toBe("手动复现命令忘设 LOCALAPPDATA,把真实 config.json 的 url 覆盖错了,已找回原值恢复并验证登录。");
    expect(simplifyConclusion("核对完真实数据(plan.json + submitted.json),结论是主流程没有逻辑错误,数字全对。"))
      .toContain("submitted.json)"); // 不在 plan. 处截断
    // 半角句点在真句末(后跟空白/行尾)仍终止
    expect(simplifyConclusion("修复了 collect 的路径解析 bug. 回归全过,细节略")).toBe("修复了 collect 的路径解析 bug.");
  });
  test("加粗编号标题行跳过(2026-08-18 七次踩坑:修复报告开场「**1. auto-note 拦报表状态语** — …」剥 * 后成「1. …」残片)", () => {
    // 行级 skip 在 markdown 剥离前做,原始行以 ** 开头须直接拦(数字列表正则要求行首裸数字,拦不到 **1.)
    expect(simplifyConclusion("**1. auto-note 拦报表状态语** — `STATUS_RE` 增补 `(周报|日报|报告|报表)已`\n- 「周报已生成完毕」这类播报不再记成 work\n\n实现状态语过滤加固并补齐回归用例。"))
      .toBe("实现状态语过滤加固并补齐回归用例。");
    expect(simplifyConclusion("**修复说明**\n实现了句点词边界判定,标识符不再被截断。")).toBe("实现了句点词边界判定,标识符不再被截断。");
    expect(simplifyConclusion("**1. auto-note 拦报表状态语** — `STATUS_RE` 增补 `(周报|日报|报告|报表)已`")).toBeNull(); // 全是标题 → null
  });
  test("代码围栏内部行跳过(2026-08-18 八次踩坑:修复回复里代码块中的正则原文漏过,还被首句正则截在自身内嵌 。 上成残片)", () => {
    // 围栏内是代码不是结论;闭合围栏后的正文行照常取
    expect(simplifyConclusion("修复说明:\n```ts\n/^(.{2,120}?(?:[。;;]|[.!?;](?=\\s|$)))/\n```\n实现句点词边界判定并补齐回归用例。"))
      .toBe("实现句点词边界判定并补齐回归用例。");
    expect(simplifyConclusion("```bash\nbun run zentao.ts plan --cwd /tmp/proj --dry-run\n```")).toBeNull(); // 全是代码块 → null
    expect(simplifyConclusion("```text\n(未闭合围栏,后续行都是代码\nconst x = 1;")).toBeNull(); // 未闭合 → 之后全跳过
  });
});

describe("buildAutoWork(水位后新 turns → work)", () => {
  test("水位过滤 + 窗口全量 join(每 turn 一行)", () => {
    const r = buildAutoWork([turn(1000, "旧结论。"), turn(2000, "第一轮完成了A功能的开发。"), turn(3000, "新结论:完成X功能。")], 1500)!;
    expect(r.work).toBe("第一轮完成了A功能的开发。\n新结论:完成X功能。"); // 不再只取最新,中间轮不丢
    expect(r.lastMs).toBe(3000);
  });
  test("最新 conclusion 为 null → 该 turn 不产生行,lastMs 仍取最大", () => {
    const r = buildAutoWork([turn(1000, "上一轮完成了工时脚本的重构工作。"), turn(2000, null)], 0)!;
    expect(r.work).toBe("上一轮完成了工时脚本的重构工作。");
    expect(r.lastMs).toBe(2000); // lastMs 仍取新 turns 最大 endMs
  });
  test("conclusion 全空 → 逐 turn 回退 commits subjects(旧→新,剥类型前缀)", () => {
    const r = buildAutoWork([turn(1000, null, ["feat: A"]), turn(2000, null, ["fix(report): B"])], 0)!;
    expect(r.work).toBe("A\nB");
  });
  test("混合:有 conclusion 的 turn 一行 + 空 conclusion 有 commits 的 turn 一行 subject", () => {
    const r = buildAutoWork([turn(1000, "完成了X功能的开发工作。"), turn(2000, null, ["fix: Y"])], 0)!;
    expect(r.work).toBe("完成了X功能的开发工作。\nY");
  });
  test("去重:相同/包含的行只留长者", () => {
    expect(buildAutoWork([turn(1000, "完成了增量合并功能开发。"), turn(2000, "完成了增量合并功能开发。")], 0)!.work)
      .toBe("完成了增量合并功能开发。");
    expect(buildAutoWork([turn(1000, "完成了增量合并功能开发。"), turn(2000, "完成了增量合并功能开发并通过测试。")], 0)!.work)
      .toBe("完成了增量合并功能开发并通过测试。"); // 长者胜,占首行位置
  });
  test("上限:超过 MAX_AUTO_NOTE_LINES 行 → 保留最新 4 行 + 顶部省略标记", () => {
    const turns = [1, 2, 3, 4, 5, 6].map((i) => turn(i * 1000, `第${"一二三四五六"[i - 1]}轮完成功能${i}的开发工作。`));
    const r = buildAutoWork(turns, 0)!;
    expect(r.work).toBe("…(前 2 轮略)\n第三轮完成功能3的开发工作。\n第四轮完成功能4的开发工作。\n第五轮完成功能5的开发工作。\n第六轮完成功能6的开发工作。");
    expect(r.lastMs).toBe(6000);
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
