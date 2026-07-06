import type { HookEvent } from "../types";
import { Icon } from "./Icon";
import { EventItem } from "./EventItem";

export function EventList({ events, filtered }: { events: HookEvent[]; filtered: boolean }) {
  if (events.length === 0) {
    return (
      <div className="empty-state">
        <Icon name="inbox" size={30} />
        <span className="es-hint">还没有事件</span>
        <span className="es-sub">在 Claude Code 里开个会话，事件会实时出现在这里</span>
      </div>
    );
  }
  return (
    <ul id="events" className={`event-list${filtered ? " filtered" : ""}`}>
      {events.map((ev) => (
        <EventItem key={ev.eventId} ev={ev} />
      ))}
    </ul>
  );
}
