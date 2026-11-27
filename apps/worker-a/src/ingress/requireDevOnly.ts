/**
 * NCF-INGRESS-1：dev-only 门禁 — 生产禁止，本地仅 WORKER_A_DEV_ORIGIN 开启。
 */
import type { MiddlewareHandler } from 'hono';
import type { Env, AppVariables } from '../env';

type AppEnv = { Bindings: Env; Variables: AppVariables };

/**
 * 挂在 setup-proof / save-node-creds 等本地脚本入口。
 * 缺失 WORKER_A_DEV_ORIGIN → 403 FORBIDDEN（与历史文案一致）。
 */
export function requireDevOnly(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    if (!c.env.WORKER_A_DEV_ORIGIN) {
      const path = c.req.path;
      const label = path.includes('save-node-creds')
        ? 'save-node-creds'
        : path.includes('setup-proof')
          ? 'setup-proof'
          : '该接口';
      return c.json(
        {
          ok: false,
          error_code: 'FORBIDDEN',
          message: `${label} 仅本地开发模式可用，生产请用 wrangler d1 execute`,
        },
        403,
      );
    }
    await next();
  };
}
