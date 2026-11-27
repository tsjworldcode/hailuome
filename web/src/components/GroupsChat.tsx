/** @jsxImportSource preact */
import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { LogOut, Trash2 } from 'lucide-preact';
import { ConfirmDialog } from './ConfirmDialog';
import { GroupModal } from './GroupActionsPanel';
import { GroupChatPanel } from './GroupChatPanel';
import { GroupListPanel, type GroupListItemPreview } from './GroupListPanel';
import { getDmKekMaterial } from '../lib/dmSession';
import { ApiError } from '../lib/errors';
import {
  formatGroupShareLink,
  parseGroupInviteInput,
  parseGroupShareInput,
} from '../lib/groupInviteParse';
import { listGroupPlaintexts } from '../lib/groupLocalDb';
import {
  GROUP_NICKNAME_MAX,
  collectMemberNicknames,
  readGroupNickname,
  writeGroupNickname,
} from '../lib/groupNickname';
import {
  batchWrapNextEpochKeys,
  commitGroupEpochRekey,
  ownerServerRekey,
  shouldFallbackBrowserRekeyWrap,
  createGroupWithKeys,
  dissolveGroup,
  hydrateAllGroupKeys,
  hydrateGroupKeys,
  joinGroupById,
  joinGroupByInvite,
  leaveGroup,
  listDecryptedPlaintexts,
  listGroups,
  loadOlderGroupPlaintexts,
  pollAndDecryptGroupMessages,
  registerGroupMemberDhPubkey,
  sendGroupMessage,
  fetchMessagingDbCapacity,
  updateGroupLocalSettings,
  updateGroupName,
  updateGroupAnnouncement,
  setGroupAdmin,
  kickGroupMember,
  listGroupMembers,
  type GroupPlaintextRecord,
} from '../lib/groupService';
import type { GroupPendingOutbox, SendGroupInputLike } from './GroupChatPanel';
import { QRCodeBadge } from './QRCodeBadge';
import { QrScannerPanel } from './QrScannerPanel';
import { revokeGroupMediaObjectUrls } from '../lib/messagingMediaClient';
import { isQuotaExceeded } from '../lib/idbErrors';
import { initLanguage, t } from '../lib/i18n';
import { resolvePublicWorkerBBaseUrlSync } from '../lib/deployEnv';
import {
  createWorkerAClient,
  type GroupJoinPolicy,
  type GroupMemberItem,
  type LocalGroupItem,
  type MessagingDbCapacityResponse,
} from '../lib/workerA';
import { ownerBaseUrl, ownerCredentialsReady, ownerJwt, useOwnerCredentials } from '../lib/useOwnerCredentials';
import { subscribeMessagingEvents } from '../lib/messagingEventsClient';

function resolveJoinPolicy(g: LocalGroupItem): GroupJoinPolicy {
  if (g.join_policy === 'closed' || g.join_policy === 'approval' || g.join_policy === 'open') {
    return g.join_policy;
  }
  if (g.join_requires_approval === 1 || g.join_requires_approval === true) return 'approval';
  return 'open';
}

function isTruthyFlag(v: number | boolean | null | undefined): boolean {
  return v === true || v === 1;
}

/** GRP-MEMBER-PAGE-1：群成员侧栏每页条数；大群按需追加，避免一次渲染上千行。 */
const HEADER_MEMBER_PAGE_SIZE = 100;
/** GRP-MEMBER-PAGE-1：设置页成员列表一次最多渲染多少行（全量仍保留给换钥 / 补封逻辑用）。 */
const SETTINGS_MEMBER_RENDER_CAP = 300;

/**
 * M-RT-3-HISTORY-FIX：把新解出的消息并入现有列表，而不是整表替换。
 *
 * 轮询每次只取最新一页（50 条）；若直接 `setMessages(rows)`，
 * 用户刚「加载更早」翻出来的历史会在下一轮（1s）被整表抹掉 ——
 * 表现就是「按钮点了、历史闪一下又回到最新几条」。
 *
 * 同一 message_id 以新记录为准（媒体签名 URL 可能刷新），按 created_at 升序。
 */
function mergeGroupRecords(
  prev: readonly GroupPlaintextRecord[],
  incoming: readonly GroupPlaintextRecord[],
): readonly GroupPlaintextRecord[] {
  if (incoming.length === 0) return prev;
  const map = new Map(prev.map((m) => [m.message_id, m]));
  for (const item of incoming) map.set(item.message_id, item);
  return [...map.values()].sort((a, b) => a.created_at.localeCompare(b.created_at));
}

function isGroupOwner(g: LocalGroupItem): boolean {
  return g.role === 'owner';
}

function isGroupModerator(g: LocalGroupItem): boolean {
  return isGroupOwner(g) || isTruthyFlag(g.is_admin);
}

/** M-RT-0a / M-RT-1：无 SSE 时 1s；SSE 在线 15s 兜底。 */
const POLL_MS = 1_000;
const POLL_MS_WITH_SSE = 15_000;
const MAX_GROUP_IMAGE_BYTES = 10 * 1024 * 1024;

type MobilePane = 'list' | 'chat';
/** UX-GROUPS-8：群设置分区（避免一个超长滚动面板） */
type GroupSettingsTab = 'info' | 'notice' | 'members' | 'privacy';

async function buildGroupPreviews(
  groups: readonly LocalGroupItem[],
): Promise<Record<string, GroupListItemPreview>> {
  // 各群本地预览并行读 IDB，避免群多时串行拖慢首屏壳
  const entries = await Promise.all(
    groups.map(async (g) => {
      const rows = await listGroupPlaintexts(g.group_id);
      if (rows.length === 0) {
        return [g.group_id, { preview: null, lastAt: null }] as const;
      }
      const latest = rows.reduce((a, b) => (a.created_at >= b.created_at ? a : b));
      return [
        g.group_id,
        {
          preview: latest.plaintext.slice(0, 80),
          lastAt: latest.created_at,
        },
      ] as const;
    }),
  );
  return Object.fromEntries(entries);
}

