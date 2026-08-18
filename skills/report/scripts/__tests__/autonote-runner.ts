/** autonote.test 的子进程 runner:隔离 env(tmp LOCALAPPDATA/CLAUDE_PROJECT_DIR)下写 fixtures,
 *  调 export 的 autoNote(注入 sig,不打 daemon)/noteWatermark,stdout 回传结果。
 *  主测试进程不 import zentao 侧有写盘行为的函数(纯函数除外),杜绝污染真实 DATA_DIR。 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import * as path from "node:path";

const input = JSON.parse(readFileSync(process.argv[2], "utf8"));
process.env.CLAUDE_PROJECT_DIR = input.claudDir;
process.env.LOCALAPPDATA = input.localAppDir;

const shared = await import("../lib/shared");
const { autoNote, noteWatermark } = await import("../zentao");

const fx = input.fixtures;
const projDir = shared.PROJECT_DIR;
mkdirSync(projDir, { recursive: true });
writeFileSync(shared.SESSIONS_PATH, JSON.stringify({ date: fx.date ?? "2026-08-06", sessions: fx.sessions ?? [] }));
writeFileSync(shared.SUBMITTED_PATH, JSON.stringify(fx.submitted ?? {}));
writeFileSync(shared.CACHE_PATH, JSON.stringify(fx.cache ?? { projects: [], tasks: [], executions: [], taskDetails: {} }));
if (fx.settings) writeFileSync(shared.SETTINGS_PATH, JSON.stringify(fx.settings));
for (const [d, notes] of Object.entries(fx.summaries ?? {})) {
  // tsOffsetMin:相对「runner 本地现在」生成 note.ts(节流用例需要;主进程 bun test 是 TZ=UTC 不能拼时间串)
  const fixed = (notes as any[]).map((n: any) => {
    if (typeof n.tsOffsetMin !== "number") return n;
    const t = new Date(Date.now() + n.tsOffsetMin * 60000);
    const pad = (x: number) => String(x).padStart(2, "0");
    const { ...rest } = n;
    delete rest.tsOffsetMin;
    return { ...rest, ts: `${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())}T${pad(t.getHours())}:${pad(t.getMinutes())}:${pad(t.getSeconds())}` };
  });
  writeFileSync(path.join(projDir, `summary-${d}.json`), JSON.stringify(fixed));
}

try {
  await autoNote(fx.sessionId ?? "s-auto", fx.sig);
  // 回传 projDir 下全部 summary 文件(autoNote 可能新写 fixtures 未列的文件)
  const all: Record<string, any[]> = {};
  const { readdirSync } = await import("node:fs");
  for (const fn of readdirSync(projDir)) {
    const m = /^summary-(\d{4}-\d{2}-\d{2})\.json$/.exec(fn);
    if (!m) continue;
    try { all[m[1]!] = JSON.parse(readFileSync(path.join(projDir, fn), "utf8")); } catch { /* skip */ }
  }
  console.log(JSON.stringify({ ok: true, watermark: noteWatermark(fx.sessionId ?? "s-auto"), summaries: all }));
} catch (e) {
  console.log(JSON.stringify({ ok: false, error: e instanceof Error ? e.message : String(e) }));
}
