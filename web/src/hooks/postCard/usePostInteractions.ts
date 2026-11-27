/**
 * NCF-WEB-2：点赞 / 回复 / 互动摘要。
 */
import { useEffect, useState } from 'preact/hooks';
import {
  createWorkerBClient,
  type InteractionSummary,
  type PostReply,
} from '../../lib/api';
import { readCachedOwnerHandle } from '../../lib/ownerSession';
import { showToast } from '../../lib/toast';
import { t } from '../../lib/i18n';
import { getFollowerNodeUrl, REPLY_MAX_LENGTH } from './shared';

export type UsePostInteractionsArgs = {
  isOfficialPost: boolean;
  interactionNodeUrl: string;
  interactionPostId: string;
};

export function usePostInteractions({
  isOfficialPost,
  interactionNodeUrl,
  interactionPostId,
}: UsePostInteractionsArgs) {
  const [interactionSummary, setInteractionSummary] = useState<InteractionSummary | null>(null);
  const [interactionBusy, setInteractionBusy] = useState(false);
  const [replyOpen, setReplyOpen] = useState(false);
  const [replyText, setReplyText] = useState('');
  const [replies, setReplies] = useState<readonly PostReply[]>([]);
  const [replyBusy, setReplyBusy] = useState(false);

  const likeCount = interactionSummary?.like_count ?? 0;
  const replyCount = interactionSummary?.reply_count ?? 0;
  const likedByMe = interactionSummary?.liked_by_me === true;

  function interactionClient() {
    return createWorkerBClient({
      baseUrl: interactionNodeUrl,
      followerNodeUrl: getFollowerNodeUrl(),
      followerHandle: readCachedOwnerHandle(),
    });
  }

  useEffect(() => {
    if (isOfficialPost) return;
    let cancelled = false;
    void interactionClient()
      .getInteractionSummary(interactionPostId)
      .then((summary) => {
        if (!cancelled) setInteractionSummary(summary);
      })
      .catch(() => {
        // 互动摘要失败不影响帖子阅读；按钮保持 0 计数。
      });
    return () => {
      cancelled = true;
    };
  }, [isOfficialPost, interactionNodeUrl, interactionPostId]);

  async function toggleLike(): Promise<void> {
    if (isOfficialPost) return;
    if (interactionBusy) return;
    setInteractionBusy(true);
    try {
      const summary = likedByMe
        ? await interactionClient().unlikePost(interactionPostId)
        : await interactionClient().likePost(interactionPostId);
      setInteractionSummary(summary);
    } catch (err) {
      showToast(err instanceof Error ? err.message : t('postLikeFailed'), 'error');
    } finally {
      setInteractionBusy(false);
    }
  }

  async function openReplies(): Promise<void> {
    if (isOfficialPost) return;
    const nextOpen = !replyOpen;
    setReplyOpen(nextOpen);
    if (!nextOpen || replies.length > 0) return;
    try {
      const data = await interactionClient().listReplies(interactionPostId, { limit: 5 });
      setReplies(data.items);
    } catch {
      // 回复列表读取失败不阻断输入；提交后仍会刷新摘要。
    }
  }

  async function submitReply(): Promise<void> {
    if (isOfficialPost) return;
    if (replyBusy) return;
    const content = replyText.trim();
    if (!content) return;
    if ([...content].length > REPLY_MAX_LENGTH) {
      showToast(t('postReplyTooLong', undefined, { max: REPLY_MAX_LENGTH }), 'error');
      return;
    }
    setReplyBusy(true);
    try {
      const data = await interactionClient().replyToPost(interactionPostId, content);
      setInteractionSummary(data.summary);
      setReplies((prev) => [data.reply, ...prev].slice(0, 5));
      setReplyText('');
      setReplyOpen(true);
    } catch (err) {
      showToast(err instanceof Error ? err.message : t('postReplyFailed'), 'error');
    } finally {
      setReplyBusy(false);
    }
  }

  return {
    likeCount,
    replyCount,
    likedByMe,
    interactionBusy,
    replyOpen,
    replyText,
    setReplyText,
    replies,
    replyBusy,
    toggleLike,
    openReplies,
    submitReply,
  };
}
