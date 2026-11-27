/**
 * Groups 路由：站主 JWT 面（/api/groups/*）。
 * NCF-AUDIT-Y-15-1：internal → ./groups/internal.ts；shared → ./groups/shared.ts。
 * NCF-AUDIT-Y-15-3：公开面按 lifecycle / invites / messages / media 注册。
 * 契约：路径 / 错误码 / HTTP 状态不变。
 */
import { Hono } from 'hono';
import type { AppEnv } from './groups/shared';
import { registerGroupsLifecycleRoutes } from './groups/lifecycle';
import { registerGroupsInvitesRoutes } from './groups/invites';
import { registerGroupsMessagesRoutes } from './groups/messages';
import { registerGroupsMediaRoutes } from './groups/media';

export { groupsInternalApp } from './groups/internal';

export const groupsApp = new Hono<AppEnv>();

registerGroupsMessagesRoutes(groupsApp);
registerGroupsLifecycleRoutes(groupsApp);
registerGroupsInvitesRoutes(groupsApp);
registerGroupsMediaRoutes(groupsApp);
