import { useState } from "react";
import { eventSummary } from "../lib/format";
import { fmtTime } from "../lib/util";
import type { HookEvent } from "../types";
import { EventDetail } from "./EventDetail";

export function EventItem({ ev }: { ev: HookEvent }) {
  const [open, setOpen] = useState(false);
  return (
    <li
      className={`event ${ev.type}${open ? " open" : ""}`}
      title="点击展开/收起完整内容"
      onClick={() => setOpen((v) => !v)}
    >
      <div className="event-row">
        <span className="ts">{fmtTime(ev.timestamp)}</span>
        <span className="type">{ev.type}</span>
        <span className="sess">{ev.sessionId.slice(0, 10)}</span>
        <span className="summary">{eventSummary(ev)}</span>
      </div>
      {open && <EventDetail payload={ev.payload} />}
    </li>
  );
}
