/** @jsxImportSource preact */
import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import { AlertCircle, ChevronLeft, Loader2, MessageSquare, Mic, Paperclip, Phone, Square, Trash2, UserPlus } from 'lucide-preact';
import { ConfirmDialog } from './ConfirmDialog';
import { Contacts } from './Contacts';
import { AddFriendDialog } from './AddFriendDialog';
import { RtcCallOverlay } from './RtcCallOverlay';
import { createWorkerBClient } from '../lib/api';
import { ApiError } from '../lib/errors';
import { getDmKekMaterial, isDmLegacyIdentityPending } from '../lib/dmSession';
import {
  buildConversationSummaries,
  deleteLocalConversation,
  DmDeliveryFailedError,
  listPlaintextsForConversation,
  loadOlderDmMessages,
  MAX_DM_VOICE_BYTES,
  MAX_DM_VOICE_DURATION_MS,
  retryDmOutbox,
  sendDmMessage,
  syncInboxMessages,
  syncOutboxMessages,
  type DmConversationSummary,
} from '../lib/dmService';
import { resolveDmPeer } from '../lib/dmPeerResolve';
import { deriveConversationId } from '../lib/dmCrypto';
import { callSession, createDmCallSignalTransport } from '../lib/rtc';
import { resolvePublicWorkerBBaseUrlSync } from '../lib/deployEnv';
import { revokeDmMediaObjectUrls } from '../lib/messagingMediaClient';
import { refreshUnreadDmCount } from '../lib/dmUnreadStore';
// UX-MSG-LEFT-1：好友请求未读数提示在左栏「加好友」入口上（原通讯录 Tab 角标迁入）
import { unreadFriendRequestCount } from '../lib/friendRequestUnreadStore';
import type { DmMediaView, DmPlaintextRecord } from '../lib/dmLocalDb';
import { isQuotaExceeded } from '../lib/idbErrors';
import { formatRelativeTime } from '../lib/timeFormat';
import { createWorkerAClient } from '../lib/workerA';
import { ownerBaseUrl, ownerCredentialsReady, ownerJwt, useOwnerCredentials } from '../lib/useOwnerCredentials';
import { initLanguage, t } from '../lib/i18n';
import { subscribeMessagingEvents } from '../lib/messagingEventsClient';

/** M-RT-0a：无 SSE 时 1s 拉；M-RT-1：SSE 已连则降为 15s 兜底。 */
const POLL_MS = 1_000;
const POLL_MS_WITH_SSE = 15_000;
const MAX_DM_IMAGE_BYTES = 10 * 1024 * 1024;
/** M-RT-3：滚到"接近底部"的容差阈值（像素），超出则视为用户已向上翻看历史。 */
const DM_BOTTOM_THRESHOLD_PX = 80;
/** M-RT-3：滚到接近顶部时触发"加载更早"的容差阈值（像素）。 */
const DM_TOP_THRESHOLD_PX = 80;

/**
 * M-RT-3 + MSG-FIX-2：发送中占位。
 * 投递失败后 `messageId` 指向本机出件箱行，重试走同信封 `retryDmOutbox`（不重新签发）。
 */
interface DmPendingOutbox {
  readonly tempId: string;
  /** MSG-FIX-2：本机已落库后的真实 message_id；有则重试同信封。 */
  readonly messageId: string | null;
  readonly conversationId: string;
  readonly peerHandle: string;
  readonly plaintext: string;
  readonly createdAt: string;
  readonly media: DmMediaView | null;
  readonly voiceFile: File | null;
  readonly voiceDurationMs: number | null;
  readonly voicePreviewUrl: string | null;
  readonly imagePreviewUrl: string | null;
  status: 'sending' | 'failed';
  /**
   * UX-MSG-SEND-1：占位先上屏、后解析对端 → 网络阶段 input 仍为 null；
   * 解析成功再回填，重试时若仍未回填则按 handle 重新解析。
   */
  readonly input: SendDmInputLike | null;
}

/**
 * M-RT-3：可重发的 send 输入集（retry 路径直接复用，不重新拼装）。
 * 与 dmService.SendDmInput 字段一一对应；显式声明便于 retryDmMessage 复用。
 */
interface SendDmInputLike {
  readonly client: ReturnType<typeof createWorkerAClient>;
  readonly api: ReturnType<typeof createWorkerBClient>;
  readonly senderHandle: string;
  readonly senderWorkerBUrl: string;
  readonly recipientHandle: string;
  readonly recipientWorkerBUrl: string;
  readonly recipientDmPubkey: string;
  readonly passwordHash: string;
}

/**
 * M-RT-3：从 blob URL 反查原 File（仅 image 预览路径需要；voice 已经在 entry.voiceFile 持有）。
 * 旧 blob URL 已被 revoke 时返回 undefined，由调用方走纯文本重发。
 */
async function fetchImageFileFromPreview(previewUrl: string | null): Promise<File | undefined> {
  if (!previewUrl) return undefined;
  try {
    const resp = await fetch(previewUrl);
    if (!resp.ok) return undefined;
    const blob = await resp.blob();
    if (!blob || blob.size === 0) return undefined;
    return new File([blob], 'retry-image', { type: blob.type || 'application/octet-stream' });
  } catch {
    return undefined;
  }
}

function pickVoiceRecorderMime(): string | undefined {
  if (typeof MediaRecorder === 'undefined') return undefined;
  const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4'];
  return candidates.find((m) => MediaRecorder.isTypeSupported(m));
}

