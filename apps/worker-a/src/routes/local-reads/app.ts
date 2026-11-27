import type { Env, AppVariables } from '../../env';

/** local-reads 子路由共享 Hono 环境类型 */
export type LocalReadsAppEnv = { Bindings: Env; Variables: AppVariables };
