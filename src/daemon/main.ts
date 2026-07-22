// Daemon 入口：组装 store/bus/stats/logger/spool/ws/server，写 pid 文件，启动并回捞一次。
import { ensureDirs } from "../shared/paths";
import { writePidFile, readPidFile, removePidFile, readOrCreateToken } from "../shared/pidfile";
import { SERVICE_NAME, SERVICE_VERSION, PORT, SPOOL_SCAN_INTERVAL_MS, LISTEN_HOST } from "../shared/config";
import { isOursAlive } from "../shared/daemonctl";
import { Store } from "./store";
import { EventBus } from "./bus";
import { Stats } from "./stats";
import { Logger } from "./logger";
import { SpoolConsumer } from "./spool-consumer";
import { WebSocketPool } from "./ws";
import { startServer } from "./server";
import { serveUi } from "./ui";
import { scanSessions } from "./claude-scan";

async function main(): Promise<void> {
  ensureDirs();
  const log = new Logger("daemon");

  // 已有自己人的 daemon 在跑 → 复用，不重复启动。
  // 防止 hook/CLI 因瞬时探活失败重复拉起时，第二个实例端口冲突 crash 并误删 pid 文件。
  if (await isOursAlive()) {
    log.info("another shine-code-submit daemon already running; exit without starting");
    process.exit(0);
  }

  const existing = readPidFile();
  if (existing) {
    log.warn("stale pid file on startup", existing);
  }

  const startedAt = Date.now();
  const pid = {
    pid: process.pid,
    port: PORT,
    token: readOrCreateToken(), // 持久 token：升级/重启复用，dashboard 链接不变
    startedAt,
  };
  const store = new Store();
  const bus = new EventBus();
  const stats = new Stats();
  const spool = new SpoolConsumer(store, bus, stats, log);
  const wsPool = new WebSocketPool(bus, stats);

  // 启动即回捞（处理上次崩溃遗留的 spool）
  const recovered = spool.drain();
  if (recovered > 0) log.info(`recovered ${recovered} events from spool on startup`);
  spool.start(SPOOL_SCAN_INTERVAL_MS);
  wsPool.attach();

  // 只清理属于自己的 pid 文件（防止误删他人）
  const ownsPidFile = (): boolean => readPidFile()?.pid === process.pid;

  let server: ReturnType<typeof startServer>;
  const shutdown = (reason: string) => {
    log.info(`shutdown: ${reason}`);
    try { wsPool.dispose(); } catch { /* noop */ }
    try { server.stop(true); } catch { /* noop */ }
    try { store.close(); } catch { /* noop */ }
    if (ownsPidFile()) removePidFile();
    process.exit(0);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("exit", () => {
    if (ownsPidFile()) removePidFile();
    try { store.close(); } catch { /* noop */ }
  });

  server = startServer({
    pid,
    startedAt,
    store,
    bus,
    stats,
    log,
    serveUi,
    onWsOpen: (ws) => wsPool.add(ws),
    onWsClose: (ws) => wsPool.remove(ws),
    shutdown: () => shutdown("api"),
  });

  // 端口绑定成功后才写 pid 文件：hook 与 cli 可能并发拉起 daemon，isOursAlive 存在竞态，
  // 若先写 pid 文件再 bind，bind 失败的实例会覆盖/删除 pid 文件，导致 listening 实例与 pid 文件
  // 不一致（cli stop/restart/ui 据此取 token 会失效）。bind 成功才意味着本实例胜出。
  writePidFile(pid);

  log.info(`${SERVICE_NAME} v${SERVICE_VERSION} listening http://${LISTEN_HOST}:${PORT} pid=${process.pid} token=${pid.token}`);

  // 预热扫描缓存:daemon 启动 500ms 后后台扫一次 transcript 填 scanCache。
  // 用户首次打开 dashboard 时一般已完成(命中 0.22s,避免 ~1.5s 冷扫等待)。
  // 代价:这 1.5s 同步扫描短暂阻塞事件循环,期间 hook 转发可能超时走 spool(事件不丢、延迟入库);500ms 延迟避开初始 SessionStart。
  setTimeout(() => { try { scanSessions(); } catch { /* 预热失败无害,首次请求会再扫 */ } }, 500);
}

try {
  await main();
} catch (err) {
  console.error("fatal:", err);
  process.exit(1);
}
