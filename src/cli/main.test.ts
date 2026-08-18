/** shine-worklog CLI(src/cli/main.ts)端到端:status / refresh / help / 未知命令。
 *  只 spawn 不 import(main.ts 是顶层执行脚本,import 即执行 + process.exit)。
 *  刻意不自动化 start/stop/restart:它们探测/停止的是本机 36666 真实 daemon(isOursAlive 直连
 *  127.0.0.1:36666,不看 LOCALAPPDATA),测试会误杀用户在跑的 daemon;ui 会拉起 daemon + 开浏览器;
 *  update 联 npm 注册表并后台 spawn 安装器——三者均为真实副作用,不适合放进测试。
 *  refresh 走子进程 zentao.ts(继承 LOCALAPPDATA 沙箱),用内联 mock 禅道验证全链路 + stderr 进度透传。 */
import { describe, test, expect, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

const MAIN_TS = path.join(import.meta.dir, "main.ts");
const REPO = path.join(import.meta.dir, "..", "..");

const tmps: string[] = [];
afterAll(() => { for (const t of tmps) { try { rmSync(t, { recursive: true, force: true }); } catch {} } });

type Route = (method: string, p: string) => { status: number; body: any } | null;

function startMockZentao(route: Route): { url: string; stop: () => void } {
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const u = new URL(req.url);
      let out: { status: number; body: any } | null = null;
      try { out = route(req.method, u.pathname); } catch (e) { out = { status: 500, body: { error: String(e) } }; }
      if (!out) return Response.json({ error: "no route" }, { status: 404 });
      return Response.json(out.body, { status: out.status });
    },
  });
  return { url: `http://127.0.0.1:${server.port}`, stop: () => server.stop(true) };
}

async function runCli(args: string[], env: Record<string, string> = {}): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn([process.execPath, "run", MAIN_TS, ...args], {
    cwd: REPO, env: { ...process.env, ...env }, stdin: "ignore", stdout: "pipe", stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { code, stdout, stderr };
}

describe("shine-worklog CLI", () => {
  test("无参数 → 打印帮助,exit 0", async () => {
    const r = await runCli([]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("shine-worklog <command>");
    expect(r.stdout).toContain("status");
    expect(r.stdout).toContain("refresh");
  }, 20000);

  test("未知命令 → 打印帮助,exit 1", async () => {
    const r = await runCli(["bogus"]);
    expect(r.code).toBe(1);
    expect(r.stdout).toContain("shine-worklog <command>");
  }, 20000);

  test("status → 输出 daemon 状态行(本机有无 daemon 都成立,只验格式)", async () => {
    const r = await runCli(["status"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/daemon: (not running|running\s+pid=\d+\s+uptime=\d+s\s+v[\d.]+)/);
  }, 20000);

  test("refresh → 透传 zentao.ts refresh:stderr 分步进度 + stdout 汇总行(沙箱 LOCALAPPDATA + mock 禅道)", async () => {
    const near = new Date(Date.now() + 12 * 3600e3).toISOString().slice(0, 10);
    const mock = startMockZentao((method, p) => {
      if (p.endsWith("/tokens")) return { status: 200, body: { token: "tok-1" } };
      if (p.includes("/projects") && !p.includes("/executions") && method === "GET")
        return { status: 200, body: { projects: [{ id: 1, name: "P1", status: "doing", left: 5, lastEditedDate: near }] } };
      if (p.includes("/projects/1/executions"))
        return { status: 200, body: { executions: [{ id: 20, status: "doing", name: "E1", end: "2030-01-01" }] } };
      if (p.includes("/executions/20/tasks"))
        return { status: 200, body: { tasks: [{ id: 100, name: "T100", status: "doing", assignedTo: { account: "me" }, left: 8 }] } };
      if (p.endsWith("/tasks/100/estimate")) return { status: 200, body: { effort: {} } };
      return null;
    });
    const tmp = mkdtempSync(path.join(tmpdir(), "sw-cli-"));
    tmps.push(tmp);
    mkdirSync(path.join(tmp, "shine-worklog", "zenpilot"), { recursive: true });
    writeFileSync(
      path.join(tmp, "shine-worklog", "zenpilot", "config.json"),
      JSON.stringify({ url: mock.url, account: "me", password: "p", projectIds: [1] }),
    );
    try {
      const r = await runCli(["refresh"], { LOCALAPPDATA: tmp });
      expect(r.code).toBe(0);
      expect(r.stderr).toContain("[1/4]"); // 进度透传(stderr)
      expect(r.stdout).toContain("✓ 刷新完成: 1 项目 / 1 任务 / 1 执行");
    } finally {
      mock.stop();
    }
  }, 30000);
});
