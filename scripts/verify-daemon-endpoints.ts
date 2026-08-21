// daemon 全端点验证脚本:对运行中的 daemon(默认 36666,pid 文件定位)逐个打端点,
// 断言状态码,汇总 pass/fail。用途:改 daemon 路由后快速回归;审计「哪些端点没测过」。
//
// 运行: bun scripts/verify-daemon-endpoints.ts
//
// 覆盖:
//   - 鉴权豁免:  /favicon.ico /api/health / 静态 UI
//   - 鉴权负例:  读接口无 token / 错 token → 401;reports 预览无 ?t= → 401
//   - 鉴权 GET:  stats/events/projects/sessions/signals/transcript/commits/report/
//                zentao-config/settings/zentao-cache/skills/skills-file/skills-edits/skills-edit/
//                reports-daily+weekly 列表与单文件
//   - 安全写:    zentao-config PUT(原样回写)/ settings PUT(原样回写)/ hook POST(插一条无害事件)
//
// 破坏性端点(能工作但会改状态,验证脚本不触发,仅盘点):
//   POST /api/report/upload(真上报 tokenserver)  POST /api/update(查/装新版并重启 daemon)
//   POST /api/zentao-cache/refresh(真登禅道重拉,慢)  POST /api/shutdown(停 daemon)
//   PUT /api/skills/file / POST /api/skills/restore / POST /api/skills/reset(改 skills 文件)
//   DELETE /api/reports/daily|weekly/<date>(删报表文件)

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const DATA_DIR = process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local");
const pid = JSON.parse(readFileSync(join(DATA_DIR, "shine-worklog", "daemon.pid"), "utf8")) as {
  port: number;
  token: string;
  pid: number;
};
const base = `http://127.0.0.1:${pid.port}`;
const AUTH = { authorization: `Bearer ${pid.token}` };
const CWD = process.cwd();

interface Check {
  name: string;
  method: string;
  path: string;
  expect?: number[];
  note?: string;
  skip?: boolean;
}
const results: Array<{ name: string; ok: boolean; got: number; note?: string }> = [];

async function call(c: Check, headers: Record<string, string> = AUTH): Promise<{ status: number; body: unknown }> {
  const res = await fetch(base + c.path, { method: c.method, headers });
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    /* 非 JSON(html/空) */
  }
  return { status: res.status, body };
}

async function run(c: Check): Promise<void> {
  if (c.skip) {
    results.push({ name: c.name, ok: true, got: 0, note: "SKIP(破坏性,不触发)" });
    return;
  }
  try {
    const { status } = await call(c);
    const expect = c.expect ?? [200];
    results.push({ name: c.name, ok: expect.includes(status), got: status, note: c.note });
  } catch (e) {
    results.push({ name: c.name, ok: false, got: 0, note: `fetch 异常: ${String(e)}` });
  }
}

// ---------- 顺序执行(后面的动态端点依赖前面 GET 结果) ----------
const checks: Check[] = [];

// 鉴权豁免
checks.push({ name: "favicon(豁免,204)", method: "GET", path: "/favicon.ico", expect: [204] });
checks.push({ name: "health(豁免,200)", method: "GET", path: "/api/health" });
checks.push({ name: "静态 UI /(豁免,200)", method: "GET", path: "/" });
checks.push({ name: "静态 UI /ui/app.js(豁免,200)", method: "GET", path: "/ui/app.js" });

// 鉴权 GET 主端点
checks.push({ name: "GET /api/stats", method: "GET", path: "/api/stats" });
checks.push({ name: "GET /api/events", method: "GET", path: "/api/events" });
checks.push({ name: "GET /api/projects", method: "GET", path: "/api/projects" });
checks.push({ name: "GET /api/sessions", method: "GET", path: "/api/sessions" });
checks.push({ name: "GET /api/report", method: "GET", path: "/api/report" });
checks.push({ name: "GET /api/zentao-config", method: "GET", path: "/api/zentao-config" });
checks.push({ name: "GET /api/settings", method: "GET", path: "/api/settings" });
checks.push({ name: "GET /api/zentao-cache", method: "GET", path: "/api/zentao-cache" });
checks.push({ name: "GET /api/skills", method: "GET", path: "/api/skills" });
checks.push({ name: "GET /api/skills/edits", method: "GET", path: "/api/skills/edits" });
checks.push({ name: "GET /api/reports/daily(列表)", method: "GET", path: "/api/reports/daily" });
checks.push({ name: "GET /api/reports/weekly(列表)", method: "GET", path: "/api/reports/weekly" });

