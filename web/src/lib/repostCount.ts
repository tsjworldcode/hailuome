/**
 * UX-FEED-REPOST-COUNT-1：当前已加载列表里，指向某条原帖的转发条数。
 * 不是全网权威计数（M9-1 明确延后）；本节点自己转过一次就会显示 1。
 */
export function normalizeRepostNodeUrl(url: string): string {
  return url.replace(/\/+$/, '');
}

export function originKeyForFeedItem(item: {
  readonly post_id: string;
  readonly node_url: string;
  readonly post_kind?: 'original' | 'repost';
  readonly repost_of?: { readonly post_id: string; readonly node_url: string } | null;
}): { readonly post_id: string; readonly node_url: string } {
  if (item.post_kind === 'repost' && item.repost_of) {
    return {
      post_id: item.repost_of.post_id,
      node_url: normalizeRepostNodeUrl(item.repost_of.node_url),
    };
  }
  return { post_id: item.post_id, node_url: normalizeRepostNodeUrl(item.node_url) };
}

export function countVisibleRepostsForItem(
  items: readonly {
    readonly post_kind?: 'original' | 'repost';
    readonly repost_of?: { readonly post_id: string; readonly node_url: string } | null;
  }[],
  item: {
    readonly post_id: string;
    readonly node_url: string;
    readonly post_kind?: 'original' | 'repost';
    readonly repost_of?: { readonly post_id: string; readonly node_url: string } | null;
  },
): number {
  const origin = originKeyForFeedItem(item);
  let n = 0;
  for (const it of items) {
    if (it.post_kind !== 'repost' || !it.repost_of) continue;
    // 以原帖 post_id 为准；node_url 规范化后不一致时仍计入（公开基址 vs 缓存基址）。
    if (it.repost_of.post_id === origin.post_id) n += 1;
  }
  return n;
}
