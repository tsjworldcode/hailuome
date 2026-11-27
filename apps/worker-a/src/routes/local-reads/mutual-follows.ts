/**
 * M17-2：GET /api/local/mutual-follows — 好友列表（accepted 请求 ∩ 本地仍 follows）
 *
 * M-OPT-SPLIT-A6-6：禁跨库 JOIN — 查询封装在 mutualFriendsProjection（CONTENT + IDENTITY）。
 * M17-4-2a：站主列表与公开投影共用同一互粉权威查询。
 */
import type { Hono } from 'hono';
import { listAcceptedMutualPeers } from '../../lib/mutualFriendsProjection';
import type { LocalReadsAppEnv } from './app';

export interface MutualFollowItem {
  readonly node_url: string;
  readonly handle: string;
  readonly display_name: string;
  readonly avatar_key: string;
  readonly request_id: string;
  readonly accepted_at: string | null;
}

export function registerMutualFollowsRoutes(app: Hono<LocalReadsAppEnv>): void {
  app.get('/mutual-follows', async (c) => {
    try {
      // 站主通讯录：默认上限 200（公开投影另走 clampMutualFriendsLimit ≤20）
      const peers = await listAcceptedMutualPeers(c.env);
      const items: MutualFollowItem[] = peers.map((p) => ({
        node_url: p.node_url,
        handle: p.handle,
        display_name: p.display_name,
        avatar_key: p.avatar_key,
        request_id: p.request_id,
        accepted_at: p.accepted_at,
      }));
      return c.json({ ok: true, data: { items } });
    } catch (err) {
      console.error('[local-reads/mutual-follows] 查询失败', err);
      return c.json(
        { ok: false, error_code: 'INTERNAL_ERROR', message: '查询好友列表失败，请稍后重试' },
        500,
      );
    }
  });
}
