// 运行指标：滑动窗口算 events/sec、累计总数、最近错误、spool 积压。
import { STATS_WINDOW_MS } from "../shared/config";
import { countSpool } from "../shared/spool";

export class Stats {
  private stamps: number[] = [];
  total = 0;
  lastError: { time: number; message: string } | null = null;

  recordEvent(now = Date.now()): void {
    this.stamps.push(now);
    this.total++;
    this.gc(now);
  }

  recordError(message: string, now = Date.now()): void {
    this.lastError = { time: now, message };
  }

  private gc(now: number): void {
    const cutoff = now - STATS_WINDOW_MS;
    while (this.stamps.length && (this.stamps[0] ?? 0) < cutoff) this.stamps.shift();
  }

  rate(now = Date.now()): number {
    this.gc(now);
    return this.stamps.length / (STATS_WINDOW_MS / 1000);
  }

  backlog(): number {
    return countSpool();
  }
}
