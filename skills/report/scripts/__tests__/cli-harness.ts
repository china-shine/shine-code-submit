/** CLI 端到端测试基建:mock 禅道(Bun.serve port 0)+ 子进程真跑 zentao.ts。
 *  隔离双保险:LOCALAPPDATA→tmp(config/cache/mappings/settings/efforts/projects 全进沙箱)+
 *  --cwd→tmp 项目目录(sessions/submitted/plan/summary 进沙箱);stdin 立即 EOF(子进程呈 hook 模式语义)。
 *  mock server 记录全部请求(method+path+body),供「参数正确 / 未发请求」类断言;routes 可按测试重设。
 *  与 plan-runner/commit-runner 同一隔离思路,但走真实 CLI 入口(main 分发/parseArgs/die 全覆盖)。 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

export const ZENTAO_TS = path.join(import.meta.dir, "..", "zentao.ts");

// ---------- mock 禅道 ----------
export type RouteCtx = { method: string; p: string; q: URLSearchParams; body: any };
export type Route = (ctx: RouteCtx) => { status: number; body: any } | null;

export type MockZentao = {
  url: string;
  requests: { method: string; p: string; q: string; body: any }[];
  setRoutes: (r: Route) => void;
  stop: () => void;
};

export function startMockZentao(route0?: Route): MockZentao {
  const requests: MockZentao["requests"] = [];
  let route: Route | null = route0 ?? null;
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const u = new URL(req.url);
      let body: any = null;
      if (req.method === "POST") {
        try { body = await req.json(); } catch { body = null; }
      }
      requests.push({ method: req.method, p: u.pathname, q: u.search, body });
      let out: { status: number; body: any } | null = null;
      try { out = route ? route({ method: req.method, p: u.pathname, q: u.searchParams, body }) : null; } catch (e) {
        out = { status: 500, body: { error: String(e) } };
      }
      if (!out) return Response.json({ error: `no mock route: ${req.method} ${u.pathname}` }, { status: 404 });
      return Response.json(out.body, { status: out.status });
    },
  });
  // Bun 1.3 无 server.url,用 port 自拼回环地址
  return { url: `http://127.0.0.1:${server.port}`, requests, setRoutes: (r) => { route = r; }, stop: () => server.stop(true) };
}

/** 登录兜底:/tokens 永远发 token;其余路径交给业务 route。 */
export function withLogin(route: Route): Route {
  return (ctx) => (ctx.p.endsWith("/tokens") ? { status: 200, body: { token: "tok-1" } } : route(ctx));
}

/** 请求切片里是否「无业务 POST」(登录 POST /tokens 不算)。 */
export function noBizPost(reqs: { method: string; p: string }[]): boolean {
  return !reqs.some((x) => x.method === "POST" && !x.p.endsWith("/tokens"));
}

/** 真实数据污染防护用的日期(与 plan.test.ts 的 guard 同源;新测试不写真实目录,双保险)。 */
export const nearDate = (): string => new Date(Date.now() + 12 * 3600e3).toISOString().slice(0, 10); // 必在 20 天窗口内(任何时区)
export const oldDate = (): string => "2020-01-01"; // 必在窗口外

// ---------- 沙箱 env + 子进程 ----------
export type RunOut = { code: number; stdout: string; stderr: string; json: any | null };

export class CliSandbox {
  tmp: string; // 假 LOCALAPPDATA(DATA_DIR 根)
  projCwd: string; // --cwd(项目工作目录)
  projDir: string; // 沙箱内 PROJECT_DIR = <tmp>/shine-worklog/zenpilot/projects/<encode(projCwd)>

  constructor(public config?: Record<string, any>) {
    this.tmp = mkdtempSync(path.join(tmpdir(), "zen-cli-"));
    this.projCwd = path.join(this.tmp, "proj");
    mkdirSync(this.projCwd, { recursive: true });
    this.projDir = path.join(this.tmp, "shine-worklog", "zenpilot", "projects", this.projCwd.replace(/[^a-zA-Z0-9]/g, "-"));
    if (config) this.write("config", config);
  }