function formatVoiceDuration(ms: number | undefined): string {
  const totalSec = Math.max(0, Math.round((ms ?? 0) / 1000));
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function DmMediaBubble({
  item,
  imageAlt,
  voiceAlt,
}: {
  readonly item: DmMediaView;
  readonly imageAlt: string;
  readonly voiceAlt: string;
}) {
  if (!item.object_url) return null;
  if (item.mime.startsWith('audio/')) {
    return (
      <div class="mb-2">
        <audio
          controls
          preload="metadata"
          src={item.object_url}
          class="w-full max-w-xs"
          aria-label={voiceAlt}
        />
        {item.duration_ms != null && item.duration_ms > 0 ? (
          <p class="mt-0.5 text-[10px] opacity-80">{formatVoiceDuration(item.duration_ms)}</p>
        ) : null}
      </div>
    );
  }
  return (
    <img
      src={item.object_url}
      alt={imageAlt}
      class="mb-2 max-h-64 w-full rounded-lg object-contain"
      loading="lazy"
    />
  );
}

/**
 * UX-MSG-SEND-1：待发气泡被移除（发送成功 / 切换会话）时释放它持有的预览 blob URL。
 * 发送瞬间输入框会把预览 URL 的“所有权”交给消息记录里的待发气泡（不 revoke）。
 */
function revokePendingPreviewUrls(entries: readonly DmPendingOutbox[]): void {
  for (const entry of entries) {
    if (entry.imagePreviewUrl) URL.revokeObjectURL(entry.imagePreviewUrl);
    if (entry.voicePreviewUrl) URL.revokeObjectURL(entry.voicePreviewUrl);
  }
}

/** 发送成功后立刻上屏：按 message_id 合并，避免与随后 poll 重复。 */
function upsertDmMessage(
  prev: readonly DmPlaintextRecord[],
  record: DmPlaintextRecord,
): DmPlaintextRecord[] {
  const next = prev.filter((m) => m.message_id !== record.message_id);
  next.push(record);
  return next.sort((a, b) => a.created_at.localeCompare(b.created_at));
}

type MobilePane = 'list' | 'chat';

function senderHue(handle: string): number {
  let h = 0;
  for (let i = 0; i < handle.length; i++) h = (h * 31 + handle.charCodeAt(i)) >>> 0;
  return h % 360;
}

function senderLetter(handle: string): string {
  const trimmed = handle.trim();
  return (trimmed.charAt(0) || '?').toUpperCase();
}

function SenderAvatar({
  handle,
  hue,
  visible,
}: {
  readonly handle: string;
  readonly hue: number;
  readonly visible: boolean;
}) {
  if (!visible) {
    return <span class="w-9 shrink-0" aria-hidden="true" />;
  }
  return (
    <span
      class="mb-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-xs font-bold text-white shadow-md ring-2 ring-white/80 dark:ring-zinc-800"
      style={{ backgroundColor: `hsl(${hue}, 55%, 48%)` }}
      aria-hidden="true"
      title={`@${handle}`}
    >
      {senderLetter(handle)}
    </span>
  );
}

/** UX-MSG-3：私信页对齐群聊 — 单框中线、960 互斥、电报气泡/输入栏。 */
export function Messages() {
  const [conversations, setConversations] = useState<readonly DmConversationSummary[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [messages, setMessages] = useState<readonly DmPlaintextRecord[]>([]);
  const [compose, setCompose] = useState('');
  const [pendingImage, setPendingImage] = useState<File | null>(null);
  const [pendingVoice, setPendingVoice] = useState<File | null>(null);
  const [pendingVoiceDurationMs, setPendingVoiceDurationMs] = useState<number | null>(null);
  const [pendingPreviewUrl, setPendingPreviewUrl] = useState<string | null>(null);
  const [recording, setRecording] = useState(false);
  const [peerHandle, setPeerHandle] = useState('');
  /** UX-MSG-LEFT-1：左栏「加好友」弹窗 */
  const [addFriendOpen, setAddFriendOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [deletingConversation, setDeletingConversation] = useState(false);
  const [meHandle, setMeHandle] = useState('');
  const [meWorkerB, setMeWorkerB] = useState('');
  const [mobilePane, setMobilePane] = useState<MobilePane>('list');
  /** M-RT-3：发送中 / 失败占位（不入 IDB）。 */
  const [pendingDm, setPendingDm] = useState<readonly DmPendingOutbox[]>([]);
  /** M-RT-3：分页游标（指向当前已显示消息中最早一条之前；null = 还没翻过头）。 */
  const [olderCursorDm, setOlderCursorDm] = useState<string | null>(null);
  const [hasMoreHistoryDm, setHasMoreHistoryDm] = useState(true);
  const [loadingOlderDm, setLoadingOlderDm] = useState(false);
  /** M-RT-3：用户不在底部时累积"新消息"计数。 */
  const [newDmCount, setNewDmCount] = useState(0);
  /** M-RT-3：滚动 / 视口哨兵。 */
  const chatScrollRef = useRef<HTMLDivElement | null>(null);
  const chatEndRef = useRef<HTMLDivElement | null>(null);
  const atBottomRef = useRef(true);
  /**
   * M-RT-3-FIX：上一轮消息列表的最后一条 id。
   * 只对「尾部真正追加」的收件消息计数 —— 轮询每轮都会整表重设 messages（数组引用必变），
   * 不能按「引用变了就 +1」计数，否则没有新消息也会每隔一轮涨一条。
   */
  const lastDmMessageIdRef = useRef<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const selectedIdRef = useRef<string | null>(null);
  const meHandleRef = useRef('');
  const meWorkerBRef = useRef('');
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const voiceChunksRef = useRef<Blob[]>([]);
  const voiceStartedAtRef = useRef(0);
  const voiceMaxTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const voiceDiscardRef = useRef(false);
  const sseLiveRef = useRef(false);
  /** 出件箱回灌每个页面会话只做一次：之后本端发送会直接写本地明文。 */
  const outboxHydratedRef = useRef(false);
  /** UX-MSG-SEND-1：切换会话时按最新占位释放预览 URL（避免闭包拿到旧数组）。 */
  const pendingDmRef = useRef<readonly DmPendingOutbox[]>([]);
  const pendingPreviewUrlRef = useRef<string | null>(null);
  selectedIdRef.current = selectedId;
  pendingDmRef.current = pendingDm;
  pendingPreviewUrlRef.current = pendingPreviewUrl;

  useEffect(() => {
    initLanguage();
  }, []);

  const reloadConversations = useCallback(async () => {
    const rows = await buildConversationSummaries();
    setConversations(rows);
  }, []);

  const configureRtcTransport = useCallback((): boolean => {
    const baseUrl = ownerBaseUrl.value;
    const jwt = ownerJwt.value;
    const kek = getDmKekMaterial();
    const handle = meHandleRef.current;
    const workerBUrl = meWorkerBRef.current;
    if (!baseUrl || !jwt || !kek || !handle || !workerBUrl) return false;
    const workerA = createWorkerAClient({ baseUrl, getJwt: () => jwt });
    // MSG-FIX-1：api 仅占位；投递在 sendDmCallSignal 内按对端 URL 建 client
    const localWorkerB = createWorkerBClient({
      baseUrl: resolvePublicWorkerBBaseUrlSync(workerBUrl),
      followerNodeUrl: workerBUrl,
      followerHandle: handle,
    });
    callSession.configure({
      meHandle: handle,
      transport: createDmCallSignalTransport({
        client: workerA,
        api: localWorkerB,
        senderHandle: handle,
        senderWorkerBUrl: workerBUrl,
        passwordHash: kek,
        resolvePeer: async (peerHandle) => {
          const peer = await resolveDmPeer(peerHandle, {
            client: workerA,
            meWorkerB: workerBUrl,
            meHandle: handle,
          });
          return {
            worker_b_url: peer.worker_b_url,
            dm_pubkey: peer.dm_pubkey,
          };
        },
      }),
    });
    return true;
  }, []);

  const pollInbox = useCallback(async () => {
    const baseUrl = ownerBaseUrl.value;
    const jwt = ownerJwt.value;
    const kek = getDmKekMaterial();
    if (!baseUrl || !jwt || !kek) return;
    const client = createWorkerAClient({ baseUrl, getJwt: () => jwt });
    const conversationId = selectedIdRef.current;
    try {
      configureRtcTransport();
      // 先回灌本端发出的历史（换客户端/重新登录后本地明文已清空），再同步收件箱
      if (!outboxHydratedRef.current) {
        await syncOutboxMessages(client, kek);
        outboxHydratedRef.current = true;
      }
      const synced = await syncInboxMessages(client, kek);
      for (const cs of synced.callSignals) {
        await callSession.handleInboundSignal({
          messageId: cs.message_id,
          peerHandle: cs.peer_handle,
          direction: cs.direction,
          signal: cs.signal,
        });
      }
      await reloadConversations();
      if (conversationId) {
        setMessages(await listPlaintextsForConversation(conversationId));
      }
      void refreshUnreadDmCount();
    } catch {
      // 轮询静默
    }
  }, [configureRtcTransport, reloadConversations]);

  const startPollInterval = useCallback(() => {
    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = null;
    if (document.visibilityState !== 'visible') return;
    const ms = sseLiveRef.current ? POLL_MS_WITH_SSE : POLL_MS;
    pollRef.current = setInterval(() => void pollInbox(), ms);
  }, [pollInbox]);

  useOwnerCredentials(() => {
    const baseUrl = ownerBaseUrl.value;
    const jwt = ownerJwt.value;
    if (!baseUrl || !jwt) {
      setError(t('registryCertifyLoginRequired'));
      setLoading(false);
      return;
    }
    if (!getDmKekMaterial()) {
      setError(t('messagesDmReloginRequired'));
      setLoading(false);
      return;
    }
    const client = createWorkerAClient({ baseUrl, getJwt: () => jwt });
    void (async () => {
      // UX-MSG-PERF：本地会话先出壳，收件箱同步放后台，避免点进消息先白屏等解密
      try {
        setConversations(await buildConversationSummaries());
      } catch {
        // IDB 不可用时仍继续走网络同步
      }
      setLoading(false);
      try {
        const me = await client.getMe();
        meHandleRef.current = me.handle;
        meWorkerBRef.current = me.worker_b_url ?? resolvePublicWorkerBBaseUrlSync();
        setMeHandle(meHandleRef.current);
        setMeWorkerB(meWorkerBRef.current);
        await pollInbox();
      } catch (err) {
        setError(err instanceof ApiError ? err.displayMessage : t('messagesLoadFailed'));
      }
    })();
  });

  useEffect(() => {
    const onVis = () => {
      if (document.visibilityState === 'hidden') {
        if (pollRef.current) clearInterval(pollRef.current);
        pollRef.current = null;
      } else {
        void pollInbox();
        startPollInterval();
      }
    };
    onVis();
    document.addEventListener('visibilitychange', onVis);
    return () => {
      document.removeEventListener('visibilitychange', onVis);
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [pollInbox, startPollInterval]);

  // M-RT-1：可见时订 SSE；NEW(dm) 立刻 poll，少打空请求
  useEffect(() => {
    let sub: ReturnType<typeof subscribeMessagingEvents> | null = null;
    const start = () => {
      sub?.stop();
      sub = null;
      const baseUrl = ownerBaseUrl.value;
      if (!baseUrl || document.visibilityState !== 'visible') return;
      sub = subscribeMessagingEvents({
        baseUrl,
        getJwt: () => ownerJwt.value,
        onStatus: (live) => {
          sseLiveRef.current = live;
          startPollInterval();
        },
        onEvent: (ev) => {
          if (ev.type === 'NEW' && ev.scope === 'dm') {
            void pollInbox();
          }
        },
      });
    };
    const onVis = () => {
      if (document.visibilityState === 'hidden') {
        sub?.stop();
        sub = null;
        sseLiveRef.current = false;
        startPollInterval();
      } else {
        start();
      }
    };
    start();
    document.addEventListener('visibilitychange', onVis);
    return () => {
      document.removeEventListener('visibilitychange', onVis);
      sub?.stop();
      sseLiveRef.current = false;
    };
  }, [pollInbox, startPollInterval]);

  /** M-RT-3：滚到聊天区底部；用户主动点击「跳到最新」时 smooth=true。 */
  function scrollDmToBottom(smooth = false): void {
    const end = chatEndRef.current;
    if (!end) return;
    try {
      end.scrollIntoView({ block: 'end', behavior: smooth ? 'smooth' : 'auto' });
    } catch {
      // 旧浏览器不支持 scrollIntoV options 时降级直接滚
      const el = chatScrollRef.current;
      if (el) el.scrollTop = el.scrollHeight;
    }
    atBottomRef.current = true;
  }

  /** M-RT-3：滚区滚动回调 — 决定新消息是否自动跟上来 + 是否触发顶部加载更早。 */
  function handleDmChatScroll(): void {
    const el = chatScrollRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight <= DM_BOTTOM_THRESHOLD_PX;
    atBottomRef.current = nearBottom;
    if (nearBottom && newDmCount > 0) setNewDmCount(0);
    const nearTop = el.scrollTop <= DM_TOP_THRESHOLD_PX;
    if (nearTop && hasMoreHistoryDm && !loadingOlderDm) {
      void loadOlderDmHistory();
    }
  }

  /** M-RT-3：选中会话 → 拉首屏 + 记录"再往前一页"的 cursor。 */
  async function loadInitialDmHistory(conversationId: string): Promise<void> {
    const baseUrl = ownerBaseUrl.value;
    const jwt = ownerJwt.value;
    const kek = getDmKekMaterial();
    if (!baseUrl || !jwt || !kek) return;
    try {
      const client = createWorkerAClient({ baseUrl, getJwt: () => jwt });
      // 复用 listPlaintextsForConversation 读 IDB 已有 row
      const local = await listPlaintextsForConversation(conversationId);
      setMessages(local);
      // 取首页 + 后续 cursor；走与 loadOlderDmHistory 同样的链路便于共用状态
      const page = await loadOlderDmMessages(client, kek, conversationId, null);
      const merged = page.items.length > 0 ? page.items : local;
      setMessages(merged);
      setOlderCursorDm(page.nextCursor);
      setHasMoreHistoryDm(page.hasMore);
      setNewDmCount(0);
      atBottomRef.current = true;
      requestAnimationFrame(() => scrollDmToBottom(false));
    } catch {
      // 静默：失败不阻断 UI（poll 后续会兜底）
    }
  }

  /** M-RT-3：滚动到顶时按 cursor 取更早一页；保留滚动位置避免视觉跳变。 */
  async function loadOlderDmHistory(): Promise<void> {
    if (loadingOlderDm || !hasMoreHistoryDm) return;
    const baseUrl = ownerBaseUrl.value;
    const jwt = ownerJwt.value;
    const kek = getDmKekMaterial();
    const conversationId = selectedIdRef.current;
    if (!baseUrl || !jwt || !kek || !conversationId) return;
    const scrollEl = chatScrollRef.current;
    const prevScrollHeight = scrollEl?.scrollHeight ?? 0;
    const prevScrollTop = scrollEl?.scrollTop ?? 0;
    setLoadingOlderDm(true);
    try {
      const client = createWorkerAClient({ baseUrl, getJwt: () => jwt });
      const page = await loadOlderDmMessages(client, kek, conversationId, olderCursorDm);
      if (page.items.length > 0) {
        setMessages((prev) => {
          const map = new Map(prev.map((m) => [m.message_id, m]));
          for (const item of page.items) map.set(item.message_id, item);
          return [...map.values()].sort((a, b) => a.created_at.localeCompare(b.created_at));
        });
      }
      setOlderCursorDm(page.nextCursor);
      setHasMoreHistoryDm(page.hasMore);
      // 维持滚动位置：新内容在顶部，旧内容整体下移 → scrollTop += 新增量
      requestAnimationFrame(() => {
        const el = chatScrollRef.current;
        if (!el) return;
        const newScrollHeight = el.scrollHeight;
        const delta = newScrollHeight - prevScrollHeight;
        if (delta > 0) {
          el.scrollTop = prevScrollTop + delta;
        }
      });
    } catch (err) {
      // 失败仅记录，不弹 toast（M7-13 toast 通道仅用于 quota / 致命错误）
      if (!isQuotaExceeded(err)) {
        console.warn('[m-rt-3] 加载更早私信失败', err);
      }
    } finally {
      setLoadingOlderDm(false);
    }
  }

  /** MSG-FIX-2：失败重试 — 优先同信封 retryDmOutbox；无 messageId 时才回落重新签发。 */
  async function handleRetryDmPending(tempId: string): Promise<void> {
    const entry = pendingDm.find((p) => p.tempId === tempId);
    if (!entry) return;
    setPendingDm((prev) =>
      prev.map((p) => (p.tempId === tempId ? { ...p, status: 'sending' } : p)),
    );
    setError(null);
    try {
      let record: DmPlaintextRecord;
      // UX-MSG-SEND-1：对端解析阶段就失败的占位 input 仍为空 → 重试时按 handle 重新解析
      const input = entry.input ?? (await buildSendInput(entry.peerHandle));
      if (entry.messageId) {
        record = await retryDmOutbox({
          client: input.client,
          senderHandle: input.senderHandle,
          senderWorkerBUrl: input.senderWorkerBUrl,
          messageId: entry.messageId,
        });
      } else {
        // 兼容：占位尚未落库就失败（极少）→ 仍走新签发
        const imageFile = await fetchImageFileFromPreview(entry.imagePreviewUrl);
        record = await sendDmMessage({
          ...input,
          plaintext: entry.plaintext,
          imageFile,
          voiceFile: entry.voiceFile ?? undefined,
          voiceDurationMs: entry.voiceDurationMs ?? undefined,
        });
      }
      revokePendingPreviewUrls([entry]);
      setPendingDm((prev) => prev.filter((p) => p.tempId !== tempId));
      setMessages((prev) => upsertDmMessage(prev, record));
      await reloadConversations();
      void pollInbox();
      void refreshUnreadDmCount();
    } catch (err) {
      const failedRecord = err instanceof DmDeliveryFailedError ? err.record : null;
      setPendingDm((prev) =>
        prev.map((p) =>
          p.tempId === tempId
            ? {
                ...p,
                status: 'failed',
                messageId: failedRecord?.message_id ?? p.messageId,
              }
            : p,
        ),
      );
      if (failedRecord) setMessages((prev) => upsertDmMessage(prev, failedRecord));
      setError(
        err instanceof DmDeliveryFailedError || err instanceof ApiError
          ? err.message
          : t('messagesSendFailed'),
      );
    }
  }

  useEffect(() => {
    if (!selectedId) {
      revokeDmMediaObjectUrls(messages);
      setMessages([]);
      // 切换会话前先清掉上一次会话的 pending / 分页状态（同时释放待发气泡的预览 URL）
      setPendingDm((prev) => {
        revokePendingPreviewUrls(prev);
        return [];
      });
      setOlderCursorDm(null);
      setHasMoreHistoryDm(true);
      setNewDmCount(0);
      lastDmMessageIdRef.current = null;
      return;
    }
    // 发送流程会把 selectedId 设为本条会话：保留该会话的待发占位，只清掉其它会话的
    setPendingDm((prev) => {
      const keep = prev.filter((p) => p.conversationId === selectedId);
      if (keep.length === prev.length) return prev;
      revokePendingPreviewUrls(prev.filter((p) => p.conversationId !== selectedId));
      return keep;
    });
    void loadInitialDmHistory(selectedId);
    // M-RT-3-FIX：换会话时清掉上一会话的尾部锚点，避免把新会话历史误判成「新增」
    lastDmMessageIdRef.current = null;
    return () => {
      revokeDmMediaObjectUrls(messages);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId]);

  /**
   * M-RT-3-FIX：messages / pendingDm 变化时，靠近底部就自动滚到底；不在底则按「尾部新增」累计条数。
   * 关键修法：
   * ① 轮询每轮都会整表重设 messages，必须按消息 id 判断「旧尾之后追加了几条」，
   *    否则引用一变就 +1，会凭空涨出「N 条新消息」；
   * ② 加载更早历史是往头部补，旧尾不变 → 不算新消息；
   * ③ 自己发出的消息（direction=outbox）与 pending 占位都不计入。
   */
  useEffect(() => {
    const prevLastId = lastDmMessageIdRef.current;
    lastDmMessageIdRef.current =
      messages.length > 0 ? messages[messages.length - 1].message_id : null;
    // 认不出旧尾（切换会话 / 整表替换）时一律不计数，避免把历史整页当成新消息
    const prevLastIndex = prevLastId
      ? messages.findIndex((m) => m.message_id === prevLastId)
      : -1;
    const appended = prevLastIndex >= 0 ? messages.slice(prevLastIndex + 1) : [];
    const inboundAdded = appended.filter((m) => m.direction === 'inbox').length;

    // UX-MOBILE-FEED-CHAT-1：输入获焦时跳过 scrollIntoView，避免手机键盘区闪烁
    const active = typeof document !== 'undefined' ? document.activeElement : null;
    const composing =
      active instanceof HTMLTextAreaElement || active instanceof HTMLInputElement;
    if (atBottomRef.current) {
      if (!composing && (appended.length > 0 || pendingDm.length > 0)) {
        requestAnimationFrame(() => scrollDmToBottom(false));
      }
      if (newDmCount > 0) setNewDmCount(0);
    } else if (inboundAdded > 0) {
      // 只累加真正新增的收件条数（一次轮询补多条也只涨真实条数）
      setNewDmCount((c) => c + inboundAdded);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages, pendingDm]);

  useEffect(() => {
    return () => {
      // UX-MSG-SEND-1：卸载时统一释放输入框预览与“正在发送”气泡持有的 blob URL。
      // 注意：不能监听 pendingPreviewUrl 变化自动 revoke —— 发送瞬间 URL 已转交给气泡。
      if (pendingPreviewUrlRef.current) URL.revokeObjectURL(pendingPreviewUrlRef.current);
      revokePendingPreviewUrls(pendingDmRef.current);
      if (voiceMaxTimerRef.current) clearTimeout(voiceMaxTimerRef.current);
      const rec = mediaRecorderRef.current;
      if (rec && rec.state !== 'inactive') {
        try {
          rec.stop();
        } catch {
          // 卸载时忽略
        }
      }
    };
  }, []);

  function clearPendingPreview(): void {
    if (pendingPreviewUrl) URL.revokeObjectURL(pendingPreviewUrl);
    setPendingPreviewUrl(null);
  }

  function clearPendingMedia(): void {
    clearPendingPreview();
    setPendingImage(null);
    setPendingVoice(null);
    setPendingVoiceDurationMs(null);
  }

  /**
   * UX-MSG-SEND-1：发送瞬间把待发媒体移交给消息记录里的「正在发送」气泡。
   * 只清输入框状态、不 revoke 预览 URL —— 否则气泡里的图片/语音会立刻失效。
   */
  function detachPendingMediaToPendingBubble(): void {
    setPendingPreviewUrl(null);
    setPendingImage(null);
    setPendingVoice(null);
    setPendingVoiceDurationMs(null);
  }

  function handlePickImage(file: File | null): void {
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      setError(t('messagesImageTypeInvalid'));
      return;
    }
    if (file.size > MAX_DM_IMAGE_BYTES) {
      setError(t('messagesImageTooLarge'));
      return;
    }
    clearPendingMedia();
    setPendingImage(file);
    setPendingPreviewUrl(URL.createObjectURL(file));
    setError(null);
  }

  function stopVoiceRecording(discard = false): void {
    if (voiceMaxTimerRef.current) {
      clearTimeout(voiceMaxTimerRef.current);
      voiceMaxTimerRef.current = null;
    }
    voiceDiscardRef.current = discard;
    const rec = mediaRecorderRef.current;
    if (rec && rec.state === 'recording') {
      rec.stop();
    } else if (discard) {
      voiceDiscardRef.current = false;
    }
  }

  async function startVoiceRecording(): Promise<void> {
    if (recording) return;
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
      setError(t('messagesVoiceUnsupported'));
      return;
    }
    clearPendingMedia();
    setError(null);
    voiceDiscardRef.current = false;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mime = pickVoiceRecorderMime();
      const rec = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);
      voiceChunksRef.current = [];
      voiceStartedAtRef.current = Date.now();
      rec.ondataavailable = (ev) => {
        if (ev.data.size > 0) voiceChunksRef.current.push(ev.data);
      };
      rec.onstop = () => {
        stream.getTracks().forEach((track) => track.stop());
        mediaRecorderRef.current = null;
        setRecording(false);
        if (voiceDiscardRef.current) {
          voiceDiscardRef.current = false;
          voiceChunksRef.current = [];
          return;
        }
        const type = rec.mimeType || 'audio/webm';
        const blob = new Blob(voiceChunksRef.current, { type });
        const durationMs = Math.min(
          Date.now() - voiceStartedAtRef.current,
          MAX_DM_VOICE_DURATION_MS,
        );
        if (blob.size === 0) return;
        if (blob.size > MAX_DM_VOICE_BYTES) {
          setError(t('messagesVoiceTooLarge'));
          return;
        }
        const ext = type.includes('ogg') ? 'ogg' : type.includes('mp4') ? 'm4a' : 'webm';
        const file = new File([blob], `voice.${ext}`, { type });
        setPendingVoice(file);
        setPendingVoiceDurationMs(durationMs);
        setPendingPreviewUrl(URL.createObjectURL(blob));
      };
      mediaRecorderRef.current = rec;
      rec.start(250);
      setRecording(true);
      voiceMaxTimerRef.current = setTimeout(() => {
        voiceMaxTimerRef.current = null;
        if (mediaRecorderRef.current === rec && rec.state === 'recording') {
          rec.stop();
        }
      }, MAX_DM_VOICE_DURATION_MS);
    } catch {
      setError(t('messagesVoiceMicDenied'));
      setRecording(false);
    }
  }

  function toggleVoiceRecording(): void {
    if (recording) {
      stopVoiceRecording();
      return;
    }
    void startVoiceRecording();
  }

  function ensureRtcTransport(): boolean {
    return configureRtcTransport();
  }

  async function startVoiceCall(): Promise<void> {
    const handle = peerHandle.trim().toLowerCase();
    if (!handle) return;
    if (!ensureRtcTransport()) {
      setError(t('messagesDmReloginRequired'));
      return;
    }
    setError(null);
    try {
      await callSession.startOutgoing(handle);
      void pollInbox();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('rtcCallFailed'));
    }
  }

  /**
   * UX-MSG-LEFT-1：左栏点好友即开聊（类似微信）。
   * 有会话则选中；没有则 peerHandle + selectedId=null 进入可发首条的空聊。
   */
  function openChatWith(handle: string): void {
    const normalized = handle.trim().toLowerCase();
    if (!normalized) return;
    const existing = conversations.find((c) => c.peer_handle === normalized);
    setPeerHandle(normalized);
    setSelectedId(existing?.conversation_id ?? null);
    setMobilePane('chat');
    setCompose('');
    clearPendingMedia();
    if (recording) stopVoiceRecording(true);
    setError(null);
  }

  /**
   * MSG-FIX-1：按 handle 解析对端并组装发送所需输入（投递直接打对端 Worker B）。
   * 从 handleSend 抽出：失败重试时若占位仍未回填 input，也能按 handle 重新解析。
   */
  async function buildSendInput(handle: string): Promise<SendDmInputLike> {
    const baseUrl = ownerBaseUrl.value;
    const jwt = ownerJwt.value;
    const kek = getDmKekMaterial();
    if (!baseUrl || !jwt || !kek) {
      throw new ApiError(401, null, t('messagesDmReloginRequired'));
    }
    const workerA = createWorkerAClient({ baseUrl, getJwt: () => jwt });
    // MSG-FIX-1：peer 走 follows/lookup/对端公开资料，禁止本机 /users/:handle 猜联邦目录
    const peer = await resolveDmPeer(handle, {
      client: workerA,
      meWorkerB,
      meHandle,
    });
    const deliverWorkerB = createWorkerBClient({
      baseUrl: resolvePublicWorkerBBaseUrlSync(peer.worker_b_url),
      followerNodeUrl: meWorkerB,
      followerHandle: meHandle,
    });
    return {
      client: workerA,
      api: deliverWorkerB,
      senderHandle: meHandle,
      senderWorkerBUrl: meWorkerB,
      recipientHandle: handle,
      recipientWorkerBUrl: peer.worker_b_url,
      recipientDmPubkey: peer.dm_pubkey,
      passwordHash: kek,
    };
  }

  /**
   * UX-MSG-SEND-1：点发送即上屏。
   *
   * 顺序：先把这条挂进 pendingDm（消息记录里显示「正在发送中」）→ 立即清空输入框
   * → 再解析对端并发信。输入框和发送按钮全程不显示「发送中」。
   */
  async function handleSend(): Promise<void> {
    const handle = peerHandle.trim().toLowerCase();
    const plaintext = compose;
    const imageFile = pendingImage;
    const voiceFile = pendingVoice;
    const voiceDurationMs = pendingVoiceDurationMs;
    const previewUrl = pendingPreviewUrl;
    if (!handle || (!plaintext.trim() && !imageFile && !voiceFile)) return;
    setError(null);

    // 本地会话 id 是纯本地哈希（不走网络）；先算出来挂在占位上供重试使用
    const conversationId = await deriveConversationId(meHandle, handle);
    const tempId = `temp-dm-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const sendingNow: DmPendingOutbox = {
      tempId,
      messageId: null,
      conversationId,
      peerHandle: handle,
      plaintext,
      createdAt: new Date().toISOString(),
      media: null,
      voiceFile,
      voiceDurationMs,
      voicePreviewUrl: voiceFile ? previewUrl : null,
      imagePreviewUrl: imageFile ? previewUrl : null,
      status: 'sending',
      input: null,
    };
    // 立即上屏 + 清空输入框；预览 blob URL 所有权转交给待发气泡（此处不 revoke）
    setPendingDm((prev) => [...prev, sendingNow]);
    setCompose('');
    detachPendingMediaToPendingBubble();
    // 新会话首次发送时移动端直接切到聊天区
    setMobilePane('chat');

    try {
      const sendInput = await buildSendInput(handle);
      // 解析成功回填 input：失败重试走同信封（retryDmOutbox），不重新签发
      setPendingDm((prev) =>
        prev.map((p) => (p.tempId === tempId ? { ...p, input: sendInput } : p)),
      );
      const record = await sendDmMessage({
        ...sendInput,
        plaintext,
        imageFile: imageFile ?? undefined,
        voiceFile: voiceFile ?? undefined,
        voiceDurationMs: voiceDurationMs ?? undefined,
      });
      // M-RT-0a：先本地上屏再立刻拉一次 inbox，不等下一轮 1s poll
      selectedIdRef.current = record.conversation_id;
      setSelectedId(record.conversation_id);
      setMobilePane('chat');
      setMessages((prev) => upsertDmMessage(prev, record));
      revokePendingPreviewUrls([sendingNow]);
      setPendingDm((prev) => prev.filter((p) => p.tempId !== tempId));
      await reloadConversations();
      void pollInbox();
      void refreshUnreadDmCount();
    } catch (err) {
      // MSG-FIX-2：本机已落库时把真 message 上屏，重试用同信封
      if (err instanceof DmDeliveryFailedError) {
        const { record } = err;
        selectedIdRef.current = record.conversation_id;
        setSelectedId(record.conversation_id);
        setMobilePane('chat');
        setMessages((prev) => upsertDmMessage(prev, record));
        // 只匹配本轮 tempId，避免并发多条 sending 被同一 message_id 污染
        setPendingDm((prev) =>
          prev.map((p) =>
            p.tempId === tempId
              ? { ...p, status: 'failed', messageId: record.message_id, conversationId: record.conversation_id }
              : p,
          ),
        );
        setError(err.message);
        await reloadConversations();
      } else {
        setPendingDm((prev) =>
          prev.map((p) => (p.tempId === tempId ? { ...p, status: 'failed' } : p)),
        );
        setError(err instanceof ApiError ? err.displayMessage : t('messagesSendFailed'));
      }
    }
  }

  async function confirmDeleteConversation(): Promise<void> {
    if (!selectedId) return;
    const baseUrl = ownerBaseUrl.value;
    const jwt = ownerJwt.value;
    if (!baseUrl || !jwt) return;
    setDeletingConversation(true);
    const client = createWorkerAClient({ baseUrl, getJwt: () => jwt });
    try {
      await client.deleteDmConversation(selectedId);
      await deleteLocalConversation(selectedId);
      setSelectedId(null);
      setPeerHandle('');
      setMobilePane('list');
      setDeleteConfirmOpen(false);
      await reloadConversations();
    } catch (err) {
      setError(err instanceof ApiError ? err.displayMessage : t('messagesDeleteFailed'));
    } finally {
      setDeletingConversation(false);
    }
  }

  if (!ownerCredentialsReady.value) {
    return <p class="text-sm text-zinc-500">{t('commonCheckingLogin')}</p>;
  }
  if (loading) {
    return <p class="text-sm text-zinc-500">{t('messagesLoading')}</p>;
  }

  const selected = conversations.find((c) => c.conversation_id === selectedId);
  const activePeer = (selected?.peer_handle || peerHandle).trim();
  const chatReady = Boolean(activePeer);
  // 移动端左栏（好友列表）与右侧聊天互斥显示
  const showListOnMobile = mobilePane === 'list';
  const showChatOnMobile = mobilePane === 'chat';
  const meDisplay = meHandle.trim() || 'me';
  const meHue = senderHue(meDisplay);
  const canSend = Boolean(compose.trim() || pendingImage || pendingVoice);
  /**
   * UX-MSG-SEND-1：投递失败时本机已把消息写进 IDB，poll 会把它带回来；
   * 同一 message_id 的“发送失败”占位已经在上屏显示 → 历史区过滤掉真身，避免一条消息出现两个气泡。
   */
  const pendingMessageIds = new Set(
    pendingDm.map((p) => p.messageId).filter((id): id is string => Boolean(id)),
  );
  const renderMessages =
    pendingMessageIds.size > 0
      ? messages.filter((m) => !pendingMessageIds.has(m.message_id))
      : messages;

  return (
    <div class="flex h-[calc(100dvh-0px)] min-h-0 w-full flex-col bg-gradient-to-br from-zinc-100/90 via-slate-100/70 to-sky-50/40 dark:from-zinc-950 dark:to-zinc-950 md:h-full">
      <RtcCallOverlay />
      {(isDmLegacyIdentityPending() || error) && (
        <div class="mx-3 mt-3 space-y-2 md:mx-4">
          {isDmLegacyIdentityPending() && (
            <p
              class="rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-100"
              role="status"
            >
              {t('messagesLegacyIdentityWarning')}
            </p>
          )}
          {error && (
            <p
              class="rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-800 dark:border-rose-900 dark:bg-rose-950/40 dark:text-rose-200"
              role="alert"
            >
              {error}
            </p>
          )}
        </div>
      )}

      <div class="flex min-h-0 flex-1 bg-gradient-to-br from-zinc-100/90 via-slate-100/70 to-sky-50/50 px-4 py-3 dark:from-zinc-950 dark:via-zinc-950 dark:to-zinc-900 sm:px-6">
        <div class="flex min-h-0 w-full flex-1 overflow-hidden rounded-2xl border border-zinc-300/80 bg-white/95 shadow-xl shadow-zinc-900/5 ring-1 ring-white/60 dark:border-zinc-600 dark:bg-zinc-900 dark:shadow-black/40 dark:ring-zinc-800">
          {/* 左栏：好友列表 + 加好友（UX-MSG-LEFT-1：取消聊天/通讯录 Tab，类似微信） */}
          <div
            class={`min-h-0 w-full shrink-0 min-[960px]:w-[260px] min-[960px]:border-r min-[960px]:border-zinc-200 dark:min-[960px]:border-zinc-700 ${
              showChatOnMobile ? 'hidden min-[960px]:flex' : 'flex'
            }`}
          >
            <section class="flex h-full min-h-0 w-full flex-col overflow-hidden bg-gradient-to-b from-slate-50 to-white dark:from-zinc-900 dark:to-zinc-950">
              <div class="border-b border-zinc-200/80 px-3 py-3 dark:border-zinc-700">
                <div class="mb-2 flex items-baseline justify-between gap-2 px-1">
                  <h1 class="text-base font-bold text-zinc-950 dark:text-white">{t('navMessages')}</h1>
                </div>
                {/* UX-MSG-LEFT-1：加好友入口（左栏只有「好友」与「加好友」，其它按钮一律不要） */}
                <button
                  type="button"
                  class="relative flex w-full items-center justify-center gap-1.5 rounded-xl border border-zinc-200 bg-white px-3 py-2 text-sm font-semibold text-zinc-900 shadow-sm transition hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-50 dark:hover:bg-zinc-800"
                  onClick={() => setAddFriendOpen(true)}
                  data-testid="messages-add-friend"
                >
                  <UserPlus size={16} aria-hidden="true" />
                  {t('addFriend')}
                  {/* 入站待处理请求数（有多少人在等我回应） */}
                  {unreadFriendRequestCount.value > 0 && (
                    <span
                      class="absolute -right-1 -top-1 min-w-[1rem] rounded-full bg-rose-500 px-1 text-center text-[9px] font-bold leading-3.5 text-white"
                      data-testid="messages-contacts-unread-badge"
                      aria-label={t('friendPendingCount', undefined, {
                        count: unreadFriendRequestCount.value,
                      })}
                    >
                      {unreadFriendRequestCount.value > 99 ? '99+' : unreadFriendRequestCount.value}
                    </span>
                  )}
                </button>
              </div>

              <div class="min-h-0 flex-1 overflow-hidden">
                <Contacts
                  onOpenChat={openChatWith}
                  selectedHandle={activePeer}
                  conversations={conversations}
                  onConversationDeleted={(conversationId) => {
                    // 删掉当前打开的会话时回到左栏；随后刷新会话摘要（未读/预览）
                    if (selectedId === conversationId) {
                      setSelectedId(null);
                      setPeerHandle('');
                      setMobilePane('list');
                    }
                    void reloadConversations();
                  }}
                />
              </div>
            </section>
          </div>

          {/* 右侧聊天 */}
          <div
            class={`min-h-0 min-w-0 flex-1 ${
              showListOnMobile ? 'hidden min-[960px]:flex' : 'flex'
            }`}
          >
            {!chatReady ? (
              <section class="hidden h-full min-w-0 flex-1 flex-col overflow-hidden bg-gradient-to-b from-white to-zinc-50 dark:bg-zinc-900 min-[960px]:flex">
                <header class="border-b border-zinc-200/80 bg-white/90 px-4 py-3 backdrop-blur-sm dark:border-zinc-700 dark:bg-zinc-900/90">
                  <p class="text-sm font-medium text-zinc-700 dark:text-zinc-200">
                    {t('messagesSelectOrEnterHandle')}
                  </p>
                </header>
                <div class="flex flex-1 items-center justify-center bg-gradient-to-br from-[#e8f5ec] via-[#eef6f1] to-[#e4eef8] p-6 text-sm text-zinc-500 dark:from-zinc-900 dark:to-zinc-950 dark:text-zinc-400">
                  <p class="text-center">{t('messagesSelectOrEnterHandle')}</p>
                </div>
              </section>
            ) : (
              <section class="relative flex h-full min-w-0 flex-1 flex-col overflow-hidden bg-gradient-to-b from-white to-zinc-50 dark:bg-zinc-900">
                <header class="flex items-center gap-2 border-b border-zinc-200/80 bg-white/90 px-4 py-3 backdrop-blur-sm dark:border-zinc-700 dark:bg-zinc-900/90">
                  <button
                    type="button"
                    class="rounded-lg p-1 hover:bg-zinc-100 min-[960px]:hidden dark:hover:bg-zinc-800"
                    aria-label={t('messagesBackToList')}
                    onClick={() => setMobilePane('list')}
                  >
                    <ChevronLeft size={20} aria-hidden="true" />
                  </button>
                  <div class="min-w-0 flex-1">
                    <h2 class="truncate text-base font-semibold text-zinc-900 dark:text-zinc-50">
                      @{activePeer}
                    </h2>
                    {!selected && (
                      <p class="truncate text-xs text-zinc-500 dark:text-zinc-400">
                        {t('messagesNewChatReady')}
                      </p>
                    )}
                  </div>
                  {activePeer ? (
                    <button
                      type="button"
                      class="rounded-full p-2 text-emerald-700 hover:bg-emerald-50 disabled:opacity-40 dark:text-emerald-400 dark:hover:bg-emerald-950/40"
                      title={t('rtcStartCall')}
                      aria-label={t('rtcStartCall')}
                      disabled={recording}
                      onClick={() => void startVoiceCall()}
                    >
                      <Phone size={20} aria-hidden="true" />
                    </button>
                  ) : null}
                  {/* 删除会话收进聊天头部（左栏不再放大红按钮，保持微信式简洁） */}
                  {selectedId ? (
                    <button
                      type="button"
                      class="rounded-full p-2 text-rose-600 hover:bg-rose-50 dark:text-rose-400 dark:hover:bg-rose-950/40"
                      title={t('messagesDeleteConversation')}
                      aria-label={t('messagesDeleteConversation')}
                      onClick={() => setDeleteConfirmOpen(true)}
                      data-testid="messages-delete-conversation"
                    >
                      <Trash2 size={18} aria-hidden="true" />
                    </button>
                  ) : null}
                </header>

                <div
                  ref={chatScrollRef}
                  onScroll={handleDmChatScroll}
                  class="relative min-h-0 flex-1 space-y-2 overflow-y-auto bg-gradient-to-br from-[#e8f5ec] via-[#eef6f1] to-[#e4eef8] p-3 dark:from-zinc-900 dark:via-zinc-900/90 dark:to-zinc-950 md:p-4"
                >
                  {/* M-RT-3：顶部加载更早按钮 — 滚到顶时自动触发；显式按钮给键盘 / 触屏备用 */}
                  {selected && (hasMoreHistoryDm || loadingOlderDm) && (
                    <div class="flex justify-center pb-2">
                      <button
                        type="button"
                        class="rounded-full border border-zinc-300 bg-white/80 px-3 py-1 text-xs text-zinc-600 hover:bg-white disabled:cursor-not-allowed disabled:opacity-50 dark:border-zinc-600 dark:bg-zinc-900/70 dark:text-zinc-300 dark:hover:bg-zinc-900"
                        disabled={loadingOlderDm}
                        onClick={() => void loadOlderDmHistory()}
                      >
                        {loadingOlderDm ? t('messagesLoadingOlder') : t('messagesLoadOlder')}
                      </button>
                    </div>
                  )}
                  {!selected && pendingDm.length === 0 ? (
                    <div class="flex h-full min-h-[12rem] flex-col items-center justify-center gap-2 text-center">
                      {/* 中文注释：UX-AUDIT-7 — 空态图标/虚框提对比（zinc-300/600 → 400/500） */}
                      <MessageSquare size={36} class="text-zinc-400 dark:text-zinc-500" aria-hidden="true" />
                      <p class="rounded-xl border-2 border-dashed border-zinc-400/80 bg-white/80 px-4 py-3 text-sm text-zinc-500 dark:border-zinc-500/80 dark:bg-zinc-900 dark:text-zinc-400">
                        {t('messagesNewChatReady')}
                      </p>
                    </div>
                  ) : renderMessages.length === 0 && pendingDm.length === 0 ? (
                    <div class="flex h-full min-h-[12rem] flex-col items-center justify-center gap-2 text-center">
                      <MessageSquare size={36} class="text-zinc-400 dark:text-zinc-500" aria-hidden="true" />
                      <p class="rounded-xl border-2 border-dashed border-zinc-400/80 bg-white/80 px-4 py-3 text-sm text-zinc-500 dark:border-zinc-500/80 dark:bg-zinc-900 dark:text-zinc-400">
                        {t('messagesNoMessages')}
                      </p>
                    </div>
                  ) : (
                    <>
                      {renderMessages.map((m, index) => {
                        const mine = m.direction === 'outbox';
                        const handle = mine ? meDisplay : activePeer;
                        const prev = index > 0 ? renderMessages[index - 1] : null;
                        const prevSame =
                          prev != null &&
                          (prev.direction === 'outbox') === mine;
                        const showAvatar = !prevSame;
                        const hue = senderHue(handle);

                        if (mine) {
                          return (
                            <div
                              key={m.message_id}
                            class={`flex items-end justify-end gap-2 ${showAvatar ? 'mt-1' : ''}`}
                          >
                            <div class="hailuo-chat-bubble hailuo-chat-bubble-out">
                              {m.media?.map((item) => (
                                <DmMediaBubble
                                  key={item.media_id}
                                  item={item}
                                  imageAlt={t('messagesImageAlt')}
                                  voiceAlt={t('messagesVoiceAlt')}
                                />
                              ))}
                              {m.plaintext && (
                                <p class="whitespace-pre-wrap break-words">{m.plaintext}</p>
                              )}
                              <p class="mt-1 text-right text-[10px] text-sky-100">
                                {formatRelativeTime(m.created_at)}
                              </p>
                            </div>
                            <SenderAvatar handle={handle} hue={hue} visible={showAvatar} />
                          </div>
                        );
                      }

                      return (
                        <div
                          key={m.message_id}
                          class={`flex items-end gap-2 ${showAvatar ? 'mt-1' : ''}`}
                        >
                          <SenderAvatar handle={handle} hue={hue} visible={showAvatar} />
                          <div class="hailuo-chat-bubble hailuo-chat-bubble-in">
                            {m.media?.map((item) => (
                              <DmMediaBubble
                                key={item.media_id}
                                item={item}
                                imageAlt={t('messagesImageAlt')}
                                voiceAlt={t('messagesVoiceAlt')}
                              />
                            ))}
                            {m.plaintext && (
                              <p class="whitespace-pre-wrap break-words">{m.plaintext}</p>
                            )}
                            <p class="mt-1 text-right text-[10px] text-zinc-500 dark:text-zinc-400">
                              {formatRelativeTime(m.created_at)}
                            </p>
                          </div>
                        </div>
                      );
                      })}
                      {/* M-RT-3：pendingDm 临时占位（发送中灰显 / 失败红角 + 重试按钮） */}
                      {pendingDm.map((p) => (
                        <div
                          key={p.tempId}
                          class={`mt-1 flex items-end justify-end gap-2 ${
                            p.status === 'failed' ? 'opacity-100' : 'opacity-70'
                          }`}
                        >
                          <div
                            class={`hailuo-chat-bubble rounded-br-md border ${
                              p.status === 'failed'
                                ? 'border-rose-400 bg-rose-50 text-rose-900 dark:border-rose-700 dark:bg-rose-950/50 dark:text-rose-100'
                                : 'border-sky-300 bg-sky-100 text-sky-900 dark:border-sky-700 dark:bg-sky-950/40 dark:text-sky-100'
                            }`}
                          >
                            {p.imagePreviewUrl && (
                              <img
                                src={p.imagePreviewUrl}
                                alt={t('messagesImagePendingAlt')}
                                class="mb-2 max-h-64 rounded-lg object-contain"
                              />
                            )}
                            {p.voicePreviewUrl && (
                              <div class="mb-2">
                                <audio
                                  controls
                                  preload="metadata"
                                  src={p.voicePreviewUrl}
                                  class="w-full max-w-xs"
                                  aria-label={t('messagesVoicePendingAlt')}
                                />
                                <p class="mt-0.5 text-[10px] opacity-80">
                                  {formatVoiceDuration(p.voiceDurationMs ?? undefined)}
                                </p>
                              </div>
                            )}
                            {p.plaintext && (
                              <p class="whitespace-pre-wrap break-words">{p.plaintext}</p>
                            )}
                            <p
                              class={`mt-1 inline-flex items-center justify-end gap-1 text-right text-[10px] ${
                                p.status === 'failed'
                                  ? 'text-rose-700 dark:text-rose-300'
                                  : 'text-sky-700 dark:text-sky-300'
                              }`}
                            >
                              {p.status === 'failed' ? (
                                <AlertCircle size={10} aria-hidden="true" />
                              ) : (
                                <Loader2 size={10} class="animate-spin" aria-hidden="true" />
                              )}
                              <span>
                                {p.status === 'failed'
                                  ? t('messagesRetryFailed')
                                  : t('messagesSendingInChat')}
                              </span>
                            </p>
                            {p.status === 'failed' && (
                              <button
                                type="button"
                                class="mt-1 inline-flex items-center gap-1 rounded-full bg-rose-600 px-2.5 py-1 text-[11px] font-semibold text-white hover:bg-rose-700"
                                aria-label={t('messagesRetryAria')}
                                onClick={() => void handleRetryDmPending(p.tempId)}
                              >
                                {t('messagesRetry')}
                              </button>
                            )}
                          </div>
                          <SenderAvatar handle={meDisplay} hue={meHue} visible={true} />
                        </div>
                      ))}
                      <div ref={chatEndRef} aria-hidden="true" />
                    </>
                  )}
                </div>

                {/* M-RT-3：用户不在底部时显示"新消息"浮钮（点击滚到底） */}
                {!atBottomRef.current && newDmCount > 0 && (
                  <button
                    type="button"
                    class="absolute bottom-32 left-1/2 z-10 -translate-x-1/2 rounded-full bg-gradient-to-br from-sky-500 to-sky-600 px-3 py-1.5 text-xs font-semibold text-white shadow-md shadow-sky-500/30 hover:from-sky-600 hover:to-sky-700"
                    onClick={() => scrollDmToBottom(true)}
                  >
                    {t('messagesNewCount', undefined, { count: newDmCount })} ↓
                  </button>
                )}

                {pendingPreviewUrl && (pendingImage || pendingVoice) && (
                  <div
                    class="mb-1.5 border-t border-zinc-200 bg-white px-3 pt-3 pb-2 dark:border-zinc-700 dark:bg-zinc-900"
                    data-ux-audit="11-preview-gap"
                  >
                    <div class="relative inline-block max-w-full">
                      {pendingImage ? (
                        <img
                          src={pendingPreviewUrl}
                          alt={t('messagesImagePendingAlt')}
                          class="max-h-32 rounded-lg border border-zinc-200 dark:border-zinc-700"
                        />
                      ) : (
                        <div class="flex items-center gap-3 rounded-lg border border-zinc-200 px-3 py-2 dark:border-zinc-700">
                          <audio
                            controls
                            preload="metadata"
                            src={pendingPreviewUrl}
                            class="max-w-xs"
                            aria-label={t('messagesVoicePendingAlt')}
                          />
                          <span class="text-xs text-zinc-500">
                            {formatVoiceDuration(pendingVoiceDurationMs ?? undefined)}
                          </span>
                        </div>
                      )}
                      <button
                        type="button"
                        class="absolute -right-2 -top-2 rounded-full bg-zinc-800 px-2 py-0.5 text-xs text-white"
                        onClick={() => clearPendingMedia()}
                        aria-label={pendingVoice ? t('messagesRemoveVoice') : t('messagesRemoveImage')}
                      >
                        ×
                      </button>
                    </div>
                  </div>
                )}

                <div class="hailuo-chat-composer dark:to-zinc-900">
                  <div class="flex items-end gap-2">
                    <input
                      ref={imageInputRef}
                      type="file"
                      accept="image/*"
                      class="hidden"
                      disabled={recording}
                      onChange={(e) => {
                        const file = (e.target as HTMLInputElement).files?.[0] ?? null;
                        handlePickImage(file);
                        (e.target as HTMLInputElement).value = '';
                      }}
                    />
                    <button
                      type="button"
                      class="mb-0.5 rounded-full p-2 text-zinc-600 hover:bg-zinc-200 disabled:opacity-40 dark:text-zinc-300 dark:hover:bg-zinc-800"
                      disabled={recording}
                      title={t('messagesAttachImage')}
                      aria-label={t('messagesAttachImage')}
                      onClick={() => imageInputRef.current?.click()}
                    >
                      <Paperclip size={20} aria-hidden="true" />
                    </button>
                    <button
                      type="button"
                      class={`mb-0.5 rounded-full p-2 disabled:opacity-40 ${
                        recording
                          ? 'bg-rose-600 text-white hover:bg-rose-500'
                          : 'text-zinc-600 hover:bg-zinc-200 dark:text-zinc-300 dark:hover:bg-zinc-800'
                      }`}
                      title={recording ? t('messagesStopRecording') : t('messagesRecordVoice')}
                      aria-label={recording ? t('messagesStopRecording') : t('messagesRecordVoice')}
                      aria-pressed={recording}
                      onClick={() => toggleVoiceRecording()}
                    >
                      {recording ? (
                        <Square size={18} aria-hidden="true" />
                      ) : (
                        <Mic size={20} aria-hidden="true" />
                      )}
                    </button>
                    <span
                      class="mb-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-xs font-bold text-white"
                      style={{ backgroundColor: `hsl(${meHue}, 55%, 48%)` }}
                      aria-hidden="true"
                      title={`@${meDisplay}`}
                    >
                      {senderLetter(meDisplay)}
                    </span>
                    {/* UX-MOBILE-FEED-CHAT-1：与记录/群聊同构 — 边框在 textarea，focus 环贴边 */}
                    <textarea
                      class="hailuo-focus-field max-h-28 min-h-[2.75rem] flex-1 resize-none rounded-2xl border border-zinc-200 bg-white px-3 py-2 text-sm leading-5 text-zinc-900 outline-none placeholder:text-zinc-400 disabled:cursor-not-allowed disabled:opacity-50 dark:border-zinc-600 dark:bg-zinc-900 dark:text-zinc-100 dark:placeholder:text-zinc-500"
                      placeholder={t('messagesComposePlaceholder')}
                      rows={1}
                      value={compose}
                      onInput={(e) => {
                        const el = e.target as HTMLTextAreaElement;
                        setCompose(el.value);
                        el.style.height = 'auto';
                        el.style.height = `${Math.min(el.scrollHeight, 112)}px`;
                      }}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && !e.shiftKey) {
                          e.preventDefault();
                          if (canSend) void handleSend();
                        }
                      }}
                    />
                    <button
                      type="button"
                      class="mb-0.5 rounded-full bg-gradient-to-br from-sky-500 to-sky-600 px-4 py-2 text-sm font-semibold text-white shadow-md shadow-sky-500/30 hover:from-sky-600 hover:to-sky-700 disabled:cursor-not-allowed disabled:opacity-50"
                      disabled={!canSend || !peerHandle.trim()}
                      onClick={() => void handleSend()}
                    >
                      {t('messagesSend')}
                    </button>
                  </div>
                </div>
              </section>
            )}
          </div>
        </div>
      </div>

      {/* UX-MSG-LEFT-1：左栏「加好友」→ 输入 handle 或粘贴加好友链接 */}
      <AddFriendDialog
        open={addFriendOpen}
        onClose={() => setAddFriendOpen(false)}
      />

      <ConfirmDialog
        open={deleteConfirmOpen}
        pending={deletingConversation}
        title={t('messagesDeleteDialogTitle')}
        body={<p>{t('messagesDeleteConfirm')}</p>}
        cancelLabel={t('messagesDeleteDialogCancel')}
        confirmLabel={t('messagesDeleteDialogConfirm')}
        confirmPendingLabel={t('messagesDeleteDialogPending')}
        icon={<Trash2 size={20} strokeWidth={2} aria-hidden="true" />}
        confirmClassName="rounded-full bg-rose-600 px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-rose-700 disabled:cursor-wait disabled:opacity-70 dark:bg-rose-500 dark:hover:bg-rose-400"
        onCancel={() => {
          if (!deletingConversation) setDeleteConfirmOpen(false);
        }}
        onConfirm={() => void confirmDeleteConversation()}
      />
    </div>
  );
}