// 直接追加(信号/提交用当前项目 cwd;transcript/skills-file 先取数据)
const extras: Check[] = [
  { name: "GET /api/signals?cwd=<当前项目>", method: "GET", path: `/api/signals?cwd=${encodeURIComponent(CWD)}` },
  { name: "GET /api/commits?cwd=<当前项目>", method: "GET", path: `/api/commits?cwd=${encodeURIComponent(CWD)}` },
  { name: "GET /api/reports/daily/2026-08-20(存在)", method: "GET", path: "/api/reports/daily/2026-08-20" },
  { name: "GET /api/reports/weekly/2026-08-17~2026-08-21(存在)", method: "GET", path: "/api/reports/weekly/2026-08-17~2026-08-21" },
  { name: "GET /api/reports/daily/2099-01-01(不存在 → 404)", method: "GET", path: "/api/reports/daily/2099-01-01", expect: [404] },
  { name: "GET /api/transcript 缺 sessionId → 400", method: "GET", path: "/api/transcript", expect: [400] },
  { name: "GET /api/signals 缺 cwd → 400", method: "GET", path: "/api/signals", expect: [400] },
  { name: "GET /api/commits 缺 cwd → 400", method: "GET", path: "/api/commits", expect: [400] },
  { name: "GET /api/skills/file 缺 path → 400", method: "GET", path: "/api/skills/file", expect: [400] },
  { name: "POST /api/update(破坏性,不触发)", method: "POST", path: "/api/update", skip: true },
  { name: "POST /api/shutdown(破坏性,不触发)", method: "POST", path: "/api/shutdown", skip: true },
  { name: "POST /api/report/upload(破坏性,不触发)", method: "POST", path: "/api/report/upload", skip: true },
  { name: "POST /api/zentao-cache/refresh(慢+登禅道,不触发)", method: "POST", path: "/api/zentao-cache/refresh", skip: true },
  { name: "DELETE /api/reports/daily/2026-08-20(删文件,不触发)", method: "DELETE", path: "/api/reports/daily/2026-08-20", skip: true },
];

const all = [...checks, ...extras];
for (const c of all) {
  await run(c);
}

// 鉴权负例(独立跑,覆盖默认 AUTH header)
async function runAuthNeg(name: string, headers: Record<string, string>, expect: number[]): Promise<void> {
  try {
    const { status } = await call({ name: "", method: "GET", path: "/api/stats" }, headers);
    results.push({ name, ok: expect.includes(status), got: status });
  } catch (e) {
    results.push({ name, ok: false, got: 0, note: `fetch 异常: ${String(e)}` });
  }
}
await runAuthNeg("鉴权负例:stats 无 token → 401", {}, [401]);
await runAuthNeg("鉴权负例:stats 错 token → 401", { authorization: "Bearer wrong-token" }, [401]);
try {
  const res = await fetch(base + "/reports/daily/2026-08-20"); // 无 ?t=
  results.push({ name: "鉴权负例:reports/daily 无 ?t= → 401", ok: res.status === 401, got: res.status });
} catch (e) {
  results.push({ name: "鉴权负例:reports/daily 无 ?t= → 401", ok: false, got: 0, note: String(e) });
}
try {
  const res = await fetch(base + "/api/no-such", { headers: AUTH });
  results.push({ name: "鉴权负例:未知 /api 路径带 token → 404", ok: res.status === 404, got: res.status });
} catch (e) {
  results.push({ name: "鉴权负例:未知 /api 路径带 token → 404", ok: false, got: 0, note: String(e) });
}

