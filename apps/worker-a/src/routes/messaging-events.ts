/**
 * M-RT-1：GET /api/messaging/events — Owner Gateway SSE（只推 NEW id/cursor）。
 * 无 DO：连接内短间隔读 D1 tip；约 25s 结束由客户端重连。
 */
import { Hono } from 'hono';
import type { Env, AppVariables } from '../env';
import {
  compareCursor,
  readMessagingNotifyTips,
  type MessagingNotifyTip,
} from '../lib/messagingEvents';

type AppEnv = { Bindings: Env; Variables: AppVariables };

/** 单连接最长墙钟时间（秒级 I/O 等待为主，控制 Free 请求占用）。 */
const MAX_STREAM_MS = 25_000;
/** D1 tip 探测间隔 */
const POLL_TIP_MS = 500;
/** SSE 注释心跳，防中间代理空闲断连 */
const HEARTBEAT_MS = 12_000;

export const messagingEventsApp = new Hono<AppEnv>();

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('Aborted', 'AbortError'));
      return;
    }
    const t = setTimeout(resolve, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(new DOMException('Aborted', 'AbortError'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function sseData(obj: unknown): string {
  return `data: ${JSON.stringify(obj)}\n\n`;
}

function sseComment(text: string): string {
  return `: ${text}\n\n`;
}

messagingEventsApp.get('/events', async (c) => {
  const sinceDm = (c.req.query('dm_cursor') ?? '').trim();
  const sinceGroup = (c.req.query('group_cursor') ?? '').trim();
  const signal = c.req.raw.signal;
  const encoder = new TextEncoder();

  let lastDm = sinceDm;
  let lastGroup = sinceGroup;
  const started = Date.now();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const push = (chunk: string) => {
        if (signal.aborted) return;
        controller.enqueue(encoder.encode(chunk));
      };

      push(sseData({ type: 'hello', scopes: ['dm', 'group'] }));

      let lastBeat = Date.now();
      try {
        while (!signal.aborted && Date.now() - started < MAX_STREAM_MS) {
          const tips = await readMessagingNotifyTips(c.env);
          const emitIfNewer = (tip: MessagingNotifyTip | null, last: string): string => {
            if (!tip) return last;
            if (!last || compareCursor(tip.cursor, last) > 0) {
              push(
                sseData({
                  type: 'NEW',
                  scope: tip.scope,
                  id: tip.id,
                  cursor: tip.cursor,
                }),
              );
              return tip.cursor;
            }
            return last;
          };
          lastDm = emitIfNewer(tips.dm, lastDm);
          lastGroup = emitIfNewer(tips.group, lastGroup);

          if (Date.now() - lastBeat >= HEARTBEAT_MS) {
            push(sseComment('ping'));
            lastBeat = Date.now();
          }

          await sleep(POLL_TIP_MS, signal);
        }
        if (!signal.aborted) {
          push(sseData({ type: 'reconnect', reason: 'max_duration' }));
        }
      } catch (err) {
        if (!(err instanceof DOMException && err.name === 'AbortError')) {
          console.error('[messaging-events] stream error', err);
        }
      } finally {
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      }
    },
    cancel() {
      /* 客户端断开 */
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store, no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
});
