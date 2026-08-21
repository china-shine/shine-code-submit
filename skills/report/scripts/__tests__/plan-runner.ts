/** plan.test 的子进程 runner:从 stdin 读 {claudDir, localAppDir, fixtures},
 *  设 env 后 import shared(子进程独立模块图 → 真隔离),写 fixtures 到 tmp,调 cmdPlan,stdout 输出 items。
 *  主测试进程不 import shared/zentao,彻底杜绝模块缓存污染真实数据。 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import * as path from "node:path";

const input = JSON.parse(readFileSync(process.argv[2], "utf8"));
process.env.CLAUDE_PROJECT_DIR = input.claudDir;
process.env.LOCALAPPDATA = input.localAppDir;

const shared = await import("../lib/shared");
const { cmdPlan } = await import("../zentao");

const fx = input.fixtures;
mkdirSync(shared.PROJECT_DIR, { recursive: true });
writeFileSync(shared.SESSIONS_PATH, JSON.stringify({ date: fx.date ?? "2026-08-06", sessions: fx.sessions ?? [] }));
writeFileSync(shared.SUBMITTED_PATH, JSON.stringify(fx.submitted ?? {}));
writeFileSync(shared.MAPPINGS_PATH, JSON.stringify(fx.mappings ?? { repoToProject: {}, branchToTask: {} }));
writeFileSync(shared.CACHE_PATH, JSON.stringify(fx.cache ?? { projects: [{ id: 1, name: "P1" }], tasks: [], executions: [], taskDetails: {} }));
for (const [d, notes] of Object.entries(fx.summaries ?? {})) {
  writeFileSync(path.join(shared.PROJECT_DIR, `summary-${d}.json`), JSON.stringify(notes));
}
// daemon 预提取 signals fixture:DATA_DIR/signals/<编码项目>/<date>/<sid>.json(聚合盲区兜底读这里)
for (const [d, entries] of Object.entries(fx.signals ?? {})) {
  for (const ent of entries) {
    const dir = path.join(shared.DATA_DIR, "signals", shared.encodeProject(shared.PROJECT_CWD), d);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, `${ent.id}.json`), JSON.stringify(ent.signals));
  }
}

try {
  const plan = await cmdPlan(undefined, undefined);
  // sinceEpoch/midnightEpoch 对照:多天补报起点逻辑(lastSubmitSinceEpoch)在 runner 侧算,
  // 主测试进程 bun test 是 TZ=UTC、会拼出与本地差 8h 的时间,不能在主进程对比。
  console.log(JSON.stringify({
    ok: true,
    items: plan.items,
    alreadyCount: plan.alreadyCount,
    sinceEpoch: shared.lastSubmitSinceEpoch(),
    sinceISO: shared.localDateISO(shared.lastSubmitSinceEpoch()), // 日期转换在 runner 侧(真本地)做完再传
    midnightEpoch: shared.localMidnightEpoch(),
  }));
} catch (e) {
  console.log(JSON.stringify({ ok: false, error: e instanceof Error ? e.message : String(e) }));
}
