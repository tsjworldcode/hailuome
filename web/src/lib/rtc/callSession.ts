/**
 * M-RTC-1：1:1 语音通话会话控制器（浏览器端）。
 * 信令经 DM E2EE；媒体经 WebRTC SRTP。不落盘 SDP。
 */
import type { createWorkerAClient } from '../workerA';
import type { createWorkerBClient } from '../api';
import {
  attachLocalAudio,
  createCompleteAnswer,
  createCompleteOffer,
  createVoicePeerConnection,
  setMuted,
  stopMediaStream,
} from './peerConnection';
import {
  CALL_RING_TIMEOUT_MS,
  newCallId,
  type CallSignalPayload,
  type CallSignalState,
  type CallUiSnapshot,
} from './types';

type WorkerAClient = ReturnType<typeof createWorkerAClient>;
type WorkerBClient = ReturnType<typeof createWorkerBClient>;

export interface CallSignalTransport {
  send: (signal: CallSignalPayload, peerHandle: string) => Promise<void>;
}

type Listener = (snap: CallUiSnapshot) => void;

const idleSnap = (): CallUiSnapshot => ({
  phase: 'idle',
  callId: null,
  peerHandle: null,
  muted: false,
  error: null,
  startedAt: null,
});

class CallSessionController {
  private snap: CallUiSnapshot = idleSnap();
  private listeners = new Set<Listener>();
  private pc: RTCPeerConnection | null = null;
  private localStream: MediaStream | null = null;
  private remoteStream: MediaStream | null = null;
  private remoteAudio: HTMLAudioElement | null = null;
  private ringTimer: ReturnType<typeof setTimeout> | null = null;
  private processedMsgIds = new Set<string>();
  private transport: CallSignalTransport | null = null;

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    listener(this.snap);
    return () => this.listeners.delete(listener);
  }

  getSnapshot(): CallUiSnapshot {
    return this.snap;
  }

  getRemoteStream(): MediaStream | null {
    return this.remoteStream;
  }

  configure(input: {
    meHandle: string;
    transport: CallSignalTransport;
  }): void {
    void input.meHandle;
    this.transport = input.transport;
  }

  private emit(partial: Partial<CallUiSnapshot>): void {
    this.snap = { ...this.snap, ...partial };
    for (const l of this.listeners) l(this.snap);
  }

  private clearRingTimer(): void {
    if (this.ringTimer) {
      clearTimeout(this.ringTimer);
      this.ringTimer = null;
    }
  }

  private async sendState(
    state: CallSignalState,
    peerHandle: string,
    extra?: Partial<CallSignalPayload>,
  ): Promise<void> {
    if (!this.transport || !this.snap.callId) return;
    const signal: CallSignalPayload = {
      v: 1,
      kind: 'CALL_SIGNAL',
      call_id: this.snap.callId,
      state,
      ...extra,
    };
    await this.transport.send(signal, peerHandle);
  }

  private ensureRemoteAudio(): HTMLAudioElement {
    if (this.remoteAudio) return this.remoteAudio;
    const el = document.createElement('audio');
    el.autoplay = true;
    el.setAttribute('playsinline', 'true');
    el.style.display = 'none';
    document.body.appendChild(el);
    this.remoteAudio = el;
    return el;
  }

  private bindPc(pc: RTCPeerConnection): void {
    this.pc = pc;
  }

  private async teardownMedia(): Promise<void> {
    this.clearRingTimer();
    if (this.pc) {
      try {
        this.pc.close();
      } catch {
        // ignore
      }
      this.pc = null;
    }
    stopMediaStream(this.localStream);
    this.localStream = null;
    this.remoteStream = null;
    if (this.remoteAudio) {
      this.remoteAudio.srcObject = null;
      this.remoteAudio.remove();
      this.remoteAudio = null;
    }
  }

  async startOutgoing(peerHandle: string): Promise<void> {
    const peer = peerHandle.trim().toLowerCase();
    if (!peer || !this.transport) throw new Error('通话未就绪');
    if (this.snap.phase !== 'idle' && this.snap.phase !== 'ended') {
      throw new Error('已有进行中的通话');
    }
    await this.teardownMedia();
    const callId = newCallId();
    this.emit({
      phase: 'outgoing',
      callId,
      peerHandle: peer,
      muted: false,
      error: null,
      startedAt: null,
    });

    try {
      const pc = createVoicePeerConnection({
        onRemoteStream: (stream) => {
          this.remoteStream = stream;
          const audio = this.ensureRemoteAudio();
          audio.srcObject = stream;
          void audio.play().catch(() => {});
        },
        onConnectionState: (state) => {
          if (state === 'connected') {
            this.clearRingTimer();
            this.emit({
              phase: 'connected',
              startedAt: this.snap.startedAt ?? Date.now(),
            });
          } else if (state === 'failed' || state === 'closed' || state === 'disconnected') {
            if (this.snap.phase === 'connected' || this.snap.phase === 'connecting') {
              void this.hangupLocal('连接中断');
            }
          }
        },
      });
      this.bindPc(pc);
      this.localStream = await attachLocalAudio(pc);
      const offer = await createCompleteOffer(pc);
      await this.sendState('invite', peer, {
        sdp: offer.sdp,
        sdp_type: 'offer',
      });
      this.ringTimer = setTimeout(() => {
        void this.missedLocal();
      }, CALL_RING_TIMEOUT_MS);
    } catch (err) {
      await this.teardownMedia();
      this.emit({
        phase: 'ended',
        error: err instanceof Error ? err.message : '无法发起通话',
        callId: null,
        peerHandle: null,
      });
      throw err;
    }
  }

  async acceptIncoming(): Promise<void> {
    if (this.snap.phase !== 'incoming' || !this.snap.peerHandle || !this.snap.callId) {
      return;
    }
    const peer = this.snap.peerHandle;
    this.clearRingTimer();
    this.emit({ phase: 'connecting', error: null });
    try {
      if (!this.pc) throw new Error('通话会话已失效');
      this.localStream = await attachLocalAudio(this.pc);
      const answer = await createCompleteAnswer(this.pc);
      await this.sendState('accept', peer, {
        sdp: answer.sdp,
        sdp_type: 'answer',
      });
      this.emit({ phase: 'connecting', startedAt: Date.now() });
    } catch (err) {
      await this.sendState('reject', peer).catch(() => {});
      await this.teardownMedia();
      this.emit({
        phase: 'ended',
        error: err instanceof Error ? err.message : '无法接听',
        callId: null,
        peerHandle: null,
      });
    }
  }

  async rejectIncoming(): Promise<void> {
    if (this.snap.phase !== 'incoming' || !this.snap.peerHandle) return;
    const peer = this.snap.peerHandle;
    this.clearRingTimer();
    try {
      await this.sendState('reject', peer);
    } catch {
      // 拒绝信令失败仍结束本地
    }
    await this.teardownMedia();
    this.emit({ phase: 'ended', callId: null, peerHandle: null, error: null });
  }

  async hangup(): Promise<void> {
    const peer = this.snap.peerHandle;
    const phase = this.snap.phase;
    if (!peer || phase === 'idle' || phase === 'ended') {
      await this.teardownMedia();
      this.emit(idleSnap());
      return;
    }
    try {
      await this.sendState('hangup', peer);
    } catch {
      // ignore
    }
    await this.teardownMedia();
    this.emit({ phase: 'ended', callId: null, peerHandle: null, error: null, muted: false });
  }

  private async hangupLocal(error: string | null): Promise<void> {
    await this.teardownMedia();
    this.emit({
      phase: 'ended',
      callId: null,
      peerHandle: null,
      error,
      muted: false,
      startedAt: null,
    });
  }

  private async missedLocal(): Promise<void> {
    const peer = this.snap.peerHandle;
    if (this.snap.phase !== 'outgoing' || !peer) return;
    try {
      await this.sendState('missed', peer);
    } catch {
      // ignore
    }
    await this.teardownMedia();
    this.emit({
      phase: 'ended',
      callId: null,
      peerHandle: null,
      error: '对方未接听',
      muted: false,
    });
  }

  toggleMute(): void {
    const next = !this.snap.muted;
    setMuted(this.localStream, next);
    this.emit({ muted: next });
  }

  /** 收件箱解密后投递信令；message_id 去重。 */
  async handleInboundSignal(input: {
    messageId: string;
    peerHandle: string;
    direction: 'inbox' | 'outbox';
    signal: CallSignalPayload;
  }): Promise<void> {
    if (this.processedMsgIds.has(input.messageId)) return;
    this.processedMsgIds.add(input.messageId);
    if (this.processedMsgIds.size > 200) {
      const first = this.processedMsgIds.values().next().value;
      if (first) this.processedMsgIds.delete(first);
    }

    // 自己 outbox 回显：邀请已在本地发出，忽略
    if (input.direction === 'outbox') return;

    const { signal, peerHandle } = input;
    const peer = peerHandle.trim().toLowerCase();

    switch (signal.state) {
      case 'invite': {
        if (this.snap.phase !== 'idle' && this.snap.phase !== 'ended') {
          // 忙线：自动拒绝
          if (this.transport) {
            await this.transport
              .send(
                {
                  v: 1,
                  kind: 'CALL_SIGNAL',
                  call_id: signal.call_id,
                  state: 'reject',
                },
                peer,
              )
              .catch(() => {});
          }
          return;
        }
        if (!signal.sdp || signal.sdp_type !== 'offer') return;
        await this.teardownMedia();
        const pc = createVoicePeerConnection({
          onRemoteStream: (stream) => {
            this.remoteStream = stream;
            const audio = this.ensureRemoteAudio();
            audio.srcObject = stream;
            void audio.play().catch(() => {});
          },
          onConnectionState: (state) => {
            if (state === 'connected') {
              this.clearRingTimer();
              this.emit({
                phase: 'connected',
                startedAt: this.snap.startedAt ?? Date.now(),
              });
            } else if (state === 'failed' || state === 'closed') {
              if (this.snap.phase === 'connected' || this.snap.phase === 'connecting') {
                void this.hangupLocal('连接中断');
              }
            }
          },
        });
        this.bindPc(pc);
        await pc.setRemoteDescription({ type: 'offer', sdp: signal.sdp });
        this.emit({
          phase: 'incoming',
          callId: signal.call_id,
          peerHandle: peer,
          muted: false,
          error: null,
          startedAt: null,
        });
        this.ringTimer = setTimeout(() => {
          void this.rejectIncoming();
        }, CALL_RING_TIMEOUT_MS);
        break;
      }
      case 'accept': {
        if (
          this.snap.phase !== 'outgoing' ||
          this.snap.callId !== signal.call_id ||
          !this.pc ||
          !signal.sdp
        ) {
          return;
        }
        this.clearRingTimer();
        this.emit({ phase: 'connecting' });
        await this.pc.setRemoteDescription({ type: 'answer', sdp: signal.sdp });
        break;
      }
      case 'reject':
      case 'missed':
      case 'hangup': {
        if (this.snap.callId && this.snap.callId !== signal.call_id) return;
        if (this.snap.phase === 'idle') return;
        await this.teardownMedia();
        const err =
          signal.state === 'reject'
            ? '对方已拒绝'
            : signal.state === 'missed'
              ? '未接听'
              : null;
        this.emit({
          phase: 'ended',
          callId: null,
          peerHandle: null,
          error: err,
          muted: false,
          startedAt: null,
        });
        break;
      }
      default:
        break;
    }
  }

  /** 测试/登出时复位 */
  async reset(): Promise<void> {
    await this.teardownMedia();
    this.emit(idleSnap());
    this.processedMsgIds.clear();
  }
}

export const callSession = new CallSessionController();

/** 供 UI 组装 transport 时复用类型（避免循环依赖）。 */
export type { WorkerAClient, WorkerBClient };
