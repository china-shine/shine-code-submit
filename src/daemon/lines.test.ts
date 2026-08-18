import { describe, test, expect, afterAll } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { isTrivialLine } from "./lines";

describe("isTrivialLine(AI 行集合过滤)", () => {
  test("空行/纯空白 → trivial", () => {
    expect(isTrivialLine("")).toBe(true);
    expect(isTrivialLine(" ")).toBe(true);
    expect(isTrivialLine("\t")).toBe(true);
  });
  test("纯括号/分号/标点 → trivial(惯用行,任何 commit 都有,入集合会虚高 aiAdded)", () => {
    expect(isTrivialLine("}")).toBe(true);
    expect(isTrivialLine("});")).toBe(true);
    expect(isTrivialLine("{")).toBe(true);
    expect(isTrivialLine(");")).toBe(true);
    expect(isTrivialLine("```")).toBe(true);
  });
  test("含字母/数字/中文 → 非 trivial(有信息量,保留)", () => {
    expect(isTrivialLine("const x = 1;")).toBe(false);
    expect(isTrivialLine("'use strict'")).toBe(false);
    expect(isTrivialLine("// 注释")).toBe(false);
    expect(isTrivialLine("中文行")).toBe(false);
    expect(isTrivialLine("0")).toBe(false);
  });
});

// getProjectAILines 归属判定(2026-08-18 修:不再按事件 cwd 精确等值,改为 file_path 落在项目内)。
// 同 store-prune.test.ts 子进程隔离:直接 import lines.ts 连带真实 paths/Store 会碰真实 events.sqlite。
describe("getProjectAILines(子目录 cwd 事件纳入)", () => {
  const TMP = mkdtempSync(join(tmpdir(), "ailines-test-"));
  afterAll(() => rmSync(TMP, { recursive: true, force: true }));

  function runIsolated(scriptBody: string): { code: number; out: string; err: string } {
    const dir = mkdtempSync(join(TMP, "run-"));
    const scriptPath = join(dir, "probe.ts");
    writeFileSync(scriptPath, scriptBody, "utf8");
    const r = Bun.spawnSync(["bun", scriptPath], {
      env: { ...process.env, LOCALAPPDATA: dir },
      cwd: process.cwd(),
    });
    return { code: r.exitCode, out: (r.stdout?.toString() ?? "").trim(), err: (r.stderr?.toString() ?? "").trim() };
  }

  test("子目录/异盘 cwd 的项目内文件入集合;项目外文件与非代码工具排除;Write fallback 与 trivial 过滤生效", () => {
    const storeUrl = pathToFileURL(join(process.cwd(), "src", "daemon", "store.ts")).href;
    const pathsUrl = pathToFileURL(join(process.cwd(), "src", "shared", "paths.ts")).href;
    const linesUrl = pathToFileURL(join(process.cwd(), "src", "daemon", "lines.ts")).href;
    const r = runIsolated(`
const { ensureDirs } = await import(${JSON.stringify(pathsUrl)});
ensureDirs(); // Store 不建目录,全新 LOCALAPPDATA 下缺 db/ 会 SQLITE_CANTOPEN
const { Store } = await import(${JSON.stringify(storeUrl)});
const { getProjectAILines } = await import(${JSON.stringify(linesUrl)});
const store = new Store();
const now = Date.now();
const patch = (lines) => ({ structuredPatch: [{ lines }] });
// ① 项目根 cwd 的 Edit(+ 行与 - 行都入集合)
store.insert({ eventId: "e1", sessionId: "s1", type: "PostToolUse", timestamp: now, cwd: "C:\\\\repo", pid: 1,
  payload: { tool_name: "Edit", tool_input: { file_path: "C:\\\\repo\\\\a.ts" }, tool_response: patch(["+const x = 1;", "+}", "-old line"]) } });
// ② 子目录 cwd 的 Edit(修复点:2026-08-18 前按 cwd 精确等值查会整段漏掉)
store.insert({ eventId: "e2", sessionId: "s2", type: "PostToolUse", timestamp: now, cwd: "C:\\\\repo\\\\sub", pid: 1,
  payload: { tool_name: "Edit", tool_input: { file_path: "C:\\\\repo\\\\sub\\\\b.ts" }, tool_response: patch(["+const y = 2;"]) } });
// ③ 项目外 cwd + 项目外文件 → 不入
store.insert({ eventId: "e3", sessionId: "s3", type: "PostToolUse", timestamp: now, cwd: "C:\\\\other", pid: 1,
  payload: { tool_name: "Edit", tool_input: { file_path: "C:\\\\other\\\\c.ts" }, tool_response: patch(["+const z = 3;"]) } });
// ④ 异盘 cwd 但文件在项目内(绝对路径)→ 入(file_path 归属判定)
store.insert({ eventId: "e4", sessionId: "s4", type: "PostToolUse", timestamp: now, cwd: "D:\\\\elsewhere", pid: 1,
  payload: { tool_name: "Edit", tool_input: { file_path: "C:\\\\repo\\\\d.ts" }, tool_response: patch(["+const w = 4;"]) } });
// ⑤ Write 新建文件(patch 空)fallback content;⑥ Bash 不算代码工具
store.insert({ eventId: "e5", sessionId: "s5", type: "PostToolUse", timestamp: now, cwd: "C:\\\\repo", pid: 1,
  payload: { tool_name: "Write", tool_input: { file_path: "C:\\\\repo\\\\new.ts", content: "line one\\nline two\\n}" } } });
store.insert({ eventId: "e6", sessionId: "s6", type: "PostToolUse", timestamp: now, cwd: "C:\\\\repo", pid: 1,
  payload: { tool_name: "Bash", tool_input: { command: "echo hi" } } });
const m = getProjectAILines(store, "C:\\\\repo");
const out = {};
for (const [k, v] of m) out[k] = [...v].sort();
store.close();
console.log(JSON.stringify(out));
`);
    expect(r.code).toBe(0);
    let res: Record<string, string[]>;
    try {
      res = JSON.parse(r.out);
    } catch {
      throw new Error(`子进程输出非 JSON: out=${JSON.stringify(r.out.slice(0, 300))} err=${JSON.stringify(r.err.slice(0, 300))}`);
    }
    expect(res["a.ts"]).toEqual(["const x = 1;", "old line"]); // + 与 - 行都入集合;trivial "}" 排除
    expect(res["sub/b.ts"]).toEqual(["const y = 2;"]); // 子目录 cwd 修复点
    expect(res["d.ts"]).toEqual(["const w = 4;"]); // 异盘 cwd、项目内文件
    expect(res["new.ts"]).toEqual(["line one", "line two"]); // Write fallback;trivial "}" 排除
    expect(Object.keys(res).filter((k) => k.includes("c.ts") || k.startsWith("../"))).toEqual([]); // 项目外不入
  });
});
