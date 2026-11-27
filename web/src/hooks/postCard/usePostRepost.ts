/**
 * NCF-WEB-2：转发确认 + 原帖懒加载。
 */
import { useEffect, useState } from 'preact/hooks';
import { createWorkerBClient, type FeedItem, type PostItem } from '../../lib/api';
import { getOwnerJwt, resolveWorkerAUrl } from '../../lib/auth';
import { readCachedOwnerHandle } from '../../lib/ownerSession';
import { ApiError } from '../../lib/errors';
import { showToast } from '../../lib/toast';
import { t } from '../../lib/i18n';
import { createWorkerAClient } from '../../lib/workerA';
import { getFollowerNodeUrl } from './shared';

export type UsePostRepostArgs = {
  item: FeedItem;
  handle: string;
  isOfficialPost: boolean;
  isRepostCard: boolean;
  onReposted?: () => void;
};

export function usePostRepost({
  item,
  handle,
  isOfficialPost,
  isRepostCard,
  onReposted,
}: UsePostRepostArgs) {
  const [repostBusy, setRepostBusy] = useState(false);
  const [repostConfirmOpen, setRepostConfirmOpen] = useState(false);
  const [originPost, setOriginPost] = useState<PostItem | null>(null);
  const [originLoading, setOriginLoading] = useState(false);
  const [originUnavailable, setOriginUnavailable] = useState(false);

  // M9-1-5：转发帖懒加载嵌套原帖正文（跨节点 Worker B GET /posts/:id）
  useEffect(() => {
    if (!isRepostCard || !item.repost_of) return;
    let cancelled = false;
    setOriginLoading(true);
    setOriginUnavailable(false);
    setOriginPost(null);
    void createWorkerBClient({
      baseUrl: item.repost_of.node_url,
      followerNodeUrl: getFollowerNodeUrl(),
      followerHandle: readCachedOwnerHandle(),
    })
      .getPostById(item.repost_of.post_id)
      .then((post) => {
        if (!cancelled) setOriginPost(post);
      })
      .catch(() => {
        if (!cancelled) setOriginUnavailable(true);
      })
      .finally(() => {
        if (!cancelled) setOriginLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [isRepostCard, item.repost_of?.node_url, item.repost_of?.post_id]);

  async function confirmRepost(): Promise<void> {
    if (isOfficialPost || isRepostCard || repostBusy) return;
    const baseUrl = await resolveWorkerAUrl();
    const jwt = getOwnerJwt();
    if (!baseUrl || !jwt) {
      setRepostConfirmOpen(false);
      showToast(t('postRepostLoginRequired'), 'error');
      return;
    }
    setRepostBusy(true);
    try {
      const client = createWorkerAClient({ baseUrl, getJwt: () => jwt });
      await client.repostPost({
        origin_node_url: item.node_url,
        origin_post_id: item.post_id,
        origin_author_handle: handle,
      });
      setRepostConfirmOpen(false);
      showToast(t('postRepostSuccess'));
      onReposted?.();
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : t('postRepostFailed');
      showToast(msg, 'error');
    } finally {
      setRepostBusy(false);
    }
  }

  return {
    repostBusy,
    repostConfirmOpen,
    setRepostConfirmOpen,
    originPost,
    originLoading,
    originUnavailable,
    confirmRepost,
  };
}
