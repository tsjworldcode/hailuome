/**
 * NCF-2D2：生产 adapter — Env 只出现在本文件。
 * 防身份关联：不得把对端完整 IP/邮箱写进日志；本域只用 peer Worker B URL 做门禁。
 */
import { verifyGroupMessageEnvelope } from '@hailuo/shared-crypto';
import type { GroupMessageEnvelope } from '@hailuo/shared-types';
import type { Env } from '../../../env';
import { normalizeGroupMemberUrl } from '../../../lib/groupMemberUrl';
import { isNodeBlacklisted } from '../../../lib/blacklistLookup';
import { checkAndIncrementGroupMessageRate } from '../../../lib/groupRateLimit';
import { relayGroupMessageFromOwner, type GroupRelaySchedule } from '../../../lib/groupRelay';
import { messagingDb } from '../../../lib/messagingDb';
import {
  isSameD1Database,
  resolveGroupMessagesDb,
  resolveGroupMessagesDbAndShard,
} from '../../../lib/messagingShard';
import { issueOwnerReceiptForEnvelope } from '../../../lib/groupOwnerReceiptIssue';
import type { AcceptGroupMessageDeps } from '../types';

export type CreateAcceptDepsOptions = {
  /** M-RT-2：relay fanout 走 waitUntil，不挡 inbound 响应 */
  readonly schedule?: GroupRelaySchedule;
};

/**
 * MSG-FIX-5：权威入库序的内联分配表达式（写进 INSERT 子查询，与写入同事务）。
 *
 * MSG-FIX-4 的原实现是「先 `SELECT MAX+1`，再 `INSERT`」两步——两步之间有窗口：
 * 并发入站会拿到同一个 MAX → 撞 `UNIQUE(group_id, recv_seq)` 索引。
 * 改成把 `COALESCE(MAX(recv_seq),0)+1` 写成 INSERT 语句内的子查询，
 * 由 D1 的写事务（单写者串行）保证读改写原子。
 */
export const GROUP_MESSAGE_RECV_SEQ_SQL = 'COALESCE(MAX(recv_seq), 0) + 1';

/** MSG-FIX-5：权威行写入后的 seq 回读（供 owner_receipt 签名背书）。 */
async function readRecvSeqByMessageId(
  msgDb: D1Database,
  messageId: string,
): Promise<number | null> {
  const row = await msgDb
    .prepare(`SELECT recv_seq FROM group_messages WHERE message_id = ? LIMIT 1`)
    .bind(messageId)
    .first<{ recv_seq: number | null }>();
  return row?.recv_seq != null ? Number(row.recv_seq) : null;
}

