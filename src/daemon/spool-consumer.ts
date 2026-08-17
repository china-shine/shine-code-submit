// spool 消费器（回捞路径）：扫目录 → 幂等入库 → 推总线 → 删除（删除即确认）。
// 与 HTTP 热路径共享 store.insert 幂等逻辑，互为兜底。
import { listSpool, removeSpoolFile } from "../shared/spool";
import type { Store } from "./store";
import type { EventBus } from "./bus";
import type { Stats } from "./stats";
import type { Logger } from "./logger";

export class SpoolConsumer {
  constructor(
    private store: Store,
    private bus: EventBus,
    private stats: Stats,
    private log: Logger,
  ) {}

  /** 扫描并消费全部 spool。返回本次新入库条数。 */
  drain(): number {
    const entries = listSpool((name, err) =>
      this.log.warn(`spool corrupt, skipping ${name}`, err),
    );
    let n = 0;
    for (const { name, event } of entries) {
      try {
        if (this.store.insert(event)) {
          this.bus.emit(event);
          this.stats.recordEvent();
          n++;
          this.log.info(`ingest spool ${event.type} ${name}`);
        } else {
          this.log.debug(`dedup spool ${name}`);
        }
      } catch (err) {
        this.stats.recordError(`spool ingest failed: ${name}`);
        this.log.error(`spool ingest failed ${name}`, err);
      }
      removeSpoolFile(name); // 无论新插入还是去重，都已确认
    }
    return n;
  }

  start(intervalMs: number): void {
    const tick = () => {
      try {
        this.drain();
      } catch (err) {
        this.log.error("spool tick failed", err);
      }
    };
    setInterval(tick, intervalMs);
  }
}
