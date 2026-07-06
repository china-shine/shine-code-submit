// WS 连接池：订阅 EventBus 广播新事件给查看页。鉴权在 server 升级前完成。
import type { ServerWebSocket } from "bun";
import type { EventBus } from "./bus";
import type { Stats } from "./stats";
import type { HookEvent } from "../shared/types";
import { SERVICE_NAME, SERVICE_VERSION } from "../shared/config";

export class WebSocketPool {
  private sockets = new Set<ServerWebSocket<unknown>>();
  private off?: () => void;

  constructor(private bus: EventBus, private stats: Stats) {}

  attach(): void {
    this.off = this.bus.on((event) => this.broadcast(event));
  }

  add(ws: ServerWebSocket<unknown>): void {
    this.sockets.add(ws);
    // 连接即推送一次当前状态快照
    ws.send(
      JSON.stringify({
        kind: "snapshot",
        stats: {
          service: SERVICE_NAME,
          version: SERVICE_VERSION,
          spoolBacklog: this.stats.backlog(),
          eventsPerSec: this.stats.rate(),
          totalEvents: this.stats.total,
        },
      }),
    );
  }

  remove(ws: ServerWebSocket<unknown>): void {
    this.sockets.delete(ws);
  }

  private broadcast(event: HookEvent): void {
    const msg = JSON.stringify({ kind: "event", event });
    for (const ws of this.sockets) {
      try {
        ws.send(msg);
      } catch {
        /* 连接已断，忽略 */
      }
    }
  }

  dispose(): void {
    this.off?.();
    this.sockets.clear();
  }
}
