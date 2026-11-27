/**
 * M-RTC-1：经现有 DM 投递链发送 CALL_SIGNAL（不入聊天气泡）。
 */
import { sendDmCallSignal } from '../dmService';
import type { createWorkerAClient } from '../workerA';
import type { createWorkerBClient } from '../api';
import type { CallSignalPayload } from './types';
import type { CallSignalTransport } from './callSession';

type WorkerAClient = ReturnType<typeof createWorkerAClient>;
type WorkerBClient = ReturnType<typeof createWorkerBClient>;

export function createDmCallSignalTransport(input: {
  client: WorkerAClient;
  api: WorkerBClient;
  senderHandle: string;
  senderWorkerBUrl: string;
  passwordHash: string;
  resolvePeer: (handle: string) => Promise<{
    worker_b_url: string;
    dm_pubkey: string;
  }>;
}): CallSignalTransport {
  return {
    async send(signal: CallSignalPayload, peerHandle: string) {
      const peer = await input.resolvePeer(peerHandle);
      if (!peer.dm_pubkey) throw new Error('对方尚未开启私信');
      await sendDmCallSignal({
        client: input.client,
        api: input.api,
        senderHandle: input.senderHandle,
        senderWorkerBUrl: input.senderWorkerBUrl,
        recipientHandle: peerHandle,
        recipientWorkerBUrl: peer.worker_b_url,
        recipientDmPubkey: peer.dm_pubkey,
        passwordHash: input.passwordHash,
        signal,
      });
    },
  };
}
