/** 通道 A 认证收件说明（与注册中心 SSOT 一致）。 */
export const CERT_INBOUND_PURPOSE_ZH = '该域仅用于邮箱认证收信，不作其他用途';

/**
 * 从注册中心 API 根 URL 推导认证收件域：去掉主机名第一个点之前的前缀。
 * 例：`https://hailuo-registry.allovo.eu.org` → `allovo.eu.org`
 */
export function deriveCertInboundHostFromRegistryUrl(registryUrl: string): string {
  const raw = registryUrl.trim();
  if (!raw) {
    throw new Error('registry_url_empty');
  }

  let hostname: string;
  try {
    const url = new URL(raw.includes('://') ? raw : `https://${raw}`);
    hostname = url.hostname.trim().toLowerCase();
  } catch {
    throw new Error('registry_url_invalid');
  }

  const dot = hostname.indexOf('.');
  if (dot <= 0 || dot >= hostname.length - 1) {
    throw new Error('cert_inbound_host_underivable');
  }

  return hostname.slice(dot + 1);
}

export function buildCertInboundAddressExample(host: string): string {
  const normalized = host.trim().toLowerCase();
  if (!normalized) {
    throw new Error('cert_inbound_host_empty');
  }
  return `verify+<token>@${normalized}`;
}
