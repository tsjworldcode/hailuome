/**
 * 海螺节点项目许可与使用手册正文（中英文）。
 * 版本与 @hailuo/shared-utils 的 PROJECT_TERMS_VERSION 保持一致。
 *
 * 展示约定：各条款正文统一用 `ul` 列表（黑点），避免「有的条款有圆点、有的没有」
 * 的观感分裂（条款标题仍是编号 h2，圆点只出现在正文条目上）。
 */
import { PROJECT_TERMS_VERSION } from '@hailuo/shared-utils';
import type { Language } from './i18n';
import { normalizeLanguage } from './i18n/locales';

export type TermsBlock =
  | { type: 'p'; text: string }
  | { type: 'ul'; items: string[] };

export type TermsSection = {
  title: string;
  blocks: TermsBlock[];
};

export type TermsDoc = {
  version: string;
  title: string;
  intro: string;
  sections: TermsSection[];
  footerNote: string;
};

const ZH: TermsDoc = {
  version: PROJECT_TERMS_VERSION,
  title: '海螺节点项目许可与使用手册',
  intro: `版本 ${PROJECT_TERMS_VERSION}（向注册中心申请登记前，你必须阅读并同意本手册）`,
  sections: [
    {
      title: '1. 这是什么',
      blocks: [
        {
          type: 'ul',
          items: [
            '海螺节点是你自行部署并运行的去中心化社交节点（Worker A / Worker B / Web）。海螺注册中心仅提供用户目录与节点登记，不托管你的帖子、私信或其它私密数据。',
          ],
        },
      ],
    },
    {
      title: '2. 你必须做到',
      blocks: [
        {
          type: 'ul',
          items: [
            '你必须年满 18 周岁，否则一切后果自己承担。',
            '自行保管站主账号、密钥、令牌与 Cloudflare 资源。',
            '对自己节点上发布的内容、访问控制、备份与合规承担全部责任。',
            '遵守你所在地及节点访问者所在地的适用法律法规。',
          ],
        },
      ],
    },
    {
      title: '3. 当地法律与责任归属（重要）',
      blocks: [
        {
          type: 'ul',
          items: [
            '你必须遵守部署地、运营地以及实际使用者所在地的全部适用法律与监管要求。',
            '任何违法、违规、侵权或其它不当使用行为，均由部署者与使用者自行承担全部法律责任与后果；与海螺项目作者、开源贡献者、以及海螺注册中心运营方无关，且前述各方不承担连带或替代责任。',
          ],
        },
      ],
    },
    {
      title: '4. 严禁行为',
      blocks: [
        {
          type: 'ul',
          items: [
            '攻击海螺注册中心（含探测、压测滥用、入侵、破坏可用性等）。',
            '攻击其他用户或其节点（含骚扰、恶意刷量、未授权访问、破坏其服务等）。',
            '利用节点或注册中心从事违法、欺诈，或攻击他人基础设施。',
            '冒用他人身份登录其他人的海螺节点。',
            '试图未授权访问注册中心管理接口，或其他用户的 Worker A 写层。',
            '将 Worker A 地址写入公开文档、CORS、注册中心或其它对外暴露渠道。',
          ],
        },
      ],
    },
    {
      title: '5. 违规处理（黑名单）',
      blocks: [
        {
          type: 'ul',
          items: [
            '一经发现任何违反本手册或适用法律的行为，注册中心运营方可将相关用户/节点列入黑名单，且黑名单承担自己对应的一切违法后果。被拉黑后，目录查询、登记相关能力及其他受保护接口可被拒绝或受限，且不保证另行通知。',
          ],
        },
      ],
    },
    {
      title: '6. 数据与隐私',
      blocks: [
        {
          type: 'ul',
          items: [
            '节点数据保存在你自己的 Cloudflare 账号中；项目创建者无法访问你的 D1 / KV 等资源。',
            '向注册中心登记的目录字段（如 handle、node_url、公钥指纹等）可能被其它节点查询，请按公开信息对待。',
            '登记成功后务必妥善保存一次性展示的 node_api_token，遗失需按恢复流程处理。',
          ],
        },
      ],
    },
    {
      title: '7. 许可范围与服务边界',
      blocks: [
        {
          type: 'ul',
          items: [
            '海螺节点相关开源组件按仓库内 LICENSE 授权使用。你部署节点即表示同意遵守对应开源许可证，并同时接受本手册对「注册中心登记」环节的约束。',
            '注册中心与相关服务按「尽力而为」提供，不保证持续可用、不保证查询结果完整；因网络、配额、第三方平台或你自身配置导致的问题，由你自行排查与承担。',
          ],
        },
      ],
    },
    {
      title: '8. 手册变更',
      blocks: [
        {
          type: 'ul',
          items: [
            '后续更新将递增版本号。新版本生效后，新登记须同意新版本；已登记节点是否需重新确认，将另行公告。解释权归开源者所有。',
          ],
        },
      ],
    },
  ],
  footerNote: '点击「我已阅读并同意」即表示你理解并接受以上全部内容。',
};

