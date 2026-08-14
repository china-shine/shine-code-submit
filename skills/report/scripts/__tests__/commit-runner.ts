/** commit.test 的子进程 runner:隔离 env(tmp LOCALAPPDATA/CLAUDE_PROJECT_DIR)下跑
 *  cmdCommit(mock Client,不打真禅道)→ 验证提交流水 append + daemon collectWorklogs 读回,
 *  覆盖「commit → submitted/<date>.jsonl → worklogs(subId)」全链路。 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import * as path from "node:path";

const input = JSON.parse(readFileSync(process.argv[2], "utf8"));
process.env.CLAUDE_PROJECT_DIR = input.claudDir;
process.env.LOCALAPPDATA = input.localAppDir;

const shared = await import("../lib/shared");
const { cmdCommit } = await import("../zentao");
// daemon 侧 worklog.ts 与 skills 共用 %LOCALAPPDATA%/shine-worklog 布局,同 env 下可直接读流水
const { collectWorklogs } = await import("../../../../src/daemon/worklog");

const fx = input.fixtures;
mkdirSync(shared.PROJECT_DIR, { recursive: true });
writeFileSync(shared.PLAN_PATH, JSON.stringify(fx.plan));
writeFileSync(shared.SUBMITTED_PATH, JSON.stringify(fx.submitted ?? {}));
writeFileSync(shared.MAPPINGS_PATH, JSON.stringify(fx.mappings ?? { repoToProject: {}, branchToTask: {} }));
if (fx.settings) writeFileSync(shared.SETTINGS_PATH, JSON.stringify(fx.settings));

// mock Client:不打网络,全部返回提交成功;记录调用参数供断言
const calls: unknown[] = [];
const client = {
  submitEffort: async (taskId: number, date: string, hours: number, work: string) => {
    calls.push({ taskId, date, hours, work });
    return { submitted: true, task: { id: taskId, name: `T${taskId}` }, left: 0 };
  },
} as any;

try {
  const result = await cmdCommit(client, { dryRun: false, amend: !!fx.amend });
  let logText = "";
  try { logText = readFileSync(path.join(shared.SUBMITTED_LOG_DIR, `${fx.plan.date}.jsonl`), "utf8"); } catch { /* 无文件 = 空串 */ }
  console.log(JSON.stringify({ ok: true, calls, result, logText, worklogs: collectWorklogs() }));
} catch (e) {
  console.log(JSON.stringify({ ok: false, error: e instanceof Error ? e.message : String(e) }));
}