export function GroupsChat() {
  const [groups, setGroups] = useState<readonly LocalGroupItem[]>([]);
  const [selectedGroupId, setSelectedGroupId] = useState<string | null>(null);
  const [messages, setMessages] = useState<readonly GroupPlaintextRecord[]>([]);
  const [previews, setPreviews] = useState<Record<string, GroupListItemPreview>>({});
  const [compose, setCompose] = useState('');
  const [pendingImage, setPendingImage] = useState<File | null>(null);
  const [pendingPreviewUrl, setPendingPreviewUrl] = useState<string | null>(null);
  const [canSendGroupMedia, setCanSendGroupMedia] = useState(true);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [meHandle, setMeHandle] = useState('');
  const [meWorkerB, setMeWorkerB] = useState('');
  const [mobilePane, setMobilePane] = useState<MobilePane>('list');

  const [createOpen, setCreateOpen] = useState(false);
  const [createName, setCreateName] = useState('');
  const [createAnnouncement, setCreateAnnouncement] = useState('');
  const [creating, setCreating] = useState(false);

  const [joinOpen, setJoinOpen] = useState(false);
  const [joinPaste, setJoinPaste] = useState('');
  const [joining, setJoining] = useState(false);

  const [inviteOpen, setInviteOpen] = useState(false);
  const [inviteText, setInviteText] = useState('');
  const [sharePolicy, setSharePolicy] = useState<GroupJoinPolicy>('approval');
  const [sharePolicySaving, setSharePolicySaving] = useState(false);
  const [joinRequests, setJoinRequests] = useState<
    readonly { member_worker_b_url: string; member_handle: string; joined_at: string }[]
  >([]);
  const [joinRequestsLoading, setJoinRequestsLoading] = useState(false);
  /**
   * REL-FIX-6：跨节点管理员标记。
   * 管理员本机 `group_members.is_admin` 恒为 0（任命只写群主库，sync 不传播该标记），
   * 故前端不能只看本地 is_admin 决定是否渲染审批区；
   * 改为「本机 is_admin=1」或「向群主探测成功（列表端点返回 200）」都算 moderator。
   */
  const [remoteAdminVerified, setRemoteAdminVerified] = useState(false);
  const [groupMembers, setGroupMembers] = useState<readonly GroupMemberItem[]>([]);
  const [headerMembers, setHeaderMembers] = useState<readonly GroupMemberItem[]>([]);
  /** GRP-MEMBER-PAGE-1：侧栏成员分页状态（total 来自服务端 COUNT，members 只是已加载页）。 */
  const [headerMembersTotal, setHeaderMembersTotal] = useState(0);
  const [headerMembersHasMore, setHeaderMembersHasMore] = useState(false);
  const [headerMembersLoadingMore, setHeaderMembersLoadingMore] = useState(false);
  /** GRP-MEMBER-PAGE-1：设置页成员搜索（先按昵称/handle 过滤，再限制渲染行数）。 */
  const [settingsMemberFilter, setSettingsMemberFilter] = useState('');
  const [groupMembersLoading, setGroupMembersLoading] = useState(false);
  const [muteSaving, setMuteSaving] = useState(false);
  const [adminSavingUrl, setAdminSavingUrl] = useState<string | null>(null);
  /**
   * REL-FIX-9：入群审批「同意 / 拒绝」防重复提交。
   * 旧实现没有 pending 态，管理员快速双击「同意」会发出两次请求：
   * 第一次把群主侧 status 从 pending 改成 active，第二次命中
   * `row.status !== 'pending'` → 404 GROUP_NOT_FOUND → 前端弹红条报错，
   * 但**第一次其实已经成功**（误导性失败反馈 + 无谓重复写库）。
   *
   * 修法：`processingMemberUrl` 记录「正在处理」的成员 URL；
   * - `processingMemberUrlRef` 是**同步**闸门（state 更新要到下一次渲染才生效，
   *   同一 tick 内的双击会绕过纯 state 判断），命中即直接 return，不再发请求；
   * - 渲染层用 `processingMemberUrl` 给对应行的两个按钮加 disabled + 「处理中…」提示。
   */
  const [processingMemberUrl, setProcessingMemberUrl] = useState<string | null>(null);
  const processingMemberUrlRef = useRef<string | null>(null);

  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsTab, setSettingsTab] = useState<GroupSettingsTab>('info');
  /**
   * REL-FIX-5：深链定位待审批段。
   * 通知（`group_join_request_received`）跳 `/groups?group=<id>&pending=1` →
   * 选中该群 + 打开群设置 + 高亮「入群申请」段。
   */
  const [pendingFocus, setPendingFocus] = useState(false);
  /**
   * REL-FIX-5：待审批段高亮（深链进入时短暂高亮，让群主一眼看到「入群申请」在哪）。
   * 待审批列表加载完成后自动取消（否则一直红框 = 噪音）。
   */
  const [pendingHighlight, setPendingHighlight] = useState(false);
  const [settingsRetention, setSettingsRetention] = useState('90');
  const [savingSettings, setSavingSettings] = useState(false);
  // UX-GROUPS-7b：群名称编辑（仅群主可改）
  const [settingsName, setSettingsName] = useState('');
  const [originalName, setOriginalName] = useState('');
  const [savingName, setSavingName] = useState(false);
  // UX-GROUPS-7c：公告编辑（群主+管理员可改）
  const [settingsAnnouncement, setSettingsAnnouncement] = useState('');
  const [originalAnnouncement, setOriginalAnnouncement] = useState('');
  const [savingAnnouncement, setSavingAnnouncement] = useState(false);
  /** GRP-NICKNAME-1：本群昵称（只存本机；随消息密文下发给成员，不写节点资料）。 */
  const [settingsNickname, setSettingsNickname] = useState('');
  const [nicknameSaved, setNicknameSaved] = useState(false);
  /** EPOCH-UX-1：管理员密封进度（上传中） */
  const [rekeyBusy, setRekeyBusy] = useState(false);
  const [rekeyProgress, setRekeyProgress] = useState<{ ready: number; total: number } | null>(null);
  /** OWNER-KEY-4：设置页「立即补封」 */
  const [sealPendingBusy, setSealPendingBusy] = useState(false);
  const [messagingCapacity, setMessagingCapacity] = useState<MessagingDbCapacityResponse | null>(null);
  const [loadingCapacity, setLoadingCapacity] = useState(false);
  const [dissolving, setDissolving] = useState(false);
  /** UX-CONFIRM：leave | dissolve */
  const [groupConfirmKind, setGroupConfirmKind] = useState<'leave' | 'dissolve' | null>(null);
  const [leaving, setLeaving] = useState(false);
  /** M-RT-3：群聊发送中 / 失败占位（不入 IDB）。 */
  const [pendingGm, setPendingGm] = useState<readonly GroupPendingOutbox[]>([]);
  /** M-RT-3：分页游标（指向当前已显示消息中最早一条之前；null = 还没翻过头）。 */
  const [olderCursorGm, setOlderCursorGm] = useState<string | null>(null);
  const [hasMoreHistoryGm, setHasMoreHistoryGm] = useState(true);
  const [loadingOlderGm, setLoadingOlderGm] = useState(false);

  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const selectedGroupIdRef = useRef<string | null>(null);
  const groupsRef = useRef<readonly LocalGroupItem[]>([]);
  const sseLiveRef = useRef(false);
  selectedGroupIdRef.current = selectedGroupId;
  groupsRef.current = groups;

  useEffect(() => {
    initLanguage();
  }, []);

  const selectedGroup = useMemo(
    () => groups.find((g) => g.group_id === selectedGroupId) ?? null,
    [groups, selectedGroupId],
  );

  /**
   * REL-FIX-5：处理深链 `/groups?group=<group_id>&pending=1`。
   * 场景：群主在通知中心看到「XX 申请加入群」→ 点「查看」→ 直达该群的群设置「入群申请」段。
   *
   * 实现要点：
   * - 依赖 `groups`（已加载的群列表）而不是 `selectedGroup`：`selectedGroupId` 初始为 null，
   *   若等 `selectedGroup` 命中目标群，则会死锁（没人先选中它）→ 深链永远不生效。
   * - 用 ref 记录「已消费的深链目标」，避免轮询 reload 反复触发 openSettingsModal；
   * - 群不在本节点（不是成员 / 群 id 非法）→ 静默忽略，不报错打扰用户。
   */
  const deepLinkTargetRef = useRef<string | null>(null);
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const params = new URLSearchParams(window.location.search);
    const targetGroupId = (params.get('group') ?? '').trim();
    const wantPending = params.get('pending') === '1';
    if (!targetGroupId) return;
    // 同一直链目标只消费一次（reload / 轮询不重复开弹窗）
    if (deepLinkTargetRef.current === targetGroupId) return;
    // 群列表还没加载完 → 等下一轮（groups 变化会重新触发本 effect）
    if (groups.length === 0) return;
    // 群不在本节点 → 静默忽略（标记已消费，避免每次轮询重复尝试）
    deepLinkTargetRef.current = targetGroupId;
    const target = groups.find((g) => g.group_id === targetGroupId);
    if (!target) return;
    selectGroup(targetGroupId);
    if (wantPending) setPendingFocus(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [groups]);

  /**
   * REL-FIX-5：深链目标就位后打开群设置弹窗（待审批段高亮）。
   * 与深链 effect 分两步：先选中群（等 groups 加载完），再开弹窗。
   */
  useEffect(() => {
    if (!pendingFocus) return;
    if (!selectedGroup) return;
    setPendingFocus(false);
    openSettingsModal({ highlightPending: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingFocus, selectedGroup]);

  useEffect(() => {
    const groupId = selectedGroupId;
    if (!groupId) {
      setHeaderMembers([]);
      setHeaderMembersTotal(0);
      setHeaderMembersHasMore(false);
      return;
    }
    const baseUrl = ownerBaseUrl.value;
    const jwt = ownerJwt.value;
    if (!baseUrl || !jwt) return;
    let cancelled = false;
    const client = createWorkerAClient({ baseUrl, getJwt: () => jwt });
    setHeaderMembersLoadingMore(false);
    // GRP-MEMBER-PAGE-1：只取第一页 + 不拿 DH 公钥；2000 人群不再一次拉全量
    void listGroupMembers(client, groupId, {
      limit: HEADER_MEMBER_PAGE_SIZE,
      includeDh: false,
    })
      .then((data) => {
        if (cancelled) return;
        setHeaderMembers(data.items);
        setHeaderMembersTotal(typeof data.total === 'number' ? data.total : data.items.length);
        setHeaderMembersHasMore(data.has_more === true);
      })
      .catch(() => {
        if (cancelled) return;
        setHeaderMembers([]);
        setHeaderMembersTotal(0);
        setHeaderMembersHasMore(false);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedGroupId]);

  /** GRP-MEMBER-PAGE-1：侧栏「加载更多成员」— 按 offset 追加一页，成功后再翻 has_more。 */
  async function loadMoreHeaderMembers(): Promise<void> {
    const groupId = selectedGroupIdRef.current;
    const baseUrl = ownerBaseUrl.value;
    const jwt = ownerJwt.value;
    if (!groupId || !baseUrl || !jwt) return;
    if (headerMembersLoadingMore || !headerMembersHasMore) return;
    setHeaderMembersLoadingMore(true);
    try {
      const client = createWorkerAClient({ baseUrl, getJwt: () => jwt });
      const page = await listGroupMembers(client, groupId, {
        limit: HEADER_MEMBER_PAGE_SIZE,
        offset: headerMembers.length,
        includeDh: false,
      });
      if (selectedGroupIdRef.current !== groupId) return;
      setHeaderMembers((prev) => {
        const seen = new Set(prev.map((m) => m.member_worker_b_url));
        const merged = [...prev];
        for (const m of page.items) {
          if (!seen.has(m.member_worker_b_url)) merged.push(m);
        }
        return merged;
      });
      if (typeof page.total === 'number') setHeaderMembersTotal(page.total);
      setHeaderMembersHasMore(page.has_more === true);
    } catch {
      // 追加失败静默：第一页照常可看，重新进群会重置分页
    } finally {
      setHeaderMembersLoadingMore(false);
    }
  }

  /**
   * GRP-MEMBER-PAGE-1：设置页 / 管理操作已拿到全量名单时，顺手同步侧栏第一页，
   * 省一次「全量 + 分页」的重复请求（仅当操作的就是当前选中群）。
   */
  function syncHeaderMembersFromFull(
    groupId: string,
    all: readonly GroupMemberItem[],
  ): void {
    if (selectedGroupIdRef.current !== groupId) return;
    setHeaderMembers(all.slice(0, HEADER_MEMBER_PAGE_SIZE));
    setHeaderMembersTotal(all.length);
    setHeaderMembersHasMore(all.length > HEADER_MEMBER_PAGE_SIZE);
  }

  const reloadGroups = useCallback(async (client: ReturnType<typeof createWorkerAClient>) => {
    const items = await listGroups(client);
    setGroups(items);
    setPreviews(await buildGroupPreviews(items));
    return items;
  }, []);

  // SEC-AUDIT-2026-10-15：打开任意群即登记本机 DH（不再仅限 rekey_scheduled），减少离线拖死换钥。
  useEffect(() => {
    if (!selectedGroup) return;
    const baseUrl = ownerBaseUrl.value;
    const jwt = ownerJwt.value;
    const kek = getDmKekMaterial();
    if (!baseUrl || !jwt || !kek) return;
    let cancelled = false;
    const client = createWorkerAClient({ baseUrl, getJwt: () => jwt });
    void registerGroupMemberDhPubkey(client, kek, selectedGroup.group_id)
      .then(async () => {
        if (cancelled) return;
        if (isGroupModerator(selectedGroup) && isTruthyFlag(selectedGroup.rekey_scheduled)) {
          await reloadGroups(client);
        }
      })
      .catch(() => {
        // 非成员 / 保险箱未开：忽略，不挡聊天
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedGroup?.group_id, reloadGroups]);

  // EPOCH-UX-2：打开 pending_key / 轮换中群时主动 Fast-Pull，成功后刷新列表翻横幅
  useEffect(() => {
    if (!selectedGroup) return;
    if (
      selectedGroup.key_state !== 'pending_key' &&
      selectedGroup.key_state !== 'epoch_rotation_pending'
    ) {
      return;
    }
    const baseUrl = ownerBaseUrl.value;
    const jwt = ownerJwt.value;
    const kek = getDmKekMaterial();
    if (!baseUrl || !jwt || !kek) return;
    let cancelled = false;
    const client = createWorkerAClient({ baseUrl, getJwt: () => jwt });
    void hydrateGroupKeys(client, kek, selectedGroup.group_id, selectedGroup.epoch)
      .then(async () => {
        if (cancelled) return;
        await reloadGroups(client);
      })
      .catch(() => {
        // 密钥尚未分发：保持横幅
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedGroup?.group_id, selectedGroup?.key_state, selectedGroup?.epoch, reloadGroups]);

  const refreshMessages = useCallback(
    async (groupId: string, passwordHash: string, client: ReturnType<typeof createWorkerAClient>) => {
      const g = groupsRef.current.find((x) => x.group_id === groupId);
      const ownerUrl = g?.owner_worker_b_url ?? meWorkerB;
      const rows = await pollAndDecryptGroupMessages(client, groupId, passwordHash, ownerUrl, meWorkerB);
      if (selectedGroupIdRef.current === groupId) {
        // M-RT-3-HISTORY-FIX：轮询只返回最新一页，合并而非替换，保住已翻出的更早历史
        setMessages((prev) => mergeGroupRecords(prev, rows));
      }
      return rows;
    },
    [meWorkerB],
  );

  const pollCurrentGroup = useCallback(async () => {
    const groupId = selectedGroupIdRef.current;
    const baseUrl = ownerBaseUrl.value;
    const jwt = ownerJwt.value;
    const kek = getDmKekMaterial();
    if (!groupId || !baseUrl || !jwt || !kek) return;
    const client = createWorkerAClient({ baseUrl, getJwt: () => jwt });
    try {
      await refreshMessages(groupId, kek, client);
      await reloadGroups(client);
    } catch {
      // 轮询静默
    }
  }, [refreshMessages, reloadGroups]);

  const startPollInterval = useCallback(() => {
    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = null;
    if (document.visibilityState !== 'visible' || !selectedGroupIdRef.current) return;
    const ms = sseLiveRef.current ? POLL_MS_WITH_SSE : POLL_MS;
    pollRef.current = setInterval(() => void pollCurrentGroup(), ms);
  }, [pollCurrentGroup]);

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
      try {
        // UX-MSG-PERF：群列表不依赖 getMe；先出壳再并行拉身份/密钥/云能力
        const items = await reloadGroups(client);
        setLoading(false);
        const kek = getDmKekMaterial()!;
        void hydrateAllGroupKeys(client, kek, items);
        void client
          .getMessagingCloudCapability()
          .then((cap) => setCanSendGroupMedia(cap.can_send_group_media))
          .catch(() => setCanSendGroupMedia(false));
        void client
          .getMe()
          .then((me) => {
            setMeHandle(me.handle);
            setMeWorkerB(me.worker_b_url ?? resolvePublicWorkerBBaseUrlSync());
          })
          .catch((err) => {
            setError(err instanceof ApiError ? err.displayMessage : t('groupsLoadFailed'));
          });
      } catch (err) {
        setError(err instanceof ApiError ? err.displayMessage : t('groupsLoadFailed'));
        setLoading(false);
      }
    })();
  });

  useEffect(() => {
    if (!selectedGroupId) {
      setMessages([]);
      // M-RT-3：切回列表时清掉全部 pending / 分页状态
      setPendingGm([]);
      setOlderCursorGm(null);
      setHasMoreHistoryGm(true);
      return;
    }
    // 换群时只保留本群 pending，避免旧群「发送失败」气泡串到新群（刷新会消失、不刷新会误导）
    setPendingGm((prev) => prev.filter((p) => p.groupId === selectedGroupId));
    setOlderCursorGm(null);
    setHasMoreHistoryGm(true);
    void loadInitialGmHistory(selectedGroupId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedGroupId]);

  useEffect(() => {
    const onVis = () => {
      if (document.visibilityState === 'hidden') {
        if (pollRef.current) clearInterval(pollRef.current);
        pollRef.current = null;
      } else if (selectedGroupIdRef.current) {
        void pollCurrentGroup();
        startPollInterval();
      }
    };
    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = null;
    if (selectedGroupId && document.visibilityState === 'visible') {
      void pollCurrentGroup();
      startPollInterval();
    }
    document.addEventListener('visibilitychange', onVis);
    return () => {
      document.removeEventListener('visibilitychange', onVis);
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [selectedGroupId, pollCurrentGroup, startPollInterval]);

  // M-RT-1：群会话页订 SSE；NEW(group) 立刻 poll
  useEffect(() => {
    let sub: ReturnType<typeof subscribeMessagingEvents> | null = null;
    const start = () => {
      sub?.stop();
      sub = null;
      const baseUrl = ownerBaseUrl.value;
      if (!baseUrl || !selectedGroupIdRef.current || document.visibilityState !== 'visible') return;
      sub = subscribeMessagingEvents({
        baseUrl,
        getJwt: () => ownerJwt.value,
        onStatus: (live) => {
          sseLiveRef.current = live;
          startPollInterval();
        },
        onEvent: (ev) => {
          if (ev.type === 'NEW' && ev.scope === 'group') {
            void pollCurrentGroup();
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
  }, [selectedGroupId, pollCurrentGroup, startPollInterval]);

  function selectGroup(groupId: string): void {
    setSelectedGroupId(groupId);
    setMobilePane('chat');
    setCompose('');
    setError(null);
    // 同步清掉非本群 pending，避免 useEffect 前一帧仍渲染旧失败气泡
    setPendingGm((prev) => prev.filter((p) => p.groupId === groupId));
  }

  async function handleCreateGroup(): Promise<void> {
    const baseUrl = ownerBaseUrl.value;
    const jwt = ownerJwt.value;
    const kek = getDmKekMaterial();
    const name = createName.trim();
    if (!baseUrl || !jwt || !kek || !name) return;
    setCreating(true);
    setError(null);
    try {
      const client = createWorkerAClient({ baseUrl, getJwt: () => jwt });
      const { group } = await createGroupWithKeys(client, kek, {
        name,
        announcement: createAnnouncement.trim() || undefined,
      });
      await reloadGroups(client);
      setCreateOpen(false);
      setCreateName('');
      setCreateAnnouncement('');
      selectGroup(group.group_id);
    } catch (err) {
      setError(err instanceof ApiError ? err.displayMessage : t('groupsCreateFailed'));
    } finally {
      setCreating(false);
    }
  }

  async function handleJoinGroup(): Promise<void> {
    const share = parseGroupShareInput(joinPaste);
    const invite = share ? null : parseGroupInviteInput(joinPaste);
    if (!share && !invite) {
      setError(t('groupsJoinInvalidInvite'));
      return;
    }
    const baseUrl = ownerBaseUrl.value;
    const jwt = ownerJwt.value;
    const kek = getDmKekMaterial();
    if (!baseUrl || !jwt || !kek) return;
    setJoining(true);
    setError(null);
    try {
      const client = createWorkerAClient({ baseUrl, getJwt: () => jwt });
      const joined = share
        ? await joinGroupById(client, kek, {
            groupId: share.groupId,
            ownerWorkerBUrl: share.ownerWorkerBUrl,
          })
        : await joinGroupByInvite(client, kek, {
            groupId: invite!.groupId || undefined,
            ownerWorkerBUrl: invite!.ownerWorkerBUrl,
            inviteToken: invite!.inviteToken,
          });
      const groupId = joined.group_id;
      if (joined.membership_status === 'pending') {
        await reloadGroups(client);
        setJoinOpen(false);
        setJoinPaste('');
        setError(t('groupsJoinPendingOk'));
        selectGroup(groupId);
        return;
      }
      await hydrateGroupKeys(client, kek, groupId);
      await reloadGroups(client);
      setJoinOpen(false);
      setJoinPaste('');
      selectGroup(groupId);
    } catch (err) {
      setError(err instanceof ApiError ? err.displayMessage : t('groupsJoinFailed'));
    } finally {
      setJoining(false);
    }
  }

  /** M-RT-3：群聊首屏 + 后续 cursor 加载。 */
  async function loadInitialGmHistory(groupId: string): Promise<void> {
    const baseUrl = ownerBaseUrl.value;
    const jwt = ownerJwt.value;
    const kek = getDmKekMaterial();
    if (!baseUrl || !jwt || !kek) return;
    const g = groupsRef.current.find((x) => x.group_id === groupId);
    const ownerUrl = g?.owner_worker_b_url ?? meWorkerB;
    try {
      const client = createWorkerAClient({ baseUrl, getJwt: () => jwt });
      const local = await listDecryptedPlaintexts(groupId);
      setMessages(local);
      const page = await loadOlderGroupPlaintexts(
        client,
        groupId,
        kek,
        ownerUrl,
        meWorkerB,
        null,
      );
      // M-RT-3-HISTORY-FIX：首屏 = 本地已缓存历史（含此前翻过的更早页）+ 最新一页
      const merged = page.items.length > 0 ? mergeGroupRecords(local, page.items) : local;
      setMessages(merged);
      setOlderCursorGm(page.nextCursor);
      setHasMoreHistoryGm(page.hasMore);
    } catch {
      // 静默：失败不阻断 UI
    }
  }

  /** M-RT-3：滚到顶时按 cursor 取更早一页；保留滚动位置避免视觉跳变。 */
  async function loadOlderGmHistory(): Promise<void> {
    if (loadingOlderGm || !hasMoreHistoryGm) return;
    const baseUrl = ownerBaseUrl.value;
    const jwt = ownerJwt.value;
    const kek = getDmKekMaterial();
    const groupId = selectedGroupIdRef.current;
    if (!baseUrl || !jwt || !kek || !groupId) return;
    const g = groupsRef.current.find((x) => x.group_id === groupId);
    const ownerUrl = g?.owner_worker_b_url ?? meWorkerB;
    setLoadingOlderGm(true);
    try {
      const client = createWorkerAClient({ baseUrl, getJwt: () => jwt });
      const page = await loadOlderGroupPlaintexts(
        client,
        groupId,
        kek,
        ownerUrl,
        meWorkerB,
        olderCursorGm,
      );
      if (page.items.length > 0) {
        setMessages((prev) => mergeGroupRecords(prev, page.items));
      }
      setOlderCursorGm(page.nextCursor);
      setHasMoreHistoryGm(page.hasMore);
    } catch (err) {
      if (!isQuotaExceeded(err)) {
        console.warn('[m-rt-3] 加载更早群消息失败', err);
      }
    } finally {
      setLoadingOlderGm(false);
    }
  }

  /** M-RT-3：群聊失败消息的重试 — 复用原 send input 重新走 sendGroupMessage。 */
  async function handleRetryGmPending(tempId: string): Promise<void> {
    const entry = pendingGm.find((p) => p.tempId === tempId);
    if (!entry) return;
    setPendingGm((prev) =>
      prev.map((p) => (p.tempId === tempId ? { ...p, status: 'sending' } : p)),
    );
    setError(null);
    try {
      let imageFile = entry.input.imageFile;
      if (!imageFile && entry.imagePreviewUrl) {
        try {
          const resp = await fetch(entry.imagePreviewUrl);
          if (resp.ok) {
            const blob = await resp.blob();
            if (blob && blob.size > 0) {
              imageFile = new File([blob], 'retry-image', {
                type: blob.type || 'application/octet-stream',
              });
            }
          }
        } catch {
          // 旧预览 blob 失效 → 仅文字重发
        }
      }
      const record = await sendGroupMessage({
        client: entry.input.client,
        passwordHash: entry.input.passwordHash,
        senderHandle: entry.input.senderHandle,
        ...(entry.input.senderNickname ? { senderNickname: entry.input.senderNickname } : {}),
        senderWorkerBUrl: entry.input.senderWorkerBUrl,
        groupId: entry.input.groupId,
        ownerWorkerBUrl: entry.input.ownerWorkerBUrl,
        epoch: entry.input.epoch,
        plaintext: entry.plaintext,
        imageFile: imageFile ?? undefined,
      });
      setPendingGm((prev) => prev.filter((p) => p.tempId !== tempId));
      setMessages((prev) => {
        const next = prev.filter((m) => m.message_id !== record.message_id);
        next.push(record);
        return next.sort((a, b) => a.created_at.localeCompare(b.created_at));
      });
      setPreviews((prev) => ({
        ...prev,
        [entry.groupId]: {
          preview: record.plaintext.slice(0, 80) || prev[entry.groupId]?.preview || null,
          lastAt: record.created_at,
        },
      }));
      void pollCurrentGroup();
    } catch (err) {
      setPendingGm((prev) =>
        prev.map((p) => (p.tempId === tempId ? { ...p, status: 'failed' } : p)),
      );
      setError(
        err instanceof ApiError
          ? err.displayMessage
          : err instanceof Error && err.message.trim()
            ? err.message
            : t('groupsSendFailed'),
      );
    }
  }

  async function handleSend(): Promise<void> {
    if (!selectedGroup) return;
    const baseUrl = ownerBaseUrl.value;
    const jwt = ownerJwt.value;
    const kek = getDmKekMaterial();
    if (!baseUrl || !jwt || !kek || (!compose.trim() && !pendingImage)) return;
    setSending(true);
    setError(null);
    try {
      const client = createWorkerAClient({ baseUrl, getJwt: () => jwt });
      // getMe 与群列表并行；发信前必须有 handle + worker_b，否则 sign-envelope 必 403
      let senderHandle = meHandle.trim();
      let senderWorkerBUrl = meWorkerB.trim();
      if (!senderHandle || !senderWorkerBUrl) {
        const me = await client.getMe();
        senderHandle = me.handle.trim();
        senderWorkerBUrl = (me.worker_b_url ?? resolvePublicWorkerBBaseUrlSync()).trim();
        setMeHandle(senderHandle);
        setMeWorkerB(senderWorkerBUrl);
      }
      if (!senderHandle || !senderWorkerBUrl) {
        setError(t('groupsSendIdentityNotReady'));
        return;
      }
      const senderNickname = readGroupNickname(selectedGroup.group_id);
      const sendInput: SendGroupInputLike = {
        client,
        passwordHash: kek,
        senderHandle,
        ...(senderNickname ? { senderNickname } : {}),
        senderWorkerBUrl,
        groupId: selectedGroup.group_id,
        ownerWorkerBUrl: selectedGroup.owner_worker_b_url,
        epoch: selectedGroup.epoch,
        imageFile: pendingImage,
      };
      // M-RT-3：发前入 pendingGm 占位
      const tempId = `temp-gm-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const sendingNow: GroupPendingOutbox = {
        tempId,
        groupId: selectedGroup.group_id,
        senderHandle,
        plaintext: compose,
        createdAt: new Date().toISOString(),
        imagePreviewUrl: pendingImage ? pendingPreviewUrl : null,
        status: 'sending',
        input: sendInput,
      };
      setPendingGm((prev) => [...prev, sendingNow]);
      const record = await sendGroupMessage({
        client,
        passwordHash: kek,
        senderHandle,
        ...(senderNickname ? { senderNickname } : {}),
        senderWorkerBUrl,
        groupId: selectedGroup.group_id,
        ownerWorkerBUrl: selectedGroup.owner_worker_b_url,
        epoch: selectedGroup.epoch,
        plaintext: compose,
        imageFile: pendingImage ?? undefined,
      });
      setCompose('');
      clearPendingImage();
      // M-RT-0a：气泡立刻上屏 + 列表预览即时更新 + 立刻 poll 一次
      setMessages((prev) => {
        const next = prev.filter((m) => m.message_id !== record.message_id);
        next.push(record);
        return next.sort((a, b) => a.created_at.localeCompare(b.created_at));
      });
      setPreviews((prev) => ({
        ...prev,
        [selectedGroup.group_id]: {
          preview: record.plaintext.slice(0, 80) || prev[selectedGroup.group_id]?.preview || null,
          lastAt: record.created_at,
        },
      }));
      // 占位下线（成功 → 真消息已落 IDB + UI）
      setPendingGm((prev) => prev.filter((p) => p.tempId !== tempId));
      void pollCurrentGroup();
    } catch (err) {
      // M-RT-3：失败时把该条标记为 failed；显示的错误文案仍走顶部红条
      setPendingGm((prev) =>
        prev.map((p) => (p.status === 'sending' ? { ...p, status: 'failed' } : p)),
      );
      setError(
        err instanceof ApiError
          ? err.displayMessage
          : err instanceof Error && err.message.trim()
            ? err.message
            : t('groupsSendFailed'),
      );
    } finally {
      setSending(false);
    }
  }

  function clearPendingImage(): void {
    if (pendingPreviewUrl) URL.revokeObjectURL(pendingPreviewUrl);
    setPendingImage(null);
    setPendingPreviewUrl(null);
  }

  function handlePickImage(file: File | null): void {
    if (!file) return;
    if (file.size > MAX_GROUP_IMAGE_BYTES) {
      setError(t('groupsImageTooLarge'));
      return;
    }
    clearPendingImage();
    setPendingImage(file);
    setPendingPreviewUrl(URL.createObjectURL(file));
    setError(null);
  }

  /** 回形针始终可点：无云存储时给出明确提示，避免按钮灰掉却无反馈。 */
  function handleAttachClick(): void {
    if (!canSendGroupMedia) {
      setError(t('groupsImageCloudRequired'));
      return;
    }
    imageInputRef.current?.click();
  }

  useEffect(() => {
    return () => revokeGroupMediaObjectUrls(messages);
  }, [messages]);

  /**
   * UX-GROUPS-8/9：打开群设置弹窗。
   * `group` 可显式指定（点列表角标时选中态还没落地）；`tab` 指定分区；
   * `highlightPending` 走审批分区并高亮（深链 / 列表角标 / 头部审批按钮）。
   */
  function openSettingsModal(options?: {
    highlightPending?: boolean;
    tab?: GroupSettingsTab;
    group?: LocalGroupItem | null;
  }): void {
    const group = options?.group ?? selectedGroup;
    if (!group) return;
    setSettingsTab(options?.tab ?? (options?.highlightPending ? 'members' : 'info'));
    setSettingsRetention(String(group.local_retention_days ?? 90));
    setSettingsName(group.name);
    setOriginalName(group.name);
    setSettingsAnnouncement(group.announcement ?? '');
    setOriginalAnnouncement(group.announcement ?? '');
    // GRP-NICKNAME-1：每次打开都从本机读取当前群的昵称
    setSettingsNickname(readGroupNickname(group.group_id));
    setNicknameSaved(false);
    // GRP-MEMBER-PAGE-1：成员搜索每次打开重置，避免上次关键字把名单筛空
    setSettingsMemberFilter('');
    setMessagingCapacity(null);
    setJoinRequests([]);
    setGroupMembers([]);
    setRemoteAdminVerified(false);
    // REL-FIX-5：深链进入时高亮待审批段（列表加载完自动取消）。
    setPendingHighlight(options?.highlightPending === true);
    setSettingsOpen(true);

    const baseUrl = ownerBaseUrl.value;
    const jwt = ownerJwt.value;
    if (!baseUrl || !jwt) return;
    const canModerate = isGroupModerator(group);
    setLoadingCapacity(true);
    setJoinRequestsLoading(canModerate);
    setGroupMembersLoading(canModerate);
    void (async () => {
      try {
        const client = createWorkerAClient({ baseUrl, getJwt: () => jwt });
        // UX-GROUPS-9：容量查询只是提示信息，失败不能连带跳过审批列表 / 群成员。
        // （跨节点管理员、普通成员可能无权读容量；旧写法会让审批区永远不加载。）
        try {
          setMessagingCapacity(await fetchMessagingDbCapacity(client));
        } catch {
          setMessagingCapacity(null);
        }
        // REL-FIX-6：审批列表统一走探测式请求。
        // 本机是群主 → 本地直接返回；本机是跨节点管理员 → Worker A 向群主代理拉取；
        // 普通成员 → 403。前端按「成功 / 失败」决定是否渲染审批区，不依赖本机 is_admin 标记。
        try {
          const req = await client.listGroupJoinRequests(group.group_id);
          setJoinRequests(req.items);
          setRemoteAdminVerified(true);
        } catch (err) {
          // 403 = 非群主/非管理员，属预期降级；不打扰用户。
          if (!(err instanceof ApiError && err.status === 403)) {
            throw err;
          }
        }
        if (canModerate) {
          try {
            const members = await listGroupMembers(client, group.group_id);
            setGroupMembers(members.items);
            syncHeaderMembersFromFull(group.group_id, members.items);
          } catch {
            // 成员列表失败同样降级，不影响审批区
          }
        }
      } catch {
        setMessagingCapacity(null);
      } finally {
        setLoadingCapacity(false);
        setJoinRequestsLoading(false);
        setGroupMembersLoading(false);
        // REL-FIX-5：列表已加载 → 取消高亮（避免一直红框）
        setPendingHighlight(false);
      }
    })();
  }

  /** UX-GROUPS-9：点群列表的「N 条待审批」→ 选中该群并直达审批分区。 */
  function openJoinRequests(groupId: string): void {
    const target = groups.find((g) => g.group_id === groupId) ?? null;
    if (!target) return;
    selectGroup(groupId);
    openSettingsModal({ group: target, tab: 'members', highlightPending: true });
  }

  async function handleJoinRequest(
    action: 'approve' | 'reject',
    memberUrl: string,
  ): Promise<void> {
    if (!selectedGroup) return;
    const baseUrl = ownerBaseUrl.value;
    const jwt = ownerJwt.value;
    if (!baseUrl || !jwt) return;
    // REL-FIX-9：同步闸门。state 版（processingMemberUrl）要等下一次渲染才生效，
    // 同一 tick 内的双击会同时穿过 → 用 ref 做**立即**判定，杜绝重复请求。
    // 采用「单槽」语义：只要有一条审批在飞，就不再接受新的审批请求
    // （既防同一成员双击，也防不同成员并发导致列表刷新乱序）。
    if (processingMemberUrlRef.current !== null) return;
    processingMemberUrlRef.current = memberUrl;
    setProcessingMemberUrl(memberUrl);
    setError(null);
    try {
      const client = createWorkerAClient({ baseUrl, getJwt: () => jwt });
      if (action === 'approve') {
        await client.approveGroupJoinRequest(selectedGroup.group_id, memberUrl);
      } else {
        await client.rejectGroupJoinRequest(selectedGroup.group_id, memberUrl);
      }
      const req = await client.listGroupJoinRequests(selectedGroup.group_id);
      setJoinRequests(req.items);
      // REL-FIX-13：审批后群列表的「待审批」角标（pending_join_count）需同步刷新，
      // 否则弹窗内该行消失、但侧栏红点与群头小红点仍留着旧计数。
      void reloadGroups(client);
    } catch (err) {
      // REL-FIX-9：群主侧对「已不是 pending」的申请返回 404 GROUP_NOT_FOUND。
      // 典型场景：并发（别的管理员/另一端已处理）或本次之前已成功过一次。
      // 这时**不是**真失败 → 静默刷新列表，不弹误导性红条。
      const isStaleRequest =
        err instanceof ApiError && err.status === 404 && err.code === 'GROUP_NOT_FOUND';
      if (isStaleRequest) {
        try {
          const client = createWorkerAClient({ baseUrl, getJwt: () => jwt });
          const req = await client.listGroupJoinRequests(selectedGroup.group_id);
          setJoinRequests(req.items);
          // 同上：陈旧请求分支也要刷新群列表角标
          void reloadGroups(client);
        } catch {
          // 列表也拉不到 → 保留原错误提示
          setError(t('groupsJoinRequestFailed'));
        }
      } else {
        setError(err instanceof ApiError ? err.displayMessage : t('groupsJoinRequestFailed'));
      }
    } finally {
      processingMemberUrlRef.current = null;
      setProcessingMemberUrl(null);
    }
  }

  async function handleSaveSettings(): Promise<void> {
    if (!selectedGroup) return;
    const days = parseInt(settingsRetention, 10);
    if (!Number.isInteger(days) || days < 1 || days > 365) return;
    const baseUrl = ownerBaseUrl.value;
    const jwt = ownerJwt.value;
    if (!baseUrl || !jwt) return;
    setSavingSettings(true);
    setError(null);
    try {
      const client = createWorkerAClient({ baseUrl, getJwt: () => jwt });
      await updateGroupLocalSettings(client, selectedGroup.group_id, days);
      await reloadGroups(client);
      setSettingsOpen(false);
    } catch (err) {
      setError(err instanceof ApiError ? err.displayMessage : t('groupsSettingsFailed'));
    } finally {
      setSavingSettings(false);
    }
  }

  /**
   * GRP-NICKNAME-1：保存本群昵称（纯本机，无网络请求）。
   * 昵称只随之后发出的消息密文下发；历史消息保持原样，符合「改名不改旧话」。
   */
  function handleSaveNickname(): void {
    if (!selectedGroup) return;
    const saved = writeGroupNickname(selectedGroup.group_id, settingsNickname);
    setSettingsNickname(saved);
    setNicknameSaved(true);
  }

  /** UX-GROUPS-7b：群主改群名称；群号 group_id 不可改（无此端点）。 */
  async function handleSaveName(): Promise<void> {
    if (!selectedGroup) return;
    if (selectedGroup.role !== 'owner') return;
    const nextName = settingsName.trim();
    if (nextName.length === 0) return;
    if (nextName === originalName) {
      // 没变化也走一次 reload 让弹窗关闭路径统一，但跳过后端调用
      setSettingsOpen(false);
      return;
    }
    const baseUrl = ownerBaseUrl.value;
    const jwt = ownerJwt.value;
    if (!baseUrl || !jwt) return;
    setSavingName(true);
    setError(null);
    try {
      const client = createWorkerAClient({ baseUrl, getJwt: () => jwt });
      await updateGroupName(client, selectedGroup.group_id, nextName);
      await reloadGroups(client);
      setOriginalName(nextName);
      setSettingsOpen(false);
    } catch (err) {
      setError(err instanceof ApiError ? err.displayMessage : t('groupsSettingsNameFailed'));
    } finally {
      setSavingName(false);
    }
  }

  /** UX-GROUPS-7c：群主或管理员改公告（空字符串视作清空，与后端 setGroupAnnouncement 一致）。 */
  async function handleSaveAnnouncement(): Promise<void> {
    if (!selectedGroup) return;
    if (!isGroupModerator(selectedGroup)) return;
    const nextAnnouncement = settingsAnnouncement.trim();
    if (nextAnnouncement === originalAnnouncement) {
      // 没变化也走一次 reload 让弹窗关闭路径统一，但跳过后端调用
      setSettingsOpen(false);
      return;
    }
    const baseUrl = ownerBaseUrl.value;
    const jwt = ownerJwt.value;
    if (!baseUrl || !jwt) return;
    setSavingAnnouncement(true);
    setError(null);
    try {
      const client = createWorkerAClient({ baseUrl, getJwt: () => jwt });
      await updateGroupAnnouncement(client, selectedGroup.group_id, nextAnnouncement);
      await reloadGroups(client);
      setOriginalAnnouncement(nextAnnouncement);
      setSettingsOpen(false);
    } catch (err) {
      setError(err instanceof ApiError ? err.displayMessage : t('groupsSettingsAnnouncementFailed'));
    } finally {
      setSavingAnnouncement(false);
    }
  }

  async function confirmLeaveGroup(): Promise<void> {
    if (!selectedGroup) return;
    if (selectedGroup.role === 'owner') {
      setGroupConfirmKind(null);
      setError(t('groupsOwnerCannotLeave'));
      return;
    }
    const baseUrl = ownerBaseUrl.value;
    const jwt = ownerJwt.value;
    if (!baseUrl || !jwt) return;
    setError(null);
    setLeaving(true);
    try {
      const client = createWorkerAClient({ baseUrl, getJwt: () => jwt });
      await leaveGroup(client, selectedGroup.group_id);
      setSelectedGroupId(null);
      setMobilePane('list');
      setCompose('');
      setGroupConfirmKind(null);
      await reloadGroups(client);
    } catch (err) {
      setError(err instanceof ApiError ? err.displayMessage : t('groupsLeaveFailed'));
    } finally {
      setLeaving(false);
    }
  }

  async function confirmDissolveGroup(): Promise<void> {
    if (!selectedGroup) return;
    if (selectedGroup.role !== 'owner') return;
    if (selectedGroup.dissolved_at) return;
    const baseUrl = ownerBaseUrl.value;
    const jwt = ownerJwt.value;
    if (!baseUrl || !jwt) return;
    setError(null);
    setDissolving(true);
    try {
      const client = createWorkerAClient({ baseUrl, getJwt: () => jwt });
      const dissolvedId = selectedGroup.group_id;
      await dissolveGroup(client, dissolvedId);
      setCompose('');
      setPendingImage(null);
      if (pendingPreviewUrl) {
        URL.revokeObjectURL(pendingPreviewUrl);
        setPendingPreviewUrl(null);
      }
      // 解散后去掉该群失败/发送中占位，避免残留到其它群会话
      setPendingGm((prev) => prev.filter((p) => p.groupId !== dissolvedId));
      setGroupConfirmKind(null);
      await reloadGroups(client);
    } catch (err) {
      setError(err instanceof ApiError ? err.displayMessage : t('groupsDissolveFailed'));
    } finally {
      setDissolving(false);
    }
  }

  function requestLeaveGroup(): void {
    if (!selectedGroup) return;
    if (selectedGroup.role === 'owner') {
      setError(t('groupsOwnerCannotLeave'));
      return;
    }
    setGroupConfirmKind('leave');
  }

  function requestDissolveGroup(): void {
    if (!selectedGroup) return;
    if (selectedGroup.role !== 'owner') return;
    if (selectedGroup.dissolved_at) return;
    setGroupConfirmKind('dissolve');
  }

  async function copyInviteText(text: string): Promise<void> {
    if (!navigator.clipboard?.writeText) return;
    await navigator.clipboard.writeText(text);
  }

  /** 打开分享弹窗：固定群号 #g/ + 三策略（不再提供临时邀请码） */
  function openInviteModal(): void {
    if (!selectedGroup || selectedGroup.role !== 'owner') return;
    const policy = resolveJoinPolicy(selectedGroup);
    setSharePolicy(policy);
    const text = formatGroupShareLink({
      group_id: selectedGroup.group_id,
      owner_worker_b_url: selectedGroup.owner_worker_b_url,
    });
    setInviteText(text);
    setInviteOpen(true);
    setError(null);
    void copyInviteText(text);
  }

  async function handleSharePolicyChange(policy: GroupJoinPolicy): Promise<void> {
    if (!selectedGroup) return;
    const baseUrl = ownerBaseUrl.value;
    const jwt = ownerJwt.value;
    if (!baseUrl || !jwt) return;
    setSharePolicy(policy);
    setSharePolicySaving(true);
    setError(null);
    try {
      const client = createWorkerAClient({ baseUrl, getJwt: () => jwt });
      await client.putGroupJoinPolicy(selectedGroup.group_id, policy);
      setGroups((prev) =>
        prev.map((g) =>
          g.group_id === selectedGroup.group_id
            ? {
                ...g,
                join_policy: policy,
                join_requires_approval: policy === 'approval',
              }
            : g,
        ),
      );
    } catch (err) {
      setError(err instanceof ApiError ? err.displayMessage : t('groupsPolicySaveFailed'));
    } finally {
      setSharePolicySaving(false);
    }
  }

  async function handleMuteChange(membersMuted: boolean): Promise<void> {
    if (!selectedGroup) return;
    const baseUrl = ownerBaseUrl.value;
    const jwt = ownerJwt.value;
    if (!baseUrl || !jwt) return;
    setMuteSaving(true);
    setError(null);
    try {
      const client = createWorkerAClient({ baseUrl, getJwt: () => jwt });
      await client.putGroupMute(selectedGroup.group_id, membersMuted);
      setGroups((prev) =>
        prev.map((g) =>
          g.group_id === selectedGroup.group_id ? { ...g, members_muted: membersMuted } : g,
        ),
      );
    } catch (err) {
      setError(err instanceof ApiError ? err.displayMessage : t('groupsMuteSaveFailed'));
    } finally {
      setMuteSaving(false);
    }
  }

  async function handleAdminChange(memberUrl: string, isAdmin: boolean): Promise<void> {
    if (!selectedGroup) return;
    const baseUrl = ownerBaseUrl.value;
    const jwt = ownerJwt.value;
    if (!baseUrl || !jwt) return;
    setAdminSavingUrl(memberUrl);
    setError(null);
    try {
      const client = createWorkerAClient({ baseUrl, getJwt: () => jwt });
      await setGroupAdmin(client, selectedGroup.group_id, {
        member_worker_b_url: memberUrl,
        is_admin: isAdmin,
      });
      const members = await listGroupMembers(client, selectedGroup.group_id);
      setGroupMembers(members.items);
      syncHeaderMembersFromFull(selectedGroup.group_id, members.items);
    } catch (err) {
      setError(err instanceof ApiError ? err.displayMessage : t('groupsAdminSaveFailed'));
    } finally {
      setAdminSavingUrl(null);
    }
  }

  async function handleKickMember(memberUrl: string): Promise<void> {
    if (!selectedGroup) return;
    const baseUrl = ownerBaseUrl.value;
    const jwt = ownerJwt.value;
    if (!baseUrl || !jwt) return;
    setAdminSavingUrl(memberUrl);
    setError(null);
    try {
      const client = createWorkerAClient({ baseUrl, getJwt: () => jwt });
      // REKEY-1：踢人只隔绝；真换钥走 UX-1 密封入口。
      await kickGroupMember(client, selectedGroup.group_id, memberUrl, {
        expectedEpoch: selectedGroup.epoch,
        meWorkerBUrl: meWorkerB,
      });
      const members = await listGroupMembers(client, selectedGroup.group_id);
      setGroupMembers(members.items);
      syncHeaderMembersFromFull(selectedGroup.group_id, members.items);
      // 本地立刻打上待换钥，灰色横幅无需等下一轮 list。
      setGroups((prev) =>
        prev.map((g) =>
          g.group_id === selectedGroup.group_id ? { ...g, rekey_scheduled: true } : g,
        ),
      );
      await reloadGroups(client);
    } catch (err) {
      setError(err instanceof ApiError ? err.displayMessage : t('groupsKickFailed'));
    } finally {
      setAdminSavingUrl(null);
    }
  }

  /** OWNER-KEY-4：主/管触发群主节点批量代封 pending_key（有 DH 者）。 */
  async function handleSealPendingKeys(): Promise<void> {
    if (!selectedGroup) return;
    if (!isGroupModerator(selectedGroup)) return;
    const baseUrl = ownerBaseUrl.value;
    const jwt = ownerJwt.value;
    if (!baseUrl || !jwt) return;
    setSealPendingBusy(true);
    setError(null);
    try {
      const client = createWorkerAClient({ baseUrl, getJwt: () => jwt });
      const result = await client.sealGroupPendingKeys(selectedGroup.group_id);
      const members = await listGroupMembers(client, selectedGroup.group_id);
      setGroupMembers(members.items);
      syncHeaderMembersFromFull(selectedGroup.group_id, members.items);
      await reloadGroups(client);
      if (result.remaining_pending_key > 0) {
        setError(
          t('groupsSealPendingPartial', undefined, {
            sealed: result.sealed,
            remaining: result.remaining_pending_key,
            skipped: result.skipped_no_dh,
          }),
        );
      } else {
        setError(null);
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.displayMessage : t('groupsSealPendingFailed'));
    } finally {
      setSealPendingBusy(false);
    }
  }

  /**
   * OWNER-KEY-5 / EPOCH-UX-1：优先群主节点服务端换钥；
   * 缺 wrap secret / 非群主节点时回落浏览器 Batch（迁移期 deprecated）。
   */
  async function handleRekeyCommit(): Promise<void> {
    if (!selectedGroup || !meWorkerB) return;
    if (!isGroupModerator(selectedGroup)) return;
    const baseUrl = ownerBaseUrl.value;
    const jwt = ownerJwt.value;
    const kek = getDmKekMaterial();
    if (!baseUrl || !jwt || !kek) return;
    setRekeyBusy(true);
    setRekeyProgress(null);
    setError(null);
    try {
      const client = createWorkerAClient({ baseUrl, getJwt: () => jwt });
      await registerGroupMemberDhPubkey(client, kek, selectedGroup.group_id);

      try {
        await ownerServerRekey(client, selectedGroup.group_id, selectedGroup.epoch);
        await reloadGroups(client);
        setError(null);
        return;
      } catch (serverErr) {
        if (!shouldFallbackBrowserRekeyWrap(serverErr)) {
          throw serverErr;
        }
        // 迁移期兜底：无持钥 secret 或非群主节点 → 浏览器密封
      }

      const members = await listGroupMembers(client, selectedGroup.group_id);
      setGroupMembers(members.items);
      syncHeaderMembersFromFull(selectedGroup.group_id, members.items);
      const active = members.items.filter((m) => m.status === 'active');
      const missingDh = active.filter((m) => {
        if (m.member_worker_b_url === meWorkerB) return false;
        const dh = (m.member_dh_pubkey ?? '').trim().toLowerCase();
        return !/^[0-9a-f]{64}$/.test(dh);
      });
      if (missingDh.length > 0) {
        setError(t('groupsRekeyNeedDh'));
        await reloadGroups(client);
        return;
      }
      await batchWrapNextEpochKeys(client, kek, {
        groupId: selectedGroup.group_id,
        currentEpoch: selectedGroup.epoch,
        localWorkerBUrl: meWorkerB,
        members: active.map((m) => ({
          member_worker_b_url: m.member_worker_b_url,
          member_dh_pubkey: m.member_dh_pubkey ?? null,
        })),
        onProgress: (p) => setRekeyProgress({ ready: p.uploaded, total: p.total }),
      });
      await commitGroupEpochRekey(client, selectedGroup.group_id, selectedGroup.epoch);
      await reloadGroups(client);
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.displayMessage : t('groupsRekeyCommitFailed'));
    } finally {
      setRekeyBusy(false);
      setRekeyProgress(null);
    }
  }

  async function handleCopyShareLink(): Promise<void> {
    if (!selectedGroup) return;
    const text = formatGroupShareLink({
      group_id: selectedGroup.group_id,
      owner_worker_b_url: selectedGroup.owner_worker_b_url,
    });
    setInviteText(text);
    await copyInviteText(text);
  }

  // GRP-NICKNAME-1：从本机已解密消息推导「handle → 最近昵称」，零新增请求；未命中回落 handle
  const memberNicknames = useMemo(() => collectMemberNicknames(messages), [messages]);
  // GRP-MEMBER-PAGE-1：设置页成员 = 搜索过滤 + 渲染上限（groupMembers 仍是全量，换钥/补封要用）
  const settingsMemberRows = useMemo(() => {
    const q = settingsMemberFilter.trim().toLowerCase();
    const rows = q
      ? groupMembers.filter((m) => {
          const nickname = memberNicknames[m.member_handle.trim().toLowerCase()] ?? '';
          return (
            m.member_handle.toLowerCase().includes(q) || nickname.toLowerCase().includes(q)
          );
        })
      : groupMembers;
    return { matched: rows.length, shown: rows.slice(0, SETTINGS_MEMBER_RENDER_CAP) };
  }, [groupMembers, settingsMemberFilter, memberNicknames]);

  if (!ownerCredentialsReady.value) {
    return <p class="text-sm text-zinc-500">{t('commonCheckingLogin')}</p>;
  }
  if (loading) {
    return <p class="text-sm text-zinc-500">{t('groupsLoading')}</p>;
  }

  const showListOnMobile = mobilePane === 'list';
  const showChatOnMobile = mobilePane === 'chat';

  return (
    <div class="flex h-[calc(100dvh-0px)] min-h-0 w-full flex-col bg-zinc-100/80 dark:bg-zinc-950 md:h-full">
      {error && (
        <p
          class="mx-3 mt-3 rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-800 dark:border-rose-900 dark:bg-rose-950/40 dark:text-rose-200 md:mx-4"
          role="alert"
        >
          {error}
        </p>
      )}

      {/* UX-GROUPS-6b：<960 列表/聊天互斥（窄屏先藏列表保聊天）；≥960 并排且列表缩窄。
          UX-CHAT-ALIGN-1：左缘用 px-4 sm:px-6，与首页 PostCard 同款。 */}
      <div class="flex min-h-0 flex-1 bg-gradient-to-br from-zinc-100/90 via-slate-100/70 to-emerald-50/40 px-4 py-3 dark:from-zinc-950 dark:via-zinc-950 dark:to-zinc-900 sm:px-6">
        <div class="flex min-h-0 w-full flex-1 overflow-hidden rounded-2xl border border-zinc-300/80 bg-white/95 shadow-xl shadow-zinc-900/5 ring-1 ring-white/60 dark:border-zinc-600 dark:bg-zinc-900 dark:shadow-black/40 dark:ring-zinc-800">
          <div
            class={`min-h-0 w-full shrink-0 min-[960px]:w-[260px] min-[960px]:border-r min-[960px]:border-zinc-200 dark:min-[960px]:border-zinc-700 ${
              showChatOnMobile ? 'hidden min-[960px]:flex' : 'flex'
            }`}
          >
            <GroupListPanel
              groups={groups}
              selectedGroupId={selectedGroupId}
              selectedIsOwner={selectedGroup?.role === 'owner'}
              selectedDissolved={Boolean(selectedGroup?.dissolved_at)}
              previews={previews}
              onSelect={selectGroup}
              onCreateClick={() => setCreateOpen(true)}
              onJoinClick={() => setJoinOpen(true)}
              onLeaveClick={() => requestLeaveGroup()}
              onSettingsClick={openSettingsModal}
              onDissolveClick={() => requestDissolveGroup()}
              onOpenJoinRequests={openJoinRequests}
            />
          </div>

          <div
            class={`min-h-0 min-w-0 flex-1 ${
              showListOnMobile ? 'hidden min-[960px]:flex' : 'flex'
            }`}
          >
            <GroupChatPanel
              group={selectedGroup}
              members={headerMembers}
              memberNicknames={memberNicknames}
              membersTotal={headerMembersTotal > 0 ? headerMembersTotal : undefined}
              membersHasMore={headerMembersHasMore}
              membersLoadingMore={headerMembersLoadingMore}
              onLoadMoreMembers={() => void loadMoreHeaderMembers()}
              messages={messages}
              pending={
                selectedGroupId
                  ? pendingGm.filter((p) => p.groupId === selectedGroupId)
                  : []
              }
              meHandle={meHandle}
              compose={compose}
              sending={sending || dissolving}
              canSendGroupMedia={canSendGroupMedia}
              pendingPreviewUrl={pendingPreviewUrl}
              hasMoreHistory={hasMoreHistoryGm}
              loadingOlder={loadingOlderGm}
              onLoadOlder={() => void loadOlderGmHistory()}
              onRetryPending={(tempId) => void handleRetryGmPending(tempId)}
              onCompose={setCompose}
              onSend={() => void handleSend()}
              onPickImage={handlePickImage}
              onAttachClick={handleAttachClick}
              onClearImage={clearPendingImage}
              imageInputRef={imageInputRef}
              onBack={() => setMobilePane('list')}
              onCopyInvite={() => openInviteModal()}
              onSettingsClick={openSettingsModal}
              onJoinRequestsClick={() =>
                openSettingsModal({ tab: 'members', highlightPending: true })
              }
            />
          </div>
        </div>
      </div>

      <GroupModal open={createOpen} title={t('groupsCreate')} onClose={() => setCreateOpen(false)}>
        <label class="mb-2 block text-sm font-medium">{t('groupsCreateNameLabel')}</label>
        <input
          class="mb-3 w-full rounded-xl border border-zinc-200 px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-950"
          placeholder={t('groupsCreateNamePlaceholder')}
          value={createName}
          onInput={(e) => setCreateName((e.target as HTMLInputElement).value)}
        />
        <label class="mb-2 block text-sm font-medium">{t('groupsCreateAnnouncementLabel')}</label>
        <textarea
          class="mb-3 w-full rounded-xl border border-zinc-200 px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-950"
          rows={2}
          value={createAnnouncement}
          onInput={(e) => setCreateAnnouncement((e.target as HTMLTextAreaElement).value)}
        />
        {/* OWNER-KEY-6：创建群知情 · 托管群密 */}
        <p
          class="mb-4 rounded-lg border border-zinc-300 bg-zinc-50 px-2.5 py-2 text-xs leading-relaxed text-zinc-700 dark:border-zinc-600 dark:bg-zinc-900/50 dark:text-zinc-300"
          data-testid="group-owner-key-create-notice"
        >
          {t('groupsOwnerKeyCreateNotice')}
        </p>
        <div class="flex justify-end gap-2">
          <button type="button" class="rounded-xl px-3 py-2 text-sm" onClick={() => setCreateOpen(false)}>
            {t('groupsCancel')}
          </button>
          <button
            type="button"
            class="rounded-xl bg-sky-600 px-4 py-2 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-50"
            disabled={creating || !createName.trim()}
            onClick={() => void handleCreateGroup()}
          >
            {creating ? t('groupsCreating') : t('groupsCreateConfirm')}
          </button>
        </div>
      </GroupModal>

      <GroupModal open={joinOpen} title={t('groupsJoin')} onClose={() => setJoinOpen(false)}>
        <label class="mb-2 block text-sm font-medium">{t('groupsJoinPasteLabel')}</label>
        <textarea
          class="mb-3 w-full rounded-xl border border-zinc-200 px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-950"
          rows={3}
          placeholder={t('groupsJoinPastePlaceholder')}
          value={joinPaste}
          onInput={(e) => setJoinPaste((e.target as HTMLTextAreaElement).value)}
        />
        <p class="mb-2 text-xs font-medium text-zinc-600 dark:text-zinc-400">{t('groupsJoinScanLabel')}</p>
        <div class="mb-3">
          <QrScannerPanel
            onResult={(value) => {
              // 扫到邀请短链后填入粘贴框，由用户确认再加入
              setJoinPaste(value);
              setError(null);
            }}
          />
        </div>
        {/* OWNER-KEY-6：进群知情 · 托管群密 */}
        <p
          class="mb-4 rounded-lg border border-zinc-300 bg-zinc-50 px-2.5 py-2 text-xs leading-relaxed text-zinc-700 dark:border-zinc-600 dark:bg-zinc-900/50 dark:text-zinc-300"
          data-testid="group-owner-key-join-notice"
        >
          {t('groupsOwnerKeyJoinNotice')}
        </p>
        <div class="flex justify-end gap-2">
          <button type="button" class="rounded-xl px-3 py-2 text-sm" onClick={() => setJoinOpen(false)}>
            {t('groupsCancel')}
          </button>
          <button
            type="button"
            class="rounded-xl bg-sky-600 px-4 py-2 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-50"
            disabled={joining || !joinPaste.trim()}
            onClick={() => void handleJoinGroup()}
          >
            {joining ? t('groupsJoining') : t('groupsJoinConfirm')}
          </button>
        </div>
      </GroupModal>

      <GroupModal open={inviteOpen} title={t('groupsInviteModalTitle')} onClose={() => setInviteOpen(false)}>
        {selectedGroup ? (
          <>
            <p class="mb-2 text-sm font-medium text-zinc-800 dark:text-zinc-100">
              {t('groupsInviteGroupName', undefined, { name: selectedGroup.name })}
            </p>
            <p class="mb-1 text-xs font-medium text-zinc-600 dark:text-zinc-400">
              {t('groupsInviteGroupIdLabel')}
            </p>
            <p class="mb-3 break-all rounded-xl border border-zinc-200 bg-zinc-50 px-3 py-2 font-mono text-sm dark:border-zinc-700 dark:bg-zinc-950">
              {selectedGroup.group_id}
            </p>
          </>
        ) : null}

        <p class="mb-2 text-xs font-medium text-zinc-600 dark:text-zinc-400">
          {t('groupsInvitePolicyLabel')}
        </p>
        <div class="mb-2 flex flex-col gap-2">
          {(
            [
              ['approval', 'groupsInvitePolicyApproval'],
              ['open', 'groupsInvitePolicyOpen'],
              ['closed', 'groupsInvitePolicyClosed'],
            ] as const
          ).map(([value, labelKey]) => (
            <label
              key={value}
              class={`flex cursor-pointer items-center gap-2 rounded-xl border px-3 py-2 text-sm ${
                sharePolicy === value
                  ? 'border-sky-500 bg-sky-50 dark:border-sky-600 dark:bg-sky-950/40'
                  : 'border-zinc-200 dark:border-zinc-700'
              }`}
            >
              <input
                type="radio"
                name="join-policy"
                checked={sharePolicy === value}
                disabled={sharePolicySaving}
                onChange={() => void handleSharePolicyChange(value)}
              />
              <span>{t(labelKey)}</span>
            </label>
          ))}
        </div>
        {sharePolicy === 'closed' ? (
          <p class="mb-3 text-xs text-amber-700 dark:text-amber-300">{t('groupsInvitePolicyClosedHint')}</p>
        ) : (
          <p class="mb-3 text-xs text-zinc-500 dark:text-zinc-400">
            {sharePolicy === 'approval' ? t('groupsInvitePolicyApproval') : t('groupsInvitePolicyOpen')}
          </p>
        )}

        {inviteText ? (
          <>
            <p class="mb-2 text-xs text-zinc-500 dark:text-zinc-400">{t('groupsInviteCopied')}</p>
            <div class="mb-3 flex flex-col items-center gap-2">
              <QRCodeBadge value={inviteText} label={t('groupsInviteQrAlt')} size={160} />
              <p class="text-center text-xs text-zinc-500 dark:text-zinc-400">{t('groupsInviteHint')}</p>
            </div>
            <label class="mb-1 block text-xs font-medium text-zinc-600 dark:text-zinc-400">
              {t('groupsInviteLinkLabel')}
            </label>
            <p
              class="mb-1 break-all rounded-xl border border-zinc-200 bg-zinc-50 px-3 py-2 text-xs font-mono text-zinc-700 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-300"
              title={inviteText}
            >
              {inviteText}
            </p>
            <p class="mb-3 text-[11px] text-zinc-500 dark:text-zinc-400">{t('groupsInviteLinkHint')}</p>
          </>
        ) : null}

        <div class="mb-4 flex flex-wrap justify-end gap-2">
          <button
            type="button"
            class="rounded-xl border border-zinc-200 px-3 py-2 text-sm dark:border-zinc-700"
            onClick={() => void handleCopyShareLink()}
          >
            {t('groupsInviteCopyShare')}
          </button>
          <button
            type="button"
            class="rounded-xl bg-sky-600 px-4 py-2 text-sm font-semibold text-white"
            onClick={() => setInviteOpen(false)}
          >
            {t('groupsCancel')}
          </button>
        </div>
      </GroupModal>

      <GroupModal open={settingsOpen} title={t('groupsSettings')} onClose={() => setSettingsOpen(false)}>
        {/* UX-GROUPS-8：四个分区 Tab；每屏只看一块，避免超长滚动 */}
        <div
          class="mb-3 flex flex-wrap gap-1.5"
          role="tablist"
          aria-label={t('groupsSettings')}
          data-testid="group-settings-tabs"
        >
          {(
            [
              ['info', 'groupsSettingsTabInfo'],
              ['notice', 'groupsSettingsTabNotice'],
              ['members', 'groupsSettingsTabMembers'],
              ['privacy', 'groupsSettingsTabPrivacy'],
            ] as const
          ).map(([tab, labelKey]) => (
            <button
              key={tab}
              type="button"
              role="tab"
              aria-selected={settingsTab === tab}
              class={`rounded-full border px-3 py-1 text-xs font-semibold transition ${
                settingsTab === tab
                  ? 'border-sky-500 bg-sky-50 text-sky-700 dark:border-sky-600 dark:bg-sky-950/40 dark:text-sky-200'
                  : 'border-zinc-300 bg-white text-zinc-700 hover:bg-zinc-50 dark:border-zinc-600 dark:bg-zinc-900 dark:text-zinc-200 dark:hover:bg-zinc-800'
              }`}
              onClick={() => setSettingsTab(tab)}
              data-testid={`group-settings-tab-${tab}`}
            >
              {t(labelKey)}
              {tab === 'members' && joinRequests.length > 0 ? (
                <span class="ml-1 rounded-full bg-rose-500 px-1 text-[10px] font-bold text-white">
                  {joinRequests.length}
                </span>
              ) : null}
            </button>
          ))}
        </div>
        <p class="mb-2 text-sm text-zinc-600 dark:text-zinc-400">
          {t('groupsSettingsSyncStatus')}：
          {selectedGroup?.role !== 'owner' && selectedGroup?.sync_tier === 'unsynced'
            ? t('groupsSyncUnsyncedDetail')
            : t('groupsSyncActive')}
        </p>
        {selectedGroup ? (
          <>
            {/* OWNER-KEY-6：密钥与隐私（全员可见，灰色说明、不恐吓） */}
            <div class={settingsTab === 'privacy' ? '' : 'hidden'}>
              <section class="mb-4" data-testid="group-owner-key-privacy-section">
                <p class="mb-2 border-b border-zinc-200 pb-1 text-[11px] font-medium uppercase tracking-wider text-zinc-500 dark:border-zinc-700 dark:text-zinc-400">
                  {t('groupsOwnerKeyPrivacyTitle')}
                </p>
                <p class="rounded-lg border border-zinc-300 bg-zinc-50 px-2.5 py-2 text-xs leading-relaxed text-zinc-700 dark:border-zinc-600 dark:bg-zinc-900/50 dark:text-zinc-300">
                  {t('groupsOwnerKeySettingsPrivacy')}
                </p>
                {/* EPOCH-UX-1：换钥进度与一键密封（仅管理员可见；原在群管权限段，UX-GROUPS-8 移到密钥分区） */}
                {isGroupModerator(selectedGroup) && isTruthyFlag(selectedGroup.rekey_scheduled) ? (
                  <div class="mt-3 rounded-xl border border-zinc-300 bg-zinc-50 p-3 dark:border-zinc-600 dark:bg-zinc-900/60">
                    <p class="mb-2 text-sm font-medium text-zinc-800 dark:text-zinc-100">
                      {t('groupsRekeySectionTitle')}
                    </p>
                    <p class="mb-1 text-xs text-zinc-600 dark:text-zinc-400">
                      {t('groupsRekeyDhProgress', undefined, {
                        ready: selectedGroup.rekey_dh_ready ?? 0,
                        total: selectedGroup.rekey_members_total ?? 0,
                      })}
                    </p>
                    <p class="mb-3 text-xs text-zinc-600 dark:text-zinc-400">
                      {t('groupsRekeyWrapProgress', undefined, {
                        ready: rekeyProgress?.ready ?? selectedGroup.rekey_wraps_ready ?? 0,
                        total: rekeyProgress?.total ?? selectedGroup.rekey_members_total ?? 0,
                      })}
                    </p>
                    <button
                      type="button"
                      class="rounded-xl border border-zinc-400 bg-white px-3 py-1.5 text-xs font-semibold text-zinc-800 hover:bg-zinc-100 disabled:cursor-not-allowed disabled:opacity-50 dark:border-zinc-500 dark:bg-zinc-950 dark:text-zinc-100 dark:hover:bg-zinc-800"
                      disabled={rekeyBusy}
                      onClick={() => void handleRekeyCommit()}
                    >
                      {rekeyBusy
                        ? t('groupsRekeyCommitting', undefined, {
                            ready: rekeyProgress?.ready ?? 0,
                            total: rekeyProgress?.total ?? 0,
                          })
                        : t('groupsRekeyCommit')}
                    </button>
                  </div>
                ) : null}
              </section>
            </div>
            {/* UX-GROUPS-7h：群主专属分组（仅群主显示；群名块仅在这里以可编辑形态出现） */}
            {selectedGroup.role === 'owner' ? (
              <div class={settingsTab === 'info' ? '' : 'hidden'}>
                <section class="mb-4">
                  <p class="mb-2 border-b border-zinc-200 pb-1 text-[11px] font-medium uppercase tracking-wider text-zinc-500 dark:border-zinc-700 dark:text-zinc-400">
                    {t('groupsSettingsSectionOwner')}
                  </p>
                  <p class="mb-1 text-xs font-medium text-zinc-600 dark:text-zinc-400">
                    {t('groupsSettingsNameLabel')}
                  </p>
                  <input
                    type="text"
                    maxLength={64}
                    placeholder={t('groupsSettingsNamePlaceholder')}
                    class="mb-3 w-full rounded-xl border border-zinc-200 px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-950"
                    value={settingsName}
                    onInput={(e) => setSettingsName((e.target as HTMLInputElement).value)}
                  />
                </section>
              </div>
            ) : null}
            {/* UX-GROUPS-7h：群管权限分组（永远渲染以保持 7c 普通成员可读公告的契约；moderator 看 textarea，其他看只读）
                UX-GROUPS-8：拆成「群公告」「成员与审批」两个分区，切 Tab 只显示其中一块 */}
            <div class={settingsTab === 'notice' || settingsTab === 'members' ? '' : 'hidden'}>
            <section class="mb-4">
              <p class="mb-2 border-b border-zinc-200 pb-1 text-[11px] font-medium uppercase tracking-wider text-zinc-500 dark:border-zinc-700 dark:text-zinc-400">
                {t('groupsSettingsSectionModerator')}
              </p>
              <div class={settingsTab === 'notice' ? '' : 'hidden'}>
              {/* UX-GROUPS-7c：群公告编辑（群主+管理员可改；普通成员只读） */}
              <p class="mb-1 text-xs font-medium text-zinc-600 dark:text-zinc-400">
                {t('groupsSettingsAnnouncementLabel')}
              </p>
              {isGroupModerator(selectedGroup) ? (
                <>
                  <textarea
                    rows={3}
                    maxLength={512}
                    placeholder={t('groupsSettingsAnnouncementPlaceholder')}
                    class="mb-1 w-full resize-y rounded-xl border border-zinc-200 px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-950"
                    value={settingsAnnouncement}
                    onInput={(e) => setSettingsAnnouncement((e.target as HTMLTextAreaElement).value)}
                  />
                  <div class="mb-3 flex justify-end">
                    <button
                      type="button"
                      class="rounded-xl border border-sky-500 bg-white px-3 py-1.5 text-xs font-semibold text-sky-700 hover:bg-sky-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-sky-600 dark:bg-zinc-900 dark:text-sky-300 dark:hover:bg-sky-950/40"
                      disabled={savingAnnouncement || settingsAnnouncement.trim() === originalAnnouncement}
                      onClick={() => void handleSaveAnnouncement()}
                    >
                      {savingAnnouncement ? t('groupsSaving') : t('groupsSettingsAnnouncementSave')}
                    </button>
                  </div>
                </>
              ) : (
                <>
                  <p class="mb-1 whitespace-pre-wrap break-words rounded-xl border border-zinc-200 bg-zinc-50 px-3 py-2 text-sm text-zinc-700 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300">
                    {settingsAnnouncement || '—'}
                  </p>
                  <p class="mb-3 text-xs text-zinc-500 dark:text-zinc-400">
                    {t('groupsSettingsAnnouncementReadOnly')}
                  </p>
                </>
              )}
              </div>
              <div class={settingsTab === 'members' ? '' : 'hidden'}>
              {/* UX-GROUPS-7d + UX-7h：群成员管理、群禁言（仅 moderator 渲染；普通成员看到分组标签但块内为空）
                  REL-FIX-6：加入申请区在下方独立渲染，允许「跨节点管理员探测成功」也可见。 */}
              {isGroupModerator(selectedGroup) ? (
                <>
                  <div class="mb-3 rounded-xl border border-zinc-200 p-3 dark:border-zinc-700">
                    <p class="mb-2 text-sm font-medium">{t('groupsMembersTitle')}</p>
                    {(() => {
                      // EPOCH-UX-2：主/管可见待密钥人数（只计数，不列 URL / 邮箱）
                      const pendingKeyCount = groupMembers.filter(
                        (m) => m.status === 'active' && m.key_state === 'pending_key',
                      ).length;
                      if (groupMembersLoading || pendingKeyCount === 0) return null;
                      return (
                        <div
                          class="mb-2 rounded-lg border border-zinc-300 bg-zinc-50 px-2 py-1.5 text-xs text-zinc-700 dark:border-zinc-600 dark:bg-zinc-900/50 dark:text-zinc-300"
                          data-testid="group-pending-key-admin-tip"
                        >
                          <p>{t('groupsKeyPendingAdminTip', undefined, { count: pendingKeyCount })}</p>
                          <button
                            type="button"
                            class="mt-2 rounded-lg border border-zinc-400 bg-white px-2.5 py-1 text-xs font-semibold text-zinc-800 hover:bg-zinc-100 disabled:cursor-not-allowed disabled:opacity-50 dark:border-zinc-500 dark:bg-zinc-950 dark:text-zinc-100 dark:hover:bg-zinc-800"
                            disabled={sealPendingBusy}
                            data-testid="group-seal-pending-btn"
                            onClick={() => void handleSealPendingKeys()}
                          >
                            {sealPendingBusy ? t('groupsSealPendingBusy') : t('groupsSealPendingNow')}
                          </button>
                        </div>
                      );
                    })()}
                    {/* GRP-MEMBER-PAGE-1：大群按昵称 / handle 过滤；渲染上限 300 行，避免一次性铺满 DOM */}
                    <div class="mb-2">
                      <input
                        type="text"
                        class="w-full rounded-xl border border-zinc-200 px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-950"
                        placeholder={t('groupsMembersSearchPlaceholder')}
                        value={settingsMemberFilter}
                        onInput={(e) =>
                          setSettingsMemberFilter((e.target as HTMLInputElement).value)
                        }
                        data-testid="group-settings-member-filter"
                      />
                      {settingsMemberRows.matched > settingsMemberRows.shown.length ? (
                        <p class="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
                          {t('groupsMembersCapHint', undefined, {
                            total: String(settingsMemberRows.matched),
                            shown: String(settingsMemberRows.shown.length),
                          })}
                        </p>
                      ) : null}
                    </div>
                    {groupMembersLoading ? (
                      <p class="text-xs text-zinc-500">{t('groupsLoading')}</p>
                    ) : settingsMemberRows.matched === 0 ? (
                      <p class="text-xs text-zinc-500">
                        {settingsMemberFilter.trim()
                          ? t('groupsMembersNoMatch')
                          : t('groupsMembersEmpty')}
                      </p>
                    ) : (
                      <ul class="space-y-2">
                        {settingsMemberRows.shown.map((m) => {
                          const isOwnerRow = m.role === 'owner';
                          const busy = adminSavingUrl === m.member_worker_b_url;
                          // GRP-NICKNAME-1：设置页同样优先显示群昵称，handle 退到第二行
                          const nickname =
                            memberNicknames[m.member_handle.trim().toLowerCase()] ?? '';
                          const roleLabel = isOwnerRow
                            ? t('groupsMemberRoleOwner')
                            : m.is_admin
                              ? t('groupsMemberRoleAdmin')
                              : t('groupsMemberRoleMember');
                          const pendingKey =
                            m.status === 'active' && m.key_state === 'pending_key';
                          return (
                            <li
                              key={m.member_worker_b_url}
                              class="flex flex-wrap items-center justify-between gap-2 text-sm"
                            >
                              <span class="min-w-0">
                                <span class="font-medium">{nickname || m.member_handle}</span>
                                {nickname ? (
                                  <span class="ml-2 text-xs text-zinc-500">
                                    @{m.member_handle}
                                  </span>
                                ) : null}
                                <span class="ml-2 text-xs text-zinc-500">{roleLabel}</span>
                                {pendingKey ? (
                                  <span class="ml-2 text-xs text-zinc-500 dark:text-zinc-400">
                                    {t('groupsKeyPendingMemberBadge')}
                                  </span>
                                ) : null}
                              </span>
                              <span class="flex flex-wrap gap-2">
                                {isGroupOwner(selectedGroup) && !isOwnerRow && m.status === 'active' ? (
                                  <button
                                    type="button"
                                    class="rounded-lg border border-zinc-300 px-2 py-1 text-xs dark:border-zinc-600"
                                    disabled={busy}
                                    onClick={() => void handleAdminChange(m.member_worker_b_url, !m.is_admin)}
                                  >
                                    {m.is_admin ? t('groupsUnsetAdmin') : t('groupsSetAdmin')}
                                  </button>
                                ) : null}
                                {!isOwnerRow &&
                                m.status === 'active' &&
                                (isGroupOwner(selectedGroup) || !m.is_admin) ? (
                                  <button
                                    type="button"
                                    class="rounded-lg border border-rose-300 px-2 py-1 text-xs text-rose-700 dark:border-rose-800 dark:text-rose-300"
                                    disabled={busy}
                                    onClick={() => void handleKickMember(m.member_worker_b_url)}
                                  >
                                    {t('groupsKick')}
                                  </button>
                                ) : null}
                              </span>
                            </li>
                          );
                        })}
                      </ul>
                    )}
                  </div>
                  <div class="mb-3 rounded-xl border border-zinc-200 p-3 dark:border-zinc-700">
                    <label class="flex cursor-pointer items-start gap-2 text-sm">
                      <input
                        type="checkbox"
                        class="mt-0.5"
                        checked={isTruthyFlag(selectedGroup.members_muted)}
                        disabled={muteSaving}
                        onChange={(e) =>
                          void handleMuteChange((e.target as HTMLInputElement).checked)
                        }
                      />
                      <span>
                        <span class="font-medium">{t('groupsMuteLabel')}</span>
                        <span class="mt-0.5 block text-xs text-zinc-500 dark:text-zinc-400">
                          {t('groupsMuteHint')}
                        </span>
                      </span>
                    </label>
                  </div>
                </>
              ) : null}
              {/* REL-FIX-6：加入申请区独立渲染。
                  群主 / 本机管理员（is_admin=1）/ 跨节点管理员（remoteAdminVerified）三种情况可见；
                  普通成员不可见（避免暴露审批入口）。 */}
              {isGroupModerator(selectedGroup) || remoteAdminVerified ? (
                <div
                  class={`mb-3 rounded-xl border p-3 ${
                    pendingHighlight
                      ? 'border-rose-300 bg-rose-50/60 dark:border-rose-800 dark:bg-rose-950/20'
                      : 'border-zinc-200 dark:border-zinc-700'
                  }`}
                  data-testid="group-join-requests-section"
                >
                  <p class="mb-2 text-sm font-medium">{t('groupsJoinRequestsTitle')}</p>
                  {joinRequestsLoading ? (
                    <p class="text-xs text-zinc-500">{t('groupsLoading')}</p>
                  ) : joinRequests.length === 0 ? (
                    <p class="text-xs text-zinc-500">{t('groupsJoinRequestsEmpty')}</p>
                  ) : (
                    <ul class="space-y-2">
                      {joinRequests.map((r) => {
                        // REL-FIX-9：该行正在审批 → 两个按钮禁用并显示「处理中…」
                        const rowBusy = processingMemberUrl === r.member_worker_b_url;
                        return (
                          <li
                            key={r.member_worker_b_url}
                            class="flex flex-wrap items-center justify-between gap-2 text-sm"
                          >
                            <span class="min-w-0 truncate font-medium">{r.member_handle}</span>
                            <span class="flex gap-2">
                              <button
                                type="button"
                                class="rounded-lg bg-sky-600 px-2 py-1 text-xs text-white disabled:opacity-50"
                                disabled={rowBusy}
                                onClick={() => void handleJoinRequest('approve', r.member_worker_b_url)}
                              >
                                {rowBusy ? t('groupsJoinRequestProcessing') : t('groupsJoinRequestApprove')}
                              </button>
                              <button
                                type="button"
                                class="rounded-lg border border-zinc-300 px-2 py-1 text-xs disabled:opacity-50 dark:border-zinc-600"
                                disabled={rowBusy}
                                onClick={() => void handleJoinRequest('reject', r.member_worker_b_url)}
                              >
                                {rowBusy ? t('groupsJoinRequestProcessing') : t('groupsJoinRequestReject')}
                              </button>
                            </span>
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </div>
              ) : null}
              </div>
            </section>
            </div>
            {/* UX-GROUPS-7h：基本信息分组（永远显示；非群主态群名只读放这里） */}
            <div class={settingsTab === 'info' ? '' : 'hidden'}>
            <section class="mb-4">
              <p class="mb-2 border-b border-zinc-200 pb-1 text-[11px] font-medium uppercase tracking-wider text-zinc-500 dark:border-zinc-700 dark:text-zinc-400">
                {t('groupsSettingsSectionGeneral')}
              </p>
              {/* 非群主态：群名以只读形态放基本信息里，避免和群主专属块重复 */}
              {selectedGroup.role !== 'owner' ? (
                <>
                  <p class="mb-1 text-xs font-medium text-zinc-600 dark:text-zinc-400">
                    {t('groupsSettingsNameLabel')}
                  </p>
                  <p class="mb-1 break-all rounded-xl border border-zinc-200 bg-zinc-50 px-3 py-2 text-sm text-zinc-700 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300">
                    {selectedGroup.name}
                  </p>
                  <p class="mb-3 text-xs text-zinc-500 dark:text-zinc-400">
                    {t('groupsSettingsNameReadOnly')}
                  </p>
                </>
              ) : null}
              <p class="mb-1 text-xs font-medium text-zinc-600 dark:text-zinc-400">
                {t('groupsInviteGroupIdLabel')}
              </p>
              <p class="mb-3 break-all font-mono text-sm">{selectedGroup.group_id}</p>
              {/* GRP-NICKNAME-1：本群昵称（每位成员自设，只存本机，随消息密文下发，不写节点资料） */}
              <label class="mb-1 block text-sm font-medium" for="group-nickname-input">
                {t('groupsNicknameLabel')}
              </label>
              <div class="mb-1 flex gap-2">
                <input
                  id="group-nickname-input"
                  type="text"
                  maxLength={GROUP_NICKNAME_MAX}
                  class="min-w-0 flex-1 rounded-xl border border-zinc-200 px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-950"
                  value={settingsNickname}
                  placeholder={t('groupsNicknamePlaceholder')}
                  onInput={(e) => {
                    setSettingsNickname((e.target as HTMLInputElement).value);
                    setNicknameSaved(false);
                  }}
                />
                <button
                  type="button"
                  class="shrink-0 rounded-xl bg-zinc-800 px-3 py-2 text-xs font-semibold text-white hover:bg-zinc-700 dark:bg-zinc-200 dark:text-zinc-900 dark:hover:bg-white"
                  onClick={handleSaveNickname}
                >
                  {t('groupsNicknameSave')}
                </button>
              </div>
              <p class="mb-3 text-xs text-zinc-500 dark:text-zinc-400" role="status">
                {nicknameSaved ? t('groupsNicknameSaved') : t('groupsNicknameHint')}
              </p>
              <label class="mb-2 block text-sm font-medium">{t('groupsSettingsRetentionLabel')}</label>
              {loadingCapacity ? (
                <p class="mb-3 text-xs text-zinc-500 dark:text-zinc-400">{t('groupsSettingsCapacityLoading')}</p>
              ) : messagingCapacity && messagingCapacity.tier !== 'normal' ? (
                <div
                  class={`mb-3 rounded-xl border px-3 py-2 text-xs ${
                    messagingCapacity.tier === 'hard'
                      ? 'border-amber-500/60 bg-amber-50 text-amber-900 dark:border-amber-500/40 dark:bg-amber-950/40 dark:text-amber-100'
                      : 'border-yellow-500/60 bg-yellow-50 text-yellow-900 dark:border-yellow-500/40 dark:bg-yellow-950/40 dark:text-yellow-100'
                  }`}
                  role="status"
                >
                  {messagingCapacity.tier === 'hard'
                    ? t('groupsSettingsCapacityHard', undefined, {
                        mb: String(messagingCapacity.estimated_mb),
                        hard: String(messagingCapacity.hard_threshold_mb),
                      })
                    : t('groupsSettingsCapacityWarn', undefined, {
                        mb: String(messagingCapacity.estimated_mb),
                        warn: String(messagingCapacity.warn_threshold_mb),
                      })}
                  {messagingCapacity.shard_available && messagingCapacity.auto_shard_enabled ? (
                    <p class="mt-2 border-t border-current/20 pt-2">
                      {t('groupsSettingsCapacityAutoShard')}
                      {messagingCapacity.total_estimated_mb > messagingCapacity.estimated_mb ? (
                        <span class="mt-1 block opacity-90">
                          {t('groupsSettingsCapacityTotalHint', undefined, {
                            total: String(messagingCapacity.total_estimated_mb),
                          })}
                        </span>
                      ) : null}
                      {messagingCapacity.auto_shard_pending_groups_on_primary > 0 ||
                      messagingCapacity.auto_shard_last_migrated_group_id ? (
                        <span class="mt-1 block opacity-90">
                          {t('groupsSettingsCapacityAutoShardPending', undefined, {
                            pending: String(messagingCapacity.auto_shard_pending_groups_on_primary),
                            groupId: messagingCapacity.auto_shard_last_migrated_group_id ?? '—',
                            at: messagingCapacity.auto_shard_last_migrated_at ?? '—',
                          })}
                        </span>
                      ) : null}
                      {messagingCapacity.auto_shard_last_error ? (
                        <span class="mt-1 block text-rose-700 dark:text-rose-300">
                          {t('groupsSettingsCapacityAutoShardError', undefined, {
                            error: messagingCapacity.auto_shard_last_error,
                            at: messagingCapacity.auto_shard_last_error_at ?? '—',
                          })}
                        </span>
                      ) : null}
                    </p>
                  ) : null}
                </div>
              ) : messagingCapacity ? (
                <p class="mb-3 text-xs text-zinc-500 dark:text-zinc-400">
                  {t('groupsSettingsCapacityNormal', undefined, {
                    mb: String(messagingCapacity.estimated_mb),
                    limit: String(messagingCapacity.limit_mb),
                  })}
                  {messagingCapacity.shard_available &&
                  messagingCapacity.total_estimated_mb > messagingCapacity.estimated_mb ? (
                    <span class="mt-1 block">
                      {t('groupsSettingsCapacityTotalHint', undefined, {
                        total: String(messagingCapacity.total_estimated_mb),
                      })}
                    </span>
                  ) : null}
                </p>
              ) : null}
              {/* UX-GROUPS-7：保留天数仅群主/群管理可改，普通成员看到只读输入 + 提示文案 */}
              {isGroupModerator(selectedGroup) ? (
                <input
                  type="number"
                  min={1}
                  max={365}
                  class="mb-3 w-full rounded-xl border border-zinc-200 px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-950"
                  value={settingsRetention}
                  onInput={(e) => setSettingsRetention((e.target as HTMLInputElement).value)}
                />
              ) : (
                <>
                  <input
                    type="number"
                    min={1}
                    max={365}
                    disabled
                    class="mb-1 w-full cursor-not-allowed rounded-xl border border-zinc-200 bg-zinc-50 px-3 py-2 text-sm text-zinc-500 dark:border-zinc-700 dark:bg-zinc-900/50 dark:text-zinc-400"
                    value={settingsRetention}
                    readOnly
                  />
                  <p class="mb-3 text-xs text-zinc-500 dark:text-zinc-400">
                    {t('groupsSettingsRetentionReadOnly')}
                  </p>
                </>
              )}
              {/* 仅群主：加入策略（closed/approval/open） */}
              {selectedGroup.role === 'owner' ? (
                <>
                  <p class="mb-2 text-xs font-medium text-zinc-600 dark:text-zinc-400">
                    {t('groupsInvitePolicyLabel')}
                  </p>
                  <div class="mb-3 flex flex-col gap-2">
                    {(
                      [
                        ['approval', 'groupsInvitePolicyApproval'],
                        ['open', 'groupsInvitePolicyOpen'],
                        ['closed', 'groupsInvitePolicyClosed'],
                      ] as const
                    ).map(([value, labelKey]) => (
                      <label key={value} class="flex cursor-pointer items-center gap-2 text-sm">
                        <input
                          type="radio"
                          name="settings-join-policy"
                          checked={resolveJoinPolicy(selectedGroup) === value}
                          disabled={sharePolicySaving}
                          onChange={() => void handleSharePolicyChange(value)}
                        />
                        <span>{t(labelKey)}</span>
                      </label>
                    ))}
                  </div>
                </>
              ) : null}
            </section>
            </div>
          </>
        ) : null}
        <div class="flex flex-wrap justify-end gap-2">
          <button type="button" class="rounded-xl px-3 py-2 text-sm" onClick={() => setSettingsOpen(false)}>
            {t('groupsCancel')}
          </button>
          {/* UX-GROUPS-7b：群主态下"保存群名称"按钮置左，与"保存保留天数"并列；其他身份只显示保留天数按钮。 */}
          {settingsTab === 'info' &&
          selectedGroup &&
          selectedGroup.role === 'owner' &&
          settingsName.trim() !== originalName ? (
            <button
              type="button"
              class="rounded-xl border border-sky-500 bg-white px-4 py-2 text-sm font-semibold text-sky-700 hover:bg-sky-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-sky-600 dark:bg-zinc-900 dark:text-sky-300 dark:hover:bg-sky-950/40"
              disabled={savingName}
              onClick={() => void handleSaveName()}
            >
              {savingName ? t('groupsSaving') : t('groupsSettingsNameSave')}
            </button>
          ) : null}
          {/* UX-GROUPS-7：保存按钮在普通成员下隐藏（无保存语义）；群主/群管理下保留。 */}
          {settingsTab === 'info' && selectedGroup && isGroupModerator(selectedGroup) ? (
            <button
              type="button"
              class="rounded-xl bg-sky-600 px-4 py-2 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-50"
              disabled={savingSettings}
              onClick={() => void handleSaveSettings()}
            >
              {savingSettings ? t('groupsSaving') : t('groupsSettingsSave')}
            </button>
          ) : null}
        </div>
      </GroupModal>

      <ConfirmDialog
        open={groupConfirmKind === 'leave'}
        pending={leaving}
        title={t('groupsLeaveDialogTitle')}
        body={<p>{t('groupsLeaveConfirm')}</p>}
        cancelLabel={t('groupsLeaveDialogCancel')}
        confirmLabel={t('groupsLeaveDialogConfirm')}
        confirmPendingLabel={t('groupsLeaveDialogPending')}
        icon={<LogOut size={20} strokeWidth={2} aria-hidden="true" />}
        confirmClassName="rounded-full bg-rose-600 px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-rose-700 disabled:cursor-wait disabled:opacity-70 dark:bg-rose-500 dark:hover:bg-rose-400"
        onCancel={() => {
          if (!leaving) setGroupConfirmKind(null);
        }}
        onConfirm={() => void confirmLeaveGroup()}
      />

      <ConfirmDialog
        open={groupConfirmKind === 'dissolve'}
        pending={dissolving}
        title={t('groupsDissolveDialogTitle')}
        body={<p>{t('groupsDissolveConfirm')}</p>}
        cancelLabel={t('groupsDissolveDialogCancel')}
        confirmLabel={t('groupsDissolveDialogConfirm')}
        confirmPendingLabel={t('groupsDissolveDialogPending')}
        icon={<Trash2 size={20} strokeWidth={2} aria-hidden="true" />}
        confirmClassName="rounded-full bg-rose-600 px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-rose-700 disabled:cursor-wait disabled:opacity-70 dark:bg-rose-500 dark:hover:bg-rose-400"
        onCancel={() => {
          if (!dissolving) setGroupConfirmKind(null);
        }}
        onConfirm={() => void confirmDissolveGroup()}
      />
    </div>
  );
}