const EN: TermsDoc = {
  version: PROJECT_TERMS_VERSION,
  title: 'Hailuo Node Terms & Usage Handbook',
  intro: `Version ${PROJECT_TERMS_VERSION} (You must read and agree before applying for registry enrollment)`,
  sections: [
    {
      title: '1. What this is',
      blocks: [
        {
          type: 'ul',
          items: [
            'Hailuo Node is a self-hosted decentralized social node (Worker A / Worker B / Web). The Hailuo Registry provides directory and node enrollment only; it does not host your posts, DMs, or other private data.',
          ],
        },
      ],
    },
    {
      title: '2. What you must do',
      blocks: [
        {
          type: 'ul',
          items: [
            'You must be at least 18 years old; otherwise you bear all consequences yourself.',
            'Safeguard your owner credentials, keys, tokens, and Cloudflare resources.',
            'Take full responsibility for content on your node, access control, backups, and compliance.',
            'Comply with all applicable laws where you deploy, operate, and where users access the node.',
          ],
        },
      ],
    },
    {
      title: '3. Local law & liability (important)',
      blocks: [
        {
          type: 'ul',
          items: [
            'You must obey all applicable laws and regulations in the place of deployment, operation, and actual use.',
            'Any illegal, non-compliant, infringing, or otherwise wrongful use is solely the responsibility of the deployer and the users. It has nothing to do with the Hailuo project authors, open-source contributors, or the Hailuo Registry operators, and those parties bear no joint or substitute liability.',
          ],
        },
      ],
    },
    {
      title: '4. Prohibited conduct',
      blocks: [
        {
          type: 'ul',
          items: [
            'Attacking the Hailuo Registry (including probing, abusive load testing, intrusion, or disrupting availability).',
            'Attacking other users or their nodes (including harassment, abuse, unauthorized access, or disrupting their service).',
            'Using the node or registry for illegal activity, fraud, or attacks on others’ infrastructure.',
            'Impersonating others to log into another person’s Hailuo node.',
            'Attempting unauthorized access to registry admin APIs or another user’s Worker A write layer.',
            'Publishing Worker A addresses in public docs, CORS lists, the registry, or other outward channels.',
          ],
        },
      ],
    },
    {
      title: '5. Enforcement (blacklist)',
      blocks: [
        {
          type: 'ul',
          items: [
            'If any violation of this handbook or applicable law is found, the registry operators may place the related user/node on a blacklist, and blacklisted parties still bear all legal consequences of their own unlawful conduct. Once blacklisted, directory lookup, enrollment-related capabilities, and other protected APIs may be refused or limited, with no guarantee of prior notice.',
          ],
        },
      ],
    },
    {
      title: '6. Data & privacy',
      blocks: [
        {
          type: 'ul',
          items: [
            'Node data stays in your own Cloudflare account; the project creator cannot access your D1/KV resources.',
            'Directory fields registered with the registry (such as handle, node_url, pubkey fingerprint) may be looked up by other nodes—treat them as public.',
            'After enrollment, securely store the one-time node_api_token; recovery is required if lost.',
          ],
        },
      ],
    },
    {
      title: '7. License scope & service limits',
      blocks: [
        {
          type: 'ul',
          items: [
            'Hailuo Node open-source components are used under the repository LICENSE. Deploying a node means you accept that license and these handbook constraints for registry enrollment.',
            'The registry and related services are provided on a best-effort basis with no guarantee of continuous availability or complete lookup results. Issues from networks, quotas, third-party platforms, or your own configuration are yours to resolve.',
          ],
        },
      ],
    },
    {
      title: '8. Handbook updates',
      blocks: [
        {
          type: 'ul',
          items: [
            'Future updates will bump the version number. New enrollments must accept the new version; whether already-enrolled nodes must reconfirm will be announced separately. The right of final interpretation belongs to the open-source author.',
          ],
        },
      ],
    },
  ],
  footerNote: 'Clicking “I have read and agree” means you understand and accept all of the above.',
};

export function getTermsDoc(lang: Language): TermsDoc {
  // 暂无独立日语条款全文：非 zh 回落英文版（后续可加 JA TermsDoc）
  return normalizeLanguage(lang) === 'zh' ? ZH : EN;
}
