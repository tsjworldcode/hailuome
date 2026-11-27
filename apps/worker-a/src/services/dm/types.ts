/**
 * NCF-2D1：DM 收件（internal inbox）深模块类型。
 * 契约见 docs/m-refactor-ncf-2-plan.md §5.6。
 * 注意：不得解密 ciphertext；日志禁止私钥 / ticket.sig / ciphertext 原文。
 */
import type { DmEnvelope } from '@hailuo/shared-types';

export type ReceiveDmInboxStatus =
  | 'ok'
  | 'envelope_invalid'
  | 'user_not_registered'
  | 'ticket_invalid'
  | 'blacklisted'
  | 'not_mutual'
  | 'rate_limited'
  | 'pubkey_unavailable'
  | 'nonce_replay'
  | 'internal_error';

export type ReceiveDmInboxCommand = {
  /** 路由层已 parseDmEnvelope；核心不再二次 JSON 解析 */
  envelope: DmEnvelope;
};

export type ReceiveDmInboxResult = {
  status: ReceiveDmInboxStatus;
  httpStatus: number;
  error_code?: string;
  message?: string;
  data?: { message_id: string };
  flags?: {
    /** 有 media 时由路由 waitUntil(mirror)，核心不碰 ExecutionContext */
    needMediaMirror?: boolean;
  };
};

/** 窄依赖：核心禁止 Env / Hono / ExecutionContext */
export type ReceiveDmInboxDeps = {
  localUser: {
    getHandle(): Promise<string | null>;
  };
  localPublicBase: {
    getNormalizedUrl(): Promise<string>;
  };
  blacklist: {
    isBlacklisted(senderWorkerBUrl: string): Promise<boolean>;
  };
  follows: {
    isFollowing(peerWorkerBUrl: string): Promise<boolean>;
  };
  rateLimit: {
    checkAndIncrement(senderWorkerBUrl: string): Promise<boolean>;
  };
  senderPubkey: {
    /**
     * 已有 follows.followed_pubkey 时直接返回，不发网络请求。
     * 空 Pin 才取档；backfillAfterVerify 为 true 时，验签通过后才允许回填。
     */
    resolve(envelope: DmEnvelope): Promise<{
      pubkey: string | null;
      backfillAfterVerify: boolean;
    }>;
    backfill(envelope: DmEnvelope, pubkeyHex: string): Promise<void>;
  };
  crypto: {
    verifyTicket(ticket: DmEnvelope['send_ticket'], pubkeyHex: string): Promise<boolean>;
    verifyEnvelope(envelope: DmEnvelope, pubkeyHex: string): Promise<boolean>;
  };
  store: {
    insertNonces(envelopeNonce: string, ticketNonce: string, createdAt: string): Promise<'ok' | 'replay' | 'error'>;
    insertInboxMessage(envelope: DmEnvelope): Promise<void>;
    /** 原子 batch：nonce 插入 + 消息插入，要么全成功要么全回滚。 */
    insertMessageBatch(
      envelope: DmEnvelope,
      ticketNonce: string,
    ): Promise<'ok' | 'replay' | 'error'>;
  };
  clock: { nowSec(): number };
  logger: {
    error(msg: string, detail?: unknown): void;
  };
};
