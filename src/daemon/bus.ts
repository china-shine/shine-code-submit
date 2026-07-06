// 进程内事件总线：热路径与回捞入库后都向其 emit，WS 与 stats 订阅。
import type { HookEvent } from "../shared/types";

export type EventListener = (event: HookEvent) => void;

export class EventBus {
  private listeners = new Set<EventListener>();

  on(fn: EventListener): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  emit(event: HookEvent): void {
    for (const fn of this.listeners) {
      try {
        fn(event);
      } catch {
        /* 单个订阅者失败不影响其他 */
      }
    }
  }
}
