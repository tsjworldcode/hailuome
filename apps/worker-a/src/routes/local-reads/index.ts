/**
 * 站主直读接口（M3-1a / M-REFACTOR-1a 子路由聚合）。
 *
 * localReadsApp 挂在 /api/local/*，JWT 鉴权由 index.ts 的
 * app.use('/api/local/posts', requireOwnerJWT()) 等精确路径保障。
 *
 * ⚠️ 只读：禁止 KV.put / 写 D1（operation-logs cleanup 除外，走 lib/operationLog）。
 */
import { Hono } from 'hono';
import type { LocalReadsAppEnv } from './app';
import { registerPostsRoutes } from './posts';
import { registerFeedRoutes } from './feed';
import { registerPublicHealthRoutes } from './public-health';
import { registerRegistrySyncRoutes } from './registry-sync';
import { registerRegistryProfileRoutes } from './registry-profile';
import { registerUrlChangeRoutes } from './url-change';
import { registerNotificationsRoutes } from './notifications';
import { registerOperationLogsRoutes } from './operation-logs';
import { registerOwnerSessionsRoutes } from './owner-sessions';
import { registerMutualFollowsRoutes } from './mutual-follows';

export const localReadsApp = new Hono<LocalReadsAppEnv>();

registerPostsRoutes(localReadsApp);
registerFeedRoutes(localReadsApp);
registerPublicHealthRoutes(localReadsApp);
registerRegistrySyncRoutes(localReadsApp);
registerRegistryProfileRoutes(localReadsApp);
registerUrlChangeRoutes(localReadsApp);
registerNotificationsRoutes(localReadsApp);
registerOperationLogsRoutes(localReadsApp);
registerOwnerSessionsRoutes(localReadsApp);
registerMutualFollowsRoutes(localReadsApp);
