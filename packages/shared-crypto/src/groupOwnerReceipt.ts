/**
 * GRP-RELAY-AUTH-1：群主 owner_receipt 副签（Ed25519）。
 * 形态为签名/验签，不是「私钥加密元数据」（见 grp-relay-auth-2026-10-plan.md §一裁定）。
 * 收端先验群主回执，再验发送者成员签；密文仍只在浏览器用群密钥解密，群主不碰明文。
 */
import type { OwnerReceiptUnsigned, OwnerReceiptV1 } from '@hailuo/shared-types';
import { encodeText, hexToBytes, normalizeWorkerBOrigin } from '@hailuo/shared-utils';
import { computeBodyHash, signMessage } from './ed25519';
import { getCachedKey } from './keyCache';

export const OWNER_RECEIPT_KIND = 'OWNER_RECEIPT_V1' as const;

export type { OwnerReceiptUnsigned, OwnerReceiptV1 };

async function importPublicKey(publicKeyHex: string): Promise<CryptoKey> {
  return getCachedKey(`owner-receipt-ed25519-pub:${publicKeyHex}`, () =>
    crypto.subtle.importKey(
      'raw',
      hexToBytes(publicKeyHex),
      { name: 'Ed25519' },
      false,
      ['verify'],
    ),
  );
}

/**
 * 规范化签名输入（须跨节点字节一致）：kind / 群 / 消息 / epoch / 发送者URL /
 * 发送者handle小写 / 密文摘要 / 群主URL / 签发 / 过期 / 权威入库序 recv_seq。
 *
 * MSG-FIX-5：`recv_seq`（群主权威单调入库序）**必须**进签名输入，否则中继节点
 * 可改写序号伪造乱序。
 *
 * 向后兼容（跨版本升级）：`recv_seq` 缺失时**整行省略**（不占位空串），
 * canonical 退化为 MSG-FIX-5 之前的 10 行 —— 与老群主节点签发的字节完全一致，
 * 升级后的收端才能验过老回执。
 * ⚠️ 若改成「push 空串占位」，`join('\n')` 会多出一个尾部 `\n`（11 行），
 * 与老节点的 10 行签名输入**字节不一致** → 老回执被误判 `GROUP_RECEIPT_INVALID`。
 * （反向不兼容——新回执给老节点验——是协议升级固有边界，无法靠本函数消除。）
 */
export function buildOwnerReceiptSignatureInput(receipt: OwnerReceiptUnsigned): string {
  const fields = [
    OWNER_RECEIPT_KIND,
    receipt.group_id,
    receipt.message_id,
    String(receipt.epoch),
    normalizeWorkerBOrigin(receipt.sender_worker_b_url),
    receipt.sender_handle.trim().toLowerCase(),
    receipt.ciphertext_sha256.trim().toLowerCase(),
    normalizeWorkerBOrigin(receipt.owner_worker_b_url),
    receipt.issued_at,
    receipt.exp,
  ];
  // MSG-FIX-5：权威入库序（可选字段）。**仅在存在时追加整行**，缺失则整行省略，
  // 保证「无 recv_seq」的 canonical 与老版本（10 行）字节一致。
  if (typeof receipt.recv_seq === 'number' && Number.isFinite(receipt.recv_seq)) {
    fields.push(String(receipt.recv_seq));
  }
  return fields.join('\n');
}

/**
 * MSG-FIX-5 之前的 canonical（10 行，`recv_seq` 位置以空串占位 → 实际多一个尾部 `\n`）。
 *
 * ⚠️ 仅用于**兼容过渡期回退验签**：MSG-FIX-5 初版曾把 `recv_seq` 以空串占位
 * （canonical 变成 11 行、末尾多 `\n`），与老节点 10 行签名字节不一致。
 * 该版本已上线的节点签出的「无 recv_seq」回执，用新 canonical 验不过 →
 * 收端需额外尝试这份 legacy canonical，否则过渡窗口内的回执被误判签名无效。
 *
 * 新老两端都存在的「真老格式」（10 行、无尾部 `\n`）已由
 * `buildOwnerReceiptSignatureInput` 在 `recv_seq` 缺失时**整行省略**覆盖。
 */
function buildOwnerReceiptSignatureInputLegacy(receipt: OwnerReceiptUnsigned): string {
  return [
    ...buildOwnerReceiptSignatureInput(receipt).split('\n'),
    '',
  ].join('\n');
}

/** 对密文算摘要（与群 envelope 签名同一哈希口径） */
export async function hashOwnerReceiptCiphertext(ciphertext: string): Promise<string> {
  return computeBodyHash(ciphertext);
}

export async function signOwnerReceipt(
  receipt: OwnerReceiptUnsigned,
  ownerPrivateKeyHex: string,
): Promise<string> {
  return signMessage(buildOwnerReceiptSignatureInput(receipt), ownerPrivateKeyHex);
}

export async function verifyOwnerReceipt(
  receipt: OwnerReceiptV1,
  ownerPublicKeyHex: string,
): Promise<boolean> {
  try {
    const key = await importPublicKey(ownerPublicKeyHex);
    const { sig: _sig, ...unsigned } = receipt;
    const sigBytes = hexToBytes(receipt.sig);
    if (await crypto.subtle.verify(
      'Ed25519',
      key,
      sigBytes,
      encodeText(buildOwnerReceiptSignatureInput(unsigned as OwnerReceiptUnsigned)),
    )) {
      return true;
    }
    // 过渡期回退：仅当回执**没有** recv_seq 时，额外尝试 MSG-FIX-5 初版的
    // 「空串占位」canonical（11 行）。带序号的回执不做回退——序号必须严格
    // 由群主签名背书，回退会削弱防伪造语义。
    if (unsigned.recv_seq === undefined) {
      return crypto.subtle.verify(
        'Ed25519',
        key,
        sigBytes,
        encodeText(buildOwnerReceiptSignatureInputLegacy(unsigned as OwnerReceiptUnsigned)),
      );
    }
    return false;
  } catch {
    return false;
  }
}
