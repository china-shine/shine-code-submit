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
import { TranscriptWatcher } from "./watcher";
import { TranscriptConsumer } from "./transcript-consumer";

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
  // SQLite 数据中枢:watcher 标 dirty,消费者增量算。P1 并行(前端仍读 scanSessions 内存),P2 切 SQLite。
  const watcher = new TranscriptWatcher(store);
  const consumer = new TranscriptConsumer(store);

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
    try { watcher.stop(); } catch { /* noop */ }
    try { consumer.stop(); } catch { /* noop */ }
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

  // SQLite 数据中枢启动:watcher 监听文件变化标 dirty,消费者 2s tick 增量算 + 5min 兜底全扫。
  watcher.start();
  consumer.start();

  log.info(`${SERVICE_NAME} v${SERVICE_VERSION} listening http://${LISTEN_HOST}:${PORT} pid=${process.pid} token=${pid.token}`);
}

try {
  await main();
} catch (err) {
  console.error("fatal:", err);
  process.exit(1);
}
