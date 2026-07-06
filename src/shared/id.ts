// 稳定事件 id：基于事件内容派生（而非 hook 进程随机生成），用于幂等去重。
// 同一语义事件即使被多个 hook 进程采集（如 settings.json + plugin 双注册，
// 或他人全局 hook 与本 plugin 并存），只要 sessionId/type/payload 相同，
// 派生出的 eventId 就相同，store 的 PRIMARY KEY (session_id, event_id) 即可去重。
// 不含 timestamp——两个采集进程的时间戳差几十 ms，跨秒边界会让派生值错开而漏去重。
import { createHash } from "node:crypto";
import type { HookEvent } from "./types";

export function deriveStableEventId(
  ev: Pick<HookEvent, "type" | "sessionId" | "payload">,
): string {
  const h = createHash("sha1");
  h.update(ev.type);
  h.update("\x00");
  h.update(ev.sessionId);
  h.update("\x00");
  h.update(JSON.stringify(ev.payload ?? null));
  return h.digest("hex");
}