  /** 沙箱内固定位置路径。rel ∈ config|cache|mappings|settings|daemonPid|sessions|submitted|plan|
   *  summary:<日期>|efforts:<任务ID>|submittedLog:<日期> */
  file(rel: string): string {
    const zen = path.join(this.tmp, "shine-worklog", "zenpilot");
    if (rel === "config") return path.join(zen, "config.json");
    if (rel === "cache") return path.join(zen, "cache.json");
    if (rel === "mappings") return path.join(zen, "mappings.json");
    if (rel === "settings") return path.join(this.tmp, "shine-worklog", "settings.json");
    if (rel === "daemonPid") return path.join(this.tmp, "shine-worklog", "daemon.pid");
    if (rel === "sessions") return path.join(this.projDir, "sessions.json");
    if (rel === "submitted") return path.join(this.projDir, "submitted.json");
    if (rel === "plan") return path.join(this.projDir, "plan.json");
    if (rel.startsWith("summary:")) return path.join(this.projDir, `summary-${rel.slice(8)}.json`);
    if (rel.startsWith("efforts:")) return path.join(zen, "efforts", `${rel.slice(8)}.json`);
    if (rel.startsWith("submittedLog:")) return path.join(zen, "submitted", `${rel.slice(13)}.jsonl`);
    throw new Error("unknown rel: " + rel);
  }

  write(rel: string, data: unknown): string {
    const p = this.file(rel);
    mkdirSync(path.dirname(p), { recursive: true });
    writeFileSync(p, typeof data === "string" ? data : JSON.stringify(data), "utf8");
    return p;
  }

  read(rel: string): any {
    return JSON.parse(readFileSync(this.file(rel), "utf8"));
  }

  /** 读文本(submittedLog 等 jsonl 逐行文件,不能整体 JSON.parse)。 */
  readText(rel: string): string {
    return readFileSync(this.file(rel), "utf8");
  }

  exists(rel: string): boolean {
    return existsSync(this.file(rel));
  }

  /** 子进程跑 zentao.ts(自动追加 --cwd 沙箱项目目录;绝不能以真实 cwd 跑,会写真实项目数据)。 */
  async run(args: string[]): Promise<RunOut> {
    return this.spawn([...args, "--cwd", this.projCwd]);
  }

  /** 不追加 --cwd 的裸跑:仅限「无命令 die」等在读任何文件前就退出的路径(否则会动真实 cwd 数据)。 */
  async runRaw(args: string[]): Promise<RunOut> {
    return this.spawn(args);
  }

  private async spawn(argv: string[]): Promise<RunOut> {
    const proc = Bun.spawn([process.execPath, "run", ZENTAO_TS, ...argv], {
      cwd: this.tmp,
      env: { ...process.env, LOCALAPPDATA: this.tmp },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    proc.stdin.end(); // 立即 EOF:collect 呈 hook 模式(与 Stop hook spawn 同形态)
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    // 成功输出是 pretty 多行 JSON(先整段试),die 是单行 JSON(退化取末行);render 等纯文本 → null
    let json: any = null;
    const trimmed = stdout.trim();
    if (trimmed) {
      try { json = JSON.parse(trimmed); } catch {
        const last = trimmed.split("\n").pop()!;
        try { json = JSON.parse(last); } catch { json = null; }
      }
    }
    return { code, stdout, stderr, json };
  }

  destroy(): void {
    try { rmSync(this.tmp, { recursive: true, force: true }); } catch { /* Windows 句柄迟滞,残留 tmp 可接受 */ }
  }
}

// 沙箱注册表:测试内漏 destroy 时 afterAll 兜底清理
const sandboxes: CliSandbox[] = [];
export function sandbox(config?: Record<string, any>): CliSandbox {
  const s = new CliSandbox(config);
  sandboxes.push(s);
  return s;
}
export function cleanupSandboxes(): void {
  for (const s of sandboxes) s.destroy();
  sandboxes.length = 0;
}
