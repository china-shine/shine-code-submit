import { useEffect, useRef } from "react";
import type { HookEvent, WsMessage } from "../types";

/**
 * WS 连接 + 2s 自动重连。onEvent 用 ref 存最新值，effect 只依赖 token，
 * 避免 onEvent 变化导致连接重建。onEvent 传 null 时不分发事件（仍保持连接）。
 */
export function useWebSocket(token: string, onEvent: ((ev: HookEvent) => void) | null): void {
  const ref = useRef(onEvent);
  ref.current = onEvent;
  useEffect(() => {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    let ws: WebSocket | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let closed = false;
    const connect = () => {
      ws = new WebSocket(`${proto}://${location.host}/api/ws?t=${encodeURIComponent(token)}`);
      ws.onmessage = (m) => {
        try {
          const msg = JSON.parse(typeof m.data === "string" ? m.data : "") as WsMessage;
          if (msg.kind === "event" && ref.current) ref.current(msg.event);
        } catch (e) {
          console.warn("ws msg", e);
        }
      };
      ws.onclose = () => {
        if (!closed) timer = setTimeout(connect, 2000);
      };
      ws.onerror = () => ws?.close();
    };
    connect();
    return () => {
      closed = true;
      if (timer) clearTimeout(timer);
      ws?.close();
    };
  }, [token]);
}
