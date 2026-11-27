/**
 * NCF-2D2：群主 inbound（internal /groups/inbound）深模块类型。
 * 契约见 docs/m-refactor-ncf-2-plan.md §5.7。
 * 注意：不得解密 ciphertext；日志禁止私钥 / envelope.sig / ciphertext 原文。
 */
import type { GroupMessageEnvelope, OwnerReceiptV1 } from '@hailuo/shared-types';

export type AcceptGroupMessageStatus =
  | 'ok'
  | 'message_expired'
  | 'group_not_found'
  | 'envelope_invalid'
  | 'epoch_stale'
  | 'not_member'
  | 'key_pending'
  | 'members_muted'
  | 'blacklisted'
  | 'rate_limited'
  | 'nonce_replay'
  | 'internal_error';

export type AcceptGroupMessageCommand = {
  /** 路由层已 parseGroupMessageEnvelope；核心不再二次 JSON 解析 */
  envelope: GroupMessageEnvelope;
};

export type AcceptGroupMessageResult = {
  status: AcceptGroupMessageStatus;
  httpStatus: number;
  error_code?: string;
  message?: string;
  data?: {
    message_id: string;
    duplicate?: boolean;
    /**
     * GRP-RELAY-AUTH-2 / DUP-1：群主受理或幂等命中后签发的副签回执
     *（影子缺钥可为缺省；duplicate 路径补签但不 fanout）
     */
    owner_receipt?: OwnerReceiptV1;
  };
  flags?: {
    /** 有 media 且非 duplicate 时由路由 waitUntil(mirror)，核心不碰 ExecutionContext */
    needMediaMirror?: boolean;
  };
};

export type GroupRowForAccept = {
  owner_worker_b_url: string;
  epoch: number;
  tree_id: number;
  dissolved_at: string | null;
  /** M16-GROUP-MOD：1=仅群主与管理员可发言；旧行缺列时调用方按 0 */
  members_muted?: number | null;
};

export type GroupMemberRowForAccept = {
  member_pubkey: string;
  status: string;
  key_state: string;
  member_handle: string;
  role?: string | null;
  /** M16-GROUP-MOD：1=群管理 */
  is_admin?: number | null;
};

/** 窄依赖：核心禁止 Env / Hono / ExecutionContext */
export type AcceptGroupMessageDeps = {
  groups: {
    get(groupId: string): Promise<GroupRowForAccept | null>;
  };
  members: {
    get(groupId: string, memberWorkerBUrl: string): Promise<GroupMemberRowForAccept | null>;
  };
  blacklist: {
    isBlacklisted(senderWorkerBUrl: string): Promise<boolean>;
  };
  rateLimit: {
    checkAndIncrement(groupId: string, senderWorkerBUrl: string): Promise<boolean>;
  };
  crypto: {
    verifyEnvelope(envelope: GroupMessageEnvelope, pubkeyHex: string): Promise<boolean>;
    /**
     * GRP-RELAY-AUTH-2：受理成功后签发 owner_receipt。
     * 缺私钥时返回 null（影子 fail-soft，不挡 inbound）。
     *
     * MSG-FIX-5：`recvSeq` 为群主权威入库实际分配的单调序，会被**签入回执**，
     * 中继节点无法伪造（防乱序 / 空洞）。
     */
    issueOwnerReceipt(
      envelope: GroupMessageEnvelope,
      ownerWorkerBUrl: string,
      recvSeq?: number | null,
    ): Promise<OwnerReceiptV1 | null>;
  };
  store: {
    messageExists(messageId: string, groupId: string): Promise<boolean>;
    consumeNonce(
      groupId: string,
      nonce: string,
      createdAt: string,
    ): Promise<'ok' | 'replay' | 'error'>;
    /**
     * 原子 batch：nonce 插入 + 两表消息插入，要么全成功要么全回滚。
     *
     * MSG-FIX-5：返回实际分配到的权威 `recv_seq`（供 owner_receipt 签名背书）。
     */
    insertMessageBatch(
      envelope: GroupMessageEnvelope,
      senderWorkerBUrl: string,
    ): Promise<
      | { status: 'ok'; recv_seq: number | null }
      | { status: 'replay' | 'error'; recv_seq: null }
    >;
    /**
     * MSG-FIX-5：回读既有权威行的 `recv_seq`（duplicate 路径补签回执时用，
     * 保证与首次落库分配的序号一致）。缺省实现（未提供）按「无序号」处理。
     */
    readAuthoritativeRecvSeq?(
      messageId: string,
      groupId: string,
    ): Promise<number | null>;
  };
  relay: {
    fanoutFromOwner(
      groupId: string,
      ownerWorkerBUrl: string,
      treeId: number,
      envelope: GroupMessageEnvelope,
      ownerReceipt?: OwnerReceiptV1 | null,
    ): Promise<void>;
  };
  logger: {
    error(msg: string, detail?: unknown): void;
  };
};
