/**
 * M-RT-1：订阅 Owner Gateway 消息 SSE（Authorization Bearer；非 EventSource）。
 * 事件仅含 type/scope/id/cursor，不含明文。
 */
import { stripTrailingSlash } from './auth';

export type MessagingSseEvent =
  | { readonly type: 'hello'; readonly scopes?: readonly string[] }
  | { readonly type: 'NEW'; readonly scope: 'dm' | 'group'; readonly id: string; readonly cursor: string }
  | { readonly type: 'reconnect'; readonly reason?: string };

export interface MessagingEventsSubscription {
  readonly stop: () => void;
}

export interface SubscribeMessagingEventsOptions {
  readonly baseUrl: string;
  readonly getJwt: () => string | null;
  readonly dmCursor?: string;
  readonly groupCursor?: string;
  readonly onEvent: (ev: MessagingSseEvent) => void;
  readonly onStatus?: (connected: boolean) => void;
  /** 断线后重连延迟 ms（默认 800） */
  readonly reconnectMs?: number;
}

function parseSseChunk(buffer: string): { readonly events: string[]; readonly rest: string } {
  const parts = buffer.split('\n\n');
  const rest = parts.pop() ?? '';
  const events: string[] = [];
  for (const block of parts) {
    const dataLines = block
      .split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart());
    if (dataLines.length === 0) continue;
    events.push(dataLines.join('\n'));
  }
  return { events, rest };
}

function parseEventJson(raw: string): MessagingSseEvent | null {
  try {
    const obj = JSON.parse(raw) as MessagingSseEvent;
    if (!obj || typeof obj !== 'object' || typeof (obj as { type?: unknown }).type !== 'string') {
      return null;
    }
    return obj;
  } catch {
    return null;
  }
}

/** 打开可见消息页时调用；离开页 /stop 取消。 */
export function subscribeMessagingEvents(
  opts: SubscribeMessagingEventsOptions,
): MessagingEventsSubscription {
  const reconnectMs = opts.reconnectMs ?? 800;
  let stopped = false;
  let abort: AbortController | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let dmCursor = opts.dmCursor ?? '';
  let groupCursor = opts.groupCursor ?? '';

  const clearTimer = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  };

  const scheduleReconnect = () => {
    clearTimer();
    if (stopped) return;
    timer = setTimeout(() => void runLoop(), reconnectMs);
  };

  const runLoop = async () => {
    if (stopped) return;
    const jwt = opts.getJwt();
    const base = stripTrailingSlash(opts.baseUrl);
    if (!jwt || !base) {
      opts.onStatus?.(false);
      scheduleReconnect();
      return;
    }

    abort?.abort();
    abort = new AbortController();
    const qs = new URLSearchParams();
    if (dmCursor) qs.set('dm_cursor', dmCursor);
    if (groupCursor) qs.set('group_cursor', groupCursor);
    const url = `${base}/api/messaging/events${qs.toString() ? `?${qs}` : ''}`;

    try {
      const res = await fetch(url, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${jwt}`,
          Accept: 'text/event-stream',
        },
        signal: abort.signal,
      });
      if (!res.ok || !res.body) {
        opts.onStatus?.(false);
        scheduleReconnect();
        return;
      }
      opts.onStatus?.(true);
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      while (!stopped) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const parsed = parseSseChunk(buf);
        buf = parsed.rest;
        for (const raw of parsed.events) {
          const ev = parseEventJson(raw);
          if (!ev) continue;
          if (ev.type === 'NEW') {
            if (ev.scope === 'dm') dmCursor = ev.cursor;
            if (ev.scope === 'group') groupCursor = ev.cursor;
          }
          opts.onEvent(ev);
        }
      }
      opts.onStatus?.(false);
    } catch {
      opts.onStatus?.(false);
    }
    if (!stopped) scheduleReconnect();
  };

  void runLoop();

  return {
    stop() {
      stopped = true;
      clearTimer();
      abort?.abort();
      opts.onStatus?.(false);
    },
  };
}
