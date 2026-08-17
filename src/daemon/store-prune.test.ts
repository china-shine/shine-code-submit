// events 滚动修剪单测(2026-08-17 恢复入库+7天修剪方案)。
// ⚠️ 必须子进程隔离:paths.ts 的 DB_FILE 在模块 import 时按 LOCALAPPDATA 求值,bun test 单进程共享模块注册表——
// 若本文件先被别的测试 import 了真实 paths,直接 new Store() 会写到/删到真实 events.sqlite。
import { describe, test, expect, afterAll } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const TMP = mkdtempSync(join(tmpdir(), "store-prune-test-"));
afterAll(() => rmSync(TMP, { recursive: true, force: true }));

/** 在独立子进程(独立 LOCALAPPDATA→独立 SQLite)里跑断言脚本,stdout 回传结果。
 *  用临时脚本文件而非 bun -e:test 环境下 spawn 的 -e 传参不可靠(子进程打出 CLI 帮助)。
 *  每次调用独立 mkdtemp——多个用例不共用同一个临时库。 */
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

/** 解析子进程 stdout 的 JSON;非 JSON 时把原始内容抛出来便于定位。 */
function parseOut(r: { code: number; out: string; err: string }): any {
  try {
    return JSON.parse(r.out);
  } catch {
    throw new Error(`子进程输出非 JSON: out=${JSON.stringify(r.out.slice(0, 300))} err=${JSON.stringify(r.err.slice(0, 300))}`);
  }
}

describe("Store.pruneEvents(7 天滚动修剪)", () => {
  test("只删过期行、保留近期行、幂等、可收紧窗口", () => {
    const storeUrl = pathToFileURL(join(process.cwd(), "src", "daemon", "store.ts")).href;
    const pathsUrl = pathToFileURL(join(process.cwd(), "src", "shared", "paths.ts")).href;
    const r = runIsolated(`
const { ensureDirs } = await import(${JSON.stringify(pathsUrl)});
ensureDirs(); // Store 不建目录(main.ts 先 ensureDirs);全新 LOCALAPPDATA 下缺 db/ 会 SQLITE_CANTOPEN
const { Store } = await import(${JSON.stringify(storeUrl)});
const store = new Store();
const now = Date.now();
const D = 86400000;
store.insert({ eventId: "old-1", sessionId: "s1", type: "PostToolUse", timestamp: now - 8*D, cwd: "C:\\\\p", pid: 1, payload: { a: 1 } });
store.insert({ eventId: "mid-1", sessionId: "s1", type: "PostToolUse", timestamp: now - 6*D, cwd: "C:\\\\p", pid: 1, payload: { a: 2 } });
store.insert({ eventId: "new-1", sessionId: "s2", type: "UserPromptSubmit", timestamp: now, cwd: "C:\\\\p", pid: 1, payload: { a: 3 } });
const n1 = store.pruneEvents(7*D);
const c1 = store.count();
const n2 = store.pruneEvents(7*D);
const n3 = store.pruneEvents(5*D);
const c2 = store.count();
store.close();
console.log(JSON.stringify({ n1, c1, n2, n3, c2 }));
`);
    expect(r.code).toBe(0);
    const res = parseOut(r);
    expect(res).toEqual({ n1: 1, c1: 2, n2: 0, n3: 1, c2: 1 }); // 8天前删1留2 → 幂等0 → 缩窗到5天再删1留1
  });

  test("子进程确实用了隔离库(非真实 events.sqlite)", () => {
    const storeUrl = pathToFileURL(join(process.cwd(), "src", "daemon", "store.ts")).href;
    const pathsUrl = pathToFileURL(join(process.cwd(), "src", "shared", "paths.ts")).href;
    const r = runIsolated(`
const { ensureDirs } = await import(${JSON.stringify(pathsUrl)});
ensureDirs();
const { Store } = await import(${JSON.stringify(storeUrl)});
const store = new Store();
console.log(JSON.stringify({ count: store.count() }));
store.close();
`);
    expect(r.code).toBe(0);
    expect(parseOut(r).count).toBe(0); // 全新库必为空;真实库非空即隔离失败
  });
});