// 动态:transcript 用真实 sessionId;skills-file 用第一个 rel
try {
  const s = await call({ name: "", method: "GET", path: "/api/sessions" });
  const rows = (s.body as any)?.rows ?? (s.body as any)?.sessions ?? [];
  const sid = Array.isArray(rows) ? rows[0]?.sessionId : null;
  if (sid) {
    await run({ name: "GET /api/transcript?sessionId=<真实>", method: "GET", path: `/api/transcript?sessionId=${encodeURIComponent(sid)}`, expect: [200, 404, 500], note: "404=该会话无 transcript_path" });
  } else {
    results.push({ name: "GET /api/transcript?sessionId=<真实>", ok: true, got: 0, note: "SKIP(无会话可取样)" });
  }
  const sk = await call({ name: "", method: "GET", path: "/api/skills" });
  const files = (sk.body as any)?.files ?? [];
  const rel = Array.isArray(files) ? files[0]?.rel : null;
  if (rel) {
    await run({ name: "GET /api/skills/file?path=<首个 rel>", method: "GET", path: `/api/skills/file?path=${encodeURIComponent(rel)}` });
    await run({ name: "GET /api/skills/edit?rel=<首个 rel>(无编辑 → 404)", method: "GET", path: `/api/skills/edit?rel=${encodeURIComponent(rel)}`, expect: [200, 404], note: "404=该 skill 从未被编辑" });
  } else {
    results.push({ name: "GET /api/skills/file?path=<首个 rel>", ok: true, got: 0, note: "SKIP(无 skill 文件)" });
  }
} catch (e) {
  results.push({ name: "动态端点取样", ok: false, got: 0, note: `取样失败: ${String(e)}` });
}

// 安全写:zentao-config / settings 原样回写;hook 插一条无害事件
try {
  const zc = await call({ name: "", method: "GET", path: "/api/zentao-config" });
  const z = zc.body as any;
  if (z && typeof z.url === "string") {
    const put = await fetch(base + "/api/zentao-config", { method: "PUT", headers: { ...AUTH, "content-type": "application/json" }, body: JSON.stringify({ url: z.url, account: z.account }) });
    results.push({ name: "PUT /api/zentao-config(原样回写)", ok: put.status === 200, got: put.status });
  }
} catch (e) {
  results.push({ name: "PUT /api/zentao-config(原样回写)", ok: false, got: 0, note: String(e) });
}
try {
  const st = await call({ name: "", method: "GET", path: "/api/settings" });
  const s = st.body as any;
  if (s && typeof s === "object") {
    const put = await fetch(base + "/api/settings", { method: "PUT", headers: { ...AUTH, "content-type": "application/json" }, body: JSON.stringify(s) });
    results.push({ name: "PUT /api/settings(原样回写)", ok: put.status === 200, got: put.status });
  }
} catch (e) {
  results.push({ name: "PUT /api/settings(原样回写)", ok: false, got: 0, note: String(e) });
}
try {
  const hookBody = { cwd: "/__verify__", sessionId: "verify-endpoint-test-" + Date.now(), timestamp: Date.now() };
  const put = await fetch(base + "/api/hook/Stop", { method: "POST", headers: { ...AUTH, "content-type": "application/json" }, body: JSON.stringify(hookBody) });
  results.push({ name: "POST /api/hook/Stop(插无害事件)", ok: put.status === 200, got: put.status });
} catch (e) {
  results.push({ name: "POST /api/hook/Stop(插无害事件)", ok: false, got: 0, note: String(e) });
}

// ---------- 汇总 ----------
const failed = results.filter((r) => !r.ok);
let pass = 0;
for (const r of results) {
  const mark = r.ok ? "PASS" : "FAIL";
  if (r.ok) pass++;
  const note = r.note ? `  [${r.note}]` : "";
  const got = r.got ? ` got=${r.got}` : "";
  console.log(`${mark}  ${r.name}${got}${note}`);
}
console.log(`\n=== ${pass}/${results.length} pass, ${failed.length} fail ===`);
console.log(`daemon pid=${pid.pid} port=${pid.port}`);
if (failed.length) process.exitCode = 1;
