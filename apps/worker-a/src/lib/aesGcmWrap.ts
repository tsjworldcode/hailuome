/**
 * M9-7 / R-AUDIT-V3 2.9：节点搬家 — AES-GCM 外包一层（Worker-A 薄封装）。
 *
 * 实际算法在 @hailuo/shared-crypto（nodeExportEnvelope）；本文件供 route / CLI 统一入口。
 */
export {
  encryptNodeExportJson,
  decryptNodeExportJson,
  NODE_EXPORT_ENCRYPTED_FORMAT,
  type NodeExportEncryptedFile,
  type NodeExportEncryptedWrap,
} from '@hailuo/shared-crypto';

/** 解密 envelope 文件 JSON，得到明文 v1 bundle 字符串（import 前一步） */
export async function unwrapNodeExportEnvelope(
  envelopeJson: string,
  passphrase: string,
): Promise<string> {
  const { decryptNodeExportJson, parseNodeExportEncryptedFile } = await import(
    '@hailuo/shared-crypto'
  );
  const file = parseNodeExportEncryptedFile(JSON.parse(envelopeJson) as unknown);
  return decryptNodeExportJson(file, passphrase);
}
