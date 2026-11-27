/**
 * 路径 D（邮件外发兜底）专用 RSA-OAEP-2048 **公钥**（写死 · 开源可钉）。
 *
 * - 仅用于浏览器加密登记密文载荷；不是节点 Ed25519，也不是联邦信任锚。
 * - 配对私钥仅存在于 hailuo-registry（wrangler secret / .dev.vars），永不进本仓。
 * - 轮换：递增 KEY_VERSION，发新版节点；中心可过渡双私钥。
 *
 * 生成：2026-09-28T07:21:01.000Z · key_version=v1 · fingerprint=8501f57640cdb9dc
 */

export const BOOTSTRAP_OUTBOUND_RSA_KEY_VERSION = 'v1' as const;
export const BOOTSTRAP_OUTBOUND_RSA_ALGORITHM = 'RSA-OAEP-2048' as const;
/** SHA-256(SPKI DER) 前 16 hex */
export const BOOTSTRAP_OUTBOUND_RSA_FINGERPRINT = '8501f57640cdb9dc' as const;
export const BOOTSTRAP_OUTBOUND_RSA_CREATED_AT = '2026-09-28T07:21:01.000Z' as const;
/** SPKI DER，标准 base64（无 PEM 头） */
export const BOOTSTRAP_OUTBOUND_RSA_PUBLIC_KEY_SPKI_B64 =
  'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAyJ7KQXJWZFt8tCeXVqOZQnqVajTQABRQPl4HT3xOt8GWdOkMbaftsOO/fnhmRHhUZ7XyNjsk/GghggjmD4FxEzw0DwxDqV12EaZOZqoDaz1FdtpuaIQmXHmcpADFVIWiraXABiIchzk/Ca/Nztz9a6ceo2VaCqLNR2J0vvmKrhzUsLENYVJUW6I5lgITEI4LeyE/dkDfdRDO2gzJLtM60+pedu6sN0cZumccDa6UTHeYmrECO/l0pFIfy2LBcgCu9gUb5vT+0TFUo/7dHwYjVJPLaWMZ5eWElwP7EOrRuzDip0901P6VdZaAOPBnJr9qb4GZ/FMG3UHKp7LLTxKAmwIDAQAB' as const;
