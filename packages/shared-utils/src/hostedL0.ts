/**
 * M9-8：托管 L0 模式常量与隐私声明（方案优化 §7.1 / P-15）。
 * 默认架构仍为自托管；hosted_l0 须显式开启且用户知情同意。
 */

export const DEPLOYMENT_MODES = ['self_hosted', 'hosted_l0'] as const;
export type DeploymentMode = (typeof DEPLOYMENT_MODES)[number];

/** 托管 L0 隐私声明版本（与 Worker A system_config 对齐） */
export const HOSTED_L0_PRIVACY_VERSION = '1.0' as const;

/** 账号删除后运营方备份保留天数（文档/契约；节点侧 D1 立即清空） */
export const HOSTED_L0_DATA_RETENTION_DAYS = 30;

/** 删除账号二次确认口令 */
export const HOSTED_L0_ACCOUNT_DELETE_CONFIRM_PHRASE = '删除我的账号';

export interface HostedL0PrivacySection {
  readonly id: string;
  readonly title: string;
  readonly body: string;
}

/** 托管 L0 隐私声明正文（中文；Web 与 API 共用） */
export const HOSTED_L0_PRIVACY_SECTIONS: readonly HostedL0PrivacySection[] = [
  {
    id: 'mode',
    title: '托管模式说明',
    body:
      '你正在使用海螺托管试用节点（L0）。节点运行在运营方 Cloudflare 账号，'
      + '运营方在技术上可访问 D1/KV 中的站主数据。这与完全自托管（数据 100% 在你自己的账号）不同。',
  },
  {
    id: 'sovereignty',
    title: '主权与出口',
    body:
      '你的 Ed25519 签名私钥仍由你掌控（不交给运营方明文托管）。'
      + '你可随时通过「设置 → 节点搬家」导出完整 bundle，并导入到你自己的 Cloudflare 账号。',
  },
  {
    id: 'retention',
    title: '数据保留',
    body:
      `账号活跃期间数据持续保留。你发起删除账号后，节点 D1 权威数据将立即清空；`
      + `运营方离线备份最长保留 ${HOSTED_L0_DATA_RETENTION_DAYS} 天后销毁（不含你已导出的副本）。`,
  },
  {
    id: 'logging',
    title: '访问日志',
    body:
      '运营方可能保留 Worker 访问日志用于排障与滥用治理，默认保留不超过 90 天，不用于广告投放。',
  },
  {
    id: 'messaging',
    title: '私信与群聊',
    body:
      'MESSAGING_DB 不在节点搬家 bundle 内；删除账号前请单独使用「本地数据 → 私信加密备份」导出。',
  },
] as const;

export function buildHostedL0PrivacyDocument(): {
  version: typeof HOSTED_L0_PRIVACY_VERSION;
  sections: readonly HostedL0PrivacySection[];
  updated_at: string;
} {
  return {
    version: HOSTED_L0_PRIVACY_VERSION,
    sections: HOSTED_L0_PRIVACY_SECTIONS,
    updated_at: '2026-07-08T00:00:00.000Z',
  };
}

export function isHostedL0ModeEnabled(raw: string | undefined): boolean {
  return String(raw ?? '').trim().toLowerCase() === 'true';
}
