/** @jsxImportSource preact */
import { useEffect, useState } from 'preact/hooks';
import { Mic, MicOff, Phone, PhoneOff } from 'lucide-preact';
import { callSession, type CallUiSnapshot } from '../lib/rtc';
import { t } from '../lib/i18n';

function formatElapsed(startedAt: number | null): string {
  if (!startedAt) return '0:00';
  const sec = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

/** M-RTC-1：来电 / 通话中浮层（仅语音）。 */
export function RtcCallOverlay() {
  const [snap, setSnap] = useState<CallUiSnapshot>(() => callSession.getSnapshot());
  const [tick, setTick] = useState(0);

  useEffect(() => callSession.subscribe(setSnap), []);

  useEffect(() => {
    if (snap.phase !== 'connected' && snap.phase !== 'connecting') return;
    const id = window.setInterval(() => setTick((n) => n + 1), 1000);
    return () => window.clearInterval(id);
  }, [snap.phase]);

  if (snap.phase === 'idle') return null;
  if (snap.phase === 'ended') {
    if (!snap.error) return null;
    return (
      <div
        class="fixed inset-x-0 top-0 z-50 flex justify-center p-3"
        role="status"
        aria-live="polite"
      >
        <div class="rounded-xl border border-zinc-200 bg-white px-4 py-2 text-sm text-zinc-800 shadow-lg dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100">
          {snap.error}
          <button
            type="button"
            class="ml-3 text-sky-600 underline dark:text-sky-400"
            onClick={() => void callSession.reset()}
          >
            {t('rtcDismiss')}
          </button>
        </div>
      </div>
    );
  }

  const peer = snap.peerHandle ? `@${snap.peerHandle}` : '';
  const title =
    snap.phase === 'incoming'
      ? t('rtcIncomingTitle')
      : snap.phase === 'outgoing'
        ? t('rtcOutgoingTitle')
        : snap.phase === 'connecting'
          ? t('rtcConnectingTitle')
          : t('rtcInCallTitle');

  void tick;

  return (
    <div
      class="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-4 sm:items-center"
      role="dialog"
      aria-modal="true"
      aria-label={title}
    >
      <div class="w-full max-w-sm rounded-2xl border border-zinc-200 bg-white p-5 shadow-xl dark:border-zinc-700 dark:bg-zinc-900">
        <p class="text-center text-xs font-medium uppercase tracking-wide text-zinc-500">
          {title}
        </p>
        <p class="mt-2 text-center text-xl font-semibold text-zinc-900 dark:text-zinc-50">
          {peer}
        </p>
        {(snap.phase === 'connected' || snap.phase === 'connecting') && (
          <p class="mt-1 text-center text-sm text-zinc-500">
            {formatElapsed(snap.startedAt)}
          </p>
        )}

        <div class="mt-6 flex items-center justify-center gap-4">
          {snap.phase === 'incoming' ? (
            <>
              <button
                type="button"
                class="flex h-14 w-14 items-center justify-center rounded-full bg-emerald-600 text-white shadow hover:bg-emerald-500"
                aria-label={t('rtcAccept')}
                onClick={() => void callSession.acceptIncoming()}
              >
                <Phone size={22} aria-hidden="true" />
              </button>
              <button
                type="button"
                class="flex h-14 w-14 items-center justify-center rounded-full bg-rose-600 text-white shadow hover:bg-rose-500"
                aria-label={t('rtcReject')}
                onClick={() => void callSession.rejectIncoming()}
              >
                <PhoneOff size={22} aria-hidden="true" />
              </button>
            </>
          ) : (
            <>
              {(snap.phase === 'connected' || snap.phase === 'connecting') && (
                <button
                  type="button"
                  class={`flex h-12 w-12 items-center justify-center rounded-full ${
                    snap.muted
                      ? 'bg-zinc-800 text-white'
                      : 'bg-zinc-100 text-zinc-800 dark:bg-zinc-800 dark:text-zinc-100'
                  }`}
                  aria-label={snap.muted ? t('rtcUnmute') : t('rtcMute')}
                  aria-pressed={snap.muted}
                  onClick={() => callSession.toggleMute()}
                >
                  {snap.muted ? (
                    <MicOff size={20} aria-hidden="true" />
                  ) : (
                    <Mic size={20} aria-hidden="true" />
                  )}
                </button>
              )}
              <button
                type="button"
                class="flex h-14 w-14 items-center justify-center rounded-full bg-rose-600 text-white shadow hover:bg-rose-500"
                aria-label={t('rtcHangup')}
                onClick={() => void callSession.hangup()}
              >
                <PhoneOff size={22} aria-hidden="true" />
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
