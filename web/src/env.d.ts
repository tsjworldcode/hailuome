/// <reference path="../.astro/types.d.ts" />
/// <reference types="astro/client" />

// M7-0：客户端可见环境变量类型契约
// - 仅 `PUBLIC_*` 前缀的变量会被 Astro 注入到客户端 bundle
// - 私密写层地址（不带 PUBLIC_ 前缀）故意不在此声明（前端不应访问，违反 §F-02 红线）
interface ImportMetaEnv {
  readonly PUBLIC_WORKER_B_URL: string;
  /** 部署绑定的节点写层地址（每个 Pages 站点对应一个 Worker A；构建时注入） */
  readonly PUBLIC_HAILUO_ENDPOINT?: string;
  /** 注册中心 API 根地址（人机验证 iframe 桥接页所在域） */
  readonly PUBLIC_REGISTRY_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
