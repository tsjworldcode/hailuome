/**
 * 形状示例（非运行时加载）。
 * 真正的 `_worker-b-config.js` 由 `npm run build` → `write-deploy-env.mjs` 生成，且已 gitignore。
 * 生产 Pages 构建必须提供 PUBLIC_WORKER_B_URL；公开读优先 STATE_KV canonical。
 */
export default {
  worker_b_url: "https://your-worker-b.example",
  registry_url: "https://hailuo-registry.allovo.eu.org"
};