export function createProductionAcceptGroupMessageDeps(
  env: Env,
  opts: CreateAcceptDepsOptions = {},
): AcceptGroupMessageDeps {
  return {
    groups: {
      async get(groupId) {
        return messagingDb(env)
          .prepare(
            `SELECT owner_worker_b_url, epoch, tree_id, dissolved_at, members_muted
               FROM groups WHERE group_id = ? LIMIT 1`,
          )
          .bind(groupId)
          .first<{
            owner_worker_b_url: string;
            epoch: number;
            tree_id: number;
            dissolved_at: string | null;
            members_muted: number | null;
          }>();
      },
    },
    members: {
      async get(groupId, memberWorkerBUrl) {
        return messagingDb(env)
          .prepare(
            `SELECT member_pubkey, status, key_state, member_handle, role, is_admin FROM group_members
              WHERE group_id = ? AND member_worker_b_url = ? LIMIT 1`,
          )
          .bind(groupId, normalizeGroupMemberUrl(memberWorkerBUrl))
          .first<{
            member_pubkey: string;
            status: string;
            key_state: string;
            member_handle: string;
            role: string;
            is_admin: number | null;
          }>();
      },
    },
    blacklist: {
      // M-OPT-SPLIT-5：统一走 blacklistLookup（GOVERNANCE_DB）
      // normalizeGroupMemberUrl ≡ normalizeDmPeerUrl（trim + 去尾斜杠），helper 内部再归一一次无害
      isBlacklisted: (senderWorkerBUrl) => isNodeBlacklisted(env, senderWorkerBUrl),
    },
    rateLimit: {
      checkAndIncrement: (groupId, senderWorkerBUrl) =>
        checkAndIncrementGroupMessageRate(env, groupId, senderWorkerBUrl),
    },
    crypto: {
      verifyEnvelope: (envelope, pubkeyHex) => verifyGroupMessageEnvelope(envelope, pubkeyHex),
      // GRP-RELAY-AUTH-2：影子签发；缺 ED25519_PRIVATE_KEY 时不挡 inbound
      // MSG-FIX-5：recvSeq 由群主签入回执（权威背书，中继不可伪造序号）
      async issueOwnerReceipt(envelope, ownerWorkerBUrl, recvSeq) {
        const privateKey = env.ED25519_PRIVATE_KEY?.trim() ?? '';
        if (!privateKey) {
          console.warn('[groups] owner_receipt 跳过签发：ED25519_PRIVATE_KEY 未配置');
          return null;
        }
        try {
          return await issueOwnerReceiptForEnvelope(
            envelope,
            ownerWorkerBUrl,
            privateKey,
            recvSeq ?? null,
          );
        } catch (err) {
          console.warn('[groups] owner_receipt 签发失败（影子 fail-soft）', err);
          return null;
        }
      },
    },
    store: {
      async messageExists(messageId, groupId) {
        const msgDb = await resolveGroupMessagesDb(env, groupId);
        const existing = await msgDb
          .prepare(`SELECT message_id FROM group_messages WHERE message_id = ? LIMIT 1`)
          .bind(messageId)
          .first<{ message_id: string }>();
        return existing !== null;
      },
      async consumeNonce(groupId, nonce, createdAt) {
        try {
          await messagingDb(env)
            .prepare(`INSERT INTO group_nonces (group_id, nonce, created_at) VALUES (?, ?, ?)`)
            .bind(groupId, nonce, createdAt)
            .run();
          return 'ok';
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          if (message.includes('UNIQUE') || message.includes('constraint')) {
            return 'replay';
          }
          console.error('[groups] nonce insert failed (constraint or internal)');
          return 'error';
        }
      },
      async insertMessageBatch(envelope: GroupMessageEnvelope, senderWorkerBUrl) {
        const { db: msgDb, shardId } = await resolveGroupMessagesDbAndShard(
          env,
          envelope.group_id,
        );
        const groupId = envelope.group_id;
        const nonce = envelope.nonce;
        const createdAt = envelope.created_at;
        const receivedAt = new Date().toISOString();
        // MSG-FIX-5：recv_seq 改为 INSERT 内联子查询——序号与写入同一事务，
        // 消除「先 SELECT MAX+1 再 INSERT」中间的并发撞号窗口。
        // 判据用「分片号 === 'primary'」（等价于与 group_nonces 同库），并以引用比较作双保险。
        const sameDatabase =
          shardId === 'primary' && isSameD1Database(messagingDb(env), msgDb);
        // MSG-FIX-6：nonce 表（group_nonces）在 MESSAGING_DB，群消息表可能在 MESSAGING_SHARD_1。
        // D1 的 `db.batch()` 绑定在单一 database_id 上——statement 载荷只有 SQL + params、
        // **不带各自的 binding id**，跨库单 batch **不报错**，而是把全部语句**静默执行到
        // batch 所属那个库**（实测见 scripts/probe-d1-cross-db-batch.mjs）。
        // 于是分片群的消息会被写进 primary，而读路径按路由表去 shard 读 → 群里一条消息都看不到。
        // 故：同库 → 单 batch 保原子；异库 → 拆两步串行 + 消息写失败时补偿删 nonce。
        const nonceStatement = messagingDb(env)
          .prepare(`INSERT INTO group_nonces (group_id, nonce, created_at) VALUES (?, ?, ?)`)
          .bind(groupId, nonce, createdAt);

        const messageStatements = [
          msgDb
            .prepare(
              `INSERT INTO group_messages
               (message_id, group_id, epoch, sender_worker_b_url, sender_handle, msg_kind, ciphertext, created_at, expires_at, envelope_json, recv_seq, received_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
                       (SELECT ${GROUP_MESSAGE_RECV_SEQ_SQL} FROM group_messages WHERE group_id = ?),
                       ?)`,
            )
            .bind(
              envelope.message_id,
              groupId,
              envelope.epoch,
              senderWorkerBUrl,
              envelope.sender_handle,
              envelope.msg_kind,
              envelope.ciphertext,
              createdAt,
              envelope.expires_at,
              JSON.stringify(envelope),
              groupId,
              receivedAt,
            ),
          msgDb
            .prepare(
              `INSERT OR IGNORE INTO member_group_messages
               (message_id, group_id, epoch, sender_worker_b_url, sender_handle, msg_kind, ciphertext, created_at, envelope_json, recv_seq, received_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?,
                       (SELECT recv_seq FROM group_messages WHERE message_id = ?),
                       ?)`,
            )
            .bind(
              envelope.message_id,
              groupId,
              envelope.epoch,
              senderWorkerBUrl,
              envelope.sender_handle,
              envelope.msg_kind,
              envelope.ciphertext,
              createdAt,
              JSON.stringify(envelope),
              envelope.message_id,
              receivedAt,
            ),
        ];
        try {
          if (sameDatabase) {
            // 同库：D1 batch 是事务级原子——三条语句要么全成要么全回滚。
            await messagingDb(env).batch([nonceStatement, ...messageStatements]);
          } else {
            // 异库：跨库无事务，按「先扣 nonce（防重放优先）→ 后写消息」两步串行。
            await messagingDb(env).batch([nonceStatement]);
            try {
              await msgDb.batch(messageStatements);
            } catch (msgErr) {
              // 补偿：消息没落库却已消耗 nonce → 发送方用同一 nonce 重试会拿到 409 重放，
              // 消息永久丢失。故 best-effort 删掉刚写的 nonce 行，让重试能真正补发。
              try {
                await messagingDb(env)
                  .prepare(`DELETE FROM group_nonces WHERE group_id = ? AND nonce = ?`)
                  .bind(groupId, nonce)
                  .run();
              } catch (compensateErr) {
                // REL-FIX-13：补偿失败是**运维级事件**（nonce 残留 → 发送方重试恒得 409
                // GROUP_NONCE_REPLAY）。原先只打一句固定文案，检索时无法定位到
                // 「哪个群 / 哪条 nonce / 哪条消息」。补齐结构化上下文。
                // ⚠️ 防身份关联：只打本群 group_id 与本消息 message_id / nonce，
                // **不打**任何对端节点 URL、handle、邮箱或 IP。
                console.error('[groups] nonce 补偿删除失败（消息未落库，nonce 可能残留）', {
                  group_id: groupId,
                  message_id: envelope.message_id,
                  nonce,
                  error: compensateErr instanceof Error ? compensateErr.message : String(compensateErr),
                });
              }
              throw msgErr;
            }
          }
          // MSG-FIX-5：回读权威行实际分配到的 seq（供 owner_receipt 签名背书）
          const recvSeq = await readRecvSeqByMessageId(msgDb, envelope.message_id);
          // GROUP-CAP-SPEAK-1：仅 chat 成功落库后推进发言序（system/重放不写）
          // 须用服务端 receivedAt：信封 created_at 由客户端签名可控，未来时间戳会永久霸占建树排序。
          if (envelope.msg_kind === 'chat') {
            try {
              await messagingDb(env)
                .prepare(
                  `UPDATE group_members
                      SET last_speak_at = ?
                    WHERE group_id = ? AND member_worker_b_url = ? AND status = 'active'`,
                )
                .bind(receivedAt, groupId, normalizeGroupMemberUrl(senderWorkerBUrl))
                .run();
            } catch (speakErr) {
              // fail-soft：发言序失败不挡消息；旧库未 migration 时也不炸主路径
              console.warn(
                '[groups] last_speak_at 更新失败',
                speakErr instanceof Error ? speakErr.message : String(speakErr),
              );
            }
          }
          // M7-30-GROUP-URL：权威入站 system 换域 → 验签改址
          if (envelope.msg_kind === 'system') {
            try {
              const { maybeApplyGroupUrlChangeFromSystemCiphertext } = await import(
                '../../../lib/groupUrlChangeAnnounce'
              );
              await maybeApplyGroupUrlChangeFromSystemCiphertext(
                env,
                envelope.msg_kind,
                envelope.ciphertext,
              );
            } catch (applyErr) {
              console.warn('[groups] groupUrlChange apply 失败', applyErr);
            }
          }
          return { status: 'ok' as const, recv_seq: recvSeq };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          // MSG-FIX-5：区分「nonce 重放 / 消息重复」与「内部错误」。
          // 序号撞号（idx_group_messages_group_recv_seq）属内部错误——原子分配后
          // 正常不应出现，若出现说明有并发写序问题，必须暴露而非当重放吞掉。
          if (message.includes('idx_group_messages_group_recv_seq')) {
            console.error('[groups] recv_seq 撞号（原子分配失效）');
            return { status: 'error' as const, recv_seq: null };
          }
          if (message.includes('UNIQUE') || message.includes('constraint')) {
            return { status: 'replay' as const, recv_seq: null };
          }
          console.error('[groups] batch insert failed (constraint or internal)');
          return { status: 'error' as const, recv_seq: null };
        }
      },
      // MSG-FIX-5：duplicate 路径补签回执时回读既有权威 seq（保证与首次一致）
      async readAuthoritativeRecvSeq(messageId, groupId) {
        const msgDb = await resolveGroupMessagesDb(env, groupId);
        return readRecvSeqByMessageId(msgDb, messageId);
      },
    },
    relay: {
      fanoutFromOwner: (groupId, ownerWorkerBUrl, treeId, envelope, ownerReceipt) =>
        relayGroupMessageFromOwner(env, groupId, ownerWorkerBUrl, treeId, envelope, {
          schedule: opts.schedule,
          ownerReceipt: ownerReceipt ?? undefined,
        }),
    },
    logger: {
      error: (msg, detail) =>
        detail === undefined ? console.error(msg) : console.error(msg, detail),
    },
  };
}
