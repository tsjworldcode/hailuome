/**
 * NCF-2D3：Messaging Media 发送方 serve 验票深模块类型。
 * 契约见 docs/m-refactor-ncf-2-plan.md §5.8。
 * 注意：不得解密 ciphertext；blob 读取留在路由 serveMediaObject。
 */
import type { DmEnvelope, DmMediaFetchTicket, GroupMediaFetchTicket, GroupMessageEnvelope } from '@hailuo/shared-types';

export type ServeMessagingMediaStatus =
  | 'ok'
  | 'ticket_invalid'
  | 'forbidden'
  | 'not_found'
  | 'internal_error';

export type ServeMessagingMediaCommand =
  | { kind: 'dm'; storageKey: string; ticket: DmMediaFetchTicket }
  | { kind: 'group'; storageKey: string; ticket: GroupMediaFetchTicket };

export type ServeMessagingMediaResult = {
  status: ServeMessagingMediaStatus;
  httpStatus: number;
  error_code?: string;
  message?: string;
  /** ok 时路由用此 key 调 serveMediaObject */
  data?: { storage_key: string };
};

/** 窄依赖：核心禁止 Env / Hono / serveMediaObject */
export type ServeMessagingMediaDeps = {
  localPublicBase: {
    getNormalizedUrl(): Promise<string>;
  };
  clock: { nowSec(): number; nowIso(): string };
  dm: {
    loadOutboxEnvelope(messageId: string): Promise<DmEnvelope | null>;
    getOutboxPeerWorkerBUrl(messageId: string): Promise<string | null>;
    verifyTicket(ticket: DmMediaFetchTicket, pubkeyHex: string): Promise<boolean>;
    consumeNonce(nonce: string, createdAt: string): Promise<'ok' | 'replay' | 'error'>;
  };
  group: {
    loadEnvelope(groupId: string, messageId: string): Promise<GroupMessageEnvelope | null>;
    loadOwnerEnvelope(groupId: string, messageId: string): Promise<GroupMessageEnvelope | null>;
    getActiveMemberHandle(groupId: string, memberWorkerBUrl: string): Promise<string | null>;
    verifyTicket(ticket: GroupMediaFetchTicket, pubkeyHex: string): Promise<boolean>;
    consumeNonce(
      groupId: string,
      nonce: string,
      createdAt: string,
    ): Promise<'ok' | 'replay' | 'error'>;
  };
  requesterPubkey: {
    fetch(requesterWorkerBUrl: string, handle: string): Promise<string | null>;
  };
  registry: {
    hasActiveMessagingObject(storageKey: string): Promise<boolean>;
  };
  logger: {
    error(msg: string, detail?: unknown): void;
  };
};
