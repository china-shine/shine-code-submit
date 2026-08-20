/** 归属日机制测试(2026-08-20 用户「你要不测试一下」:报昨天的工时到底分不分得开)。
 *  两层:
 *  ① 机制层(toZenSession 按 lastActive 定归属日,子进程 runner 侧本地时区,见 attribution-runner):
 *     独立昨天会话 → 归昨天(本来就分得开);跨天会话(lastActive=今早 10:00、activeMs=15h)→ 整体归今天。
 *  ② 可见性层(「报昨天」场景 render 草稿):独立昨天条目带 [补 08-19] 标记可核对;
 *     跨天条目(date=今天)无标记、落今天——正是 SKILL 第 3 步「核对归属日」要拦的盲区(58aae02)。 */
import { describe, test, expect, afterAll } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { sandbox, cleanupSandboxes } from "./cli-harness";

const RUNNER = path.join(import.meta.dir, "attribution-runner.ts");

// 真实数据污染守卫(与 plan/cli-local 同款):跑完真实项目不得出现假 session id
const REAL_PROJ = "C:/Users/ren/AppData/Local/shine-worklog/zenpilot/projects/C--Users-ren-Desktop-workspace-livesetting";
afterAll(() => {
  cleanupSandboxes();
  try {
    const sessions = readFileSync(path.join(REAL_PROJ, "sessions.json"), "utf8");
    if (/s3[012]/.test(sessions)) throw new Error("污染!真实 sessions 出现假 s3x id");
  } catch (e: any) {
    if (String(e?.message ?? "").startsWith("污染")) throw e; // 文件不存在等忽略
  }
});

describe("① 归属日机制(toZenSession:会话按 lastActive 定日)", () => {
  test("独立昨天会话→归昨天;跨天会话(lastActive=今早)→整体归今天(已拍板接受)", async () => {
    const tmp = mkdtempSync(path.join(tmpdir(), "zen-attr-"));
    const proc = Bun.spawn(["bun", "run", RUNNER], {
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, LOCALAPPDATA: tmp },
    });
    const out = await new Response(proc.stdout).text();
    const err = await new Response(proc.stderr).text();
    const code = await proc.exited;
    rmSync(tmp, { recursive: true, force: true });
    expect(code, err).toBe(0);
    const r = JSON.parse(out.trim().split("\n").pop()!);
    // 独立昨天会话:本来就分得开
    expect(r.standalone.date).toBe(r.yesterday);
    expect(r.standalone.end).toBe("18:00");
    expect(r.standalone.activeMinutes).toBe(60);
    // 跨天会话:15h(昨天 19:00→今早 10:00)整体归今天——同事「报昨天」落今天的机制,非 bug,已拍板
    expect(r.crossDay.date).toBe(r.today);
    expect(r.crossDay.start).toBe("19:00");
    expect(r.crossDay.end).toBe("10:00");
    expect(r.crossDay.activeMinutes).toBe(900);
  }, 20000);
});

describe("② SKILL 可见性:「报昨天」场景 render 草稿(核对归属日的依据)", () => {
  test("独立昨天条目带 [补 08-19];跨天条目无标记、落今天;今天条目照常", async () => {
    const s = sandbox();
    const CACHE = { projects: [{ id: 1, name: "P1" }], tasks: [{ id: 100, name: "T100", project: 1, status: "doing", left: 8 }], executions: [], taskDetails: {} };
    s.write("cache", CACHE);
    // plan.json 直接写(render 只读 plan;plan 的 item.date 赋值已有 plan.test.ts「多天补报」覆盖,这里验草稿可见性)
    s.write("plan", {
      date: "2026-08-20",
      draftSeq: 0,
      items: [
        {
          session: "s30", repo: "r", branch: "main", date: "2026-08-19", start: "09:00", end: "11:00",
          minutes: 120, hours: 2, summary: "", meta: false, increment: false, status: "resolved",
          task: 100, taskName: "T100", project: 1, projectName: "P1", work: "昨天独立完成X", confidence: 100, reason: "测试",
        },
        {
          session: "s31", repo: "r", branch: "main", date: "2026-08-20", start: "09:00", end: "10:00",
          minutes: 60, hours: 1, summary: "", meta: false, increment: false, status: "resolved",
          task: 100, taskName: "T100", project: 1, projectName: "P1", work: "今天完成Y", confidence: 100, reason: "测试",
        },
        // 跨天会话:daemon 按 lastActive=今早 10:00 已归今天(date=08-20,无 [补])——昨晚到今早的活整条落今天
        {
          session: "s32", repo: "r", branch: "main", date: "2026-08-20", start: "19:00", end: "10:00",
          minutes: 540, hours: 9, summary: "", meta: false, increment: false, status: "resolved",
          task: 100, taskName: "T100", project: 1, projectName: "P1", work: "跨天完成Z", confidence: 100, reason: "测试",
        },
      ],
    });
    const r = await s.run(["render"]);
    expect(r.code).toBe(0);
    // 独立昨天条目:草稿带 [补 08-19],核对时一眼分辨补的是哪天
    expect(r.stdout).toContain("[补 08-19] 09:00—11:00,2.0小时");
    // 今天条目:无标记照常
    expect(r.stdout).toContain("09:00—10:00,1.0小时");
    // 跨天条目:无 [补] 标记、落今天(19:00—10:00,9.0小时)——SKILL 第 3 步要主动指出的盲区
    const xdLine = r.stdout.split("\n").find((l: string) => l.includes("19:00—10:00"));
    expect(xdLine).toBeDefined();
    expect(xdLine).not.toContain("[补");
  }, 20000);
});
