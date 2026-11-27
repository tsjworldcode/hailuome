/** @jsxImportSource preact */
import type { LocalGroupItem } from '../lib/workerA';
import { formatRelativeTime } from '../lib/timeFormat';
import { t } from '../lib/i18n';

export interface GroupListItemPreview {
  readonly preview: string | null;
  readonly lastAt: string | null;
}

export interface GroupListPanelProps {
  readonly groups: readonly LocalGroupItem[];
  readonly selectedGroupId: string | null;
  readonly selectedIsOwner: boolean;
  readonly selectedDissolved: boolean;
  readonly previews: Readonly<Record<string, GroupListItemPreview>>;
  readonly onSelect: (groupId: string) => void;
  readonly onCreateClick: () => void;
  readonly onJoinClick: () => void;
  readonly onLeaveClick: () => void;
  readonly onSettingsClick: () => void;
  readonly onDissolveClick: () => void;
  /** UX-GROUPS-9：点「N 条待审批」直接打开该群的审批页 */
  readonly onOpenJoinRequests: (groupId: string) => void;
}

function groupAvatarLetter(name: string): string {
  const trimmed = name.trim();
  return (trimmed.charAt(0) || '?').toUpperCase();
}

function groupAvatarHue(seed: string): number {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return h % 360;
}

/** UX-GROUPS-4：左侧窗格（无独立外框，由父级单框承载）。 */
export function GroupListPanel({
  groups,
  selectedGroupId,
  selectedIsOwner,
  selectedDissolved,
  previews,
  onSelect,
  onCreateClick,
  onJoinClick,
  onLeaveClick,
  onDissolveClick,
  onOpenJoinRequests,
}: GroupListPanelProps) {
  return (
    <section class="flex h-full min-h-0 w-full flex-col overflow-hidden bg-gradient-to-b from-slate-50 to-white dark:from-zinc-900 dark:to-zinc-950">
      <div class="border-b border-zinc-200/80 px-3 py-3 dark:border-zinc-700">
        <div class="mb-2 flex items-baseline justify-between gap-2 px-1">
          <h1 class="text-base font-bold text-zinc-950 dark:text-white">{t('groupsTitle')}</h1>
          <p class="shrink-0 text-[11px] text-zinc-500 dark:text-zinc-400">
            {t('groupsListCount', undefined, { count: groups.length })}
          </p>
        </div>
        <div class="grid grid-cols-2 gap-2">
          <button
            type="button"
            class="rounded-xl bg-gradient-to-br from-sky-500 to-sky-600 px-3 py-2 text-sm font-semibold text-white shadow-sm shadow-sky-500/25 hover:from-sky-600 hover:to-sky-700"
            onClick={onCreateClick}
          >
            {t('groupsCreate')}
          </button>
          <button
            type="button"
            class="rounded-xl border border-sky-200 bg-sky-50/90 px-3 py-2 text-sm font-medium text-sky-800 hover:bg-sky-100 dark:border-sky-800 dark:bg-sky-950/40 dark:text-sky-200 dark:hover:bg-sky-950/70"
            onClick={onJoinClick}
          >
            {t('groupsJoin')}
          </button>
        </div>
        {/* UX-GROUPS-7：群设置已迁至聊天面板顶部（GroupChatPanel header 内的「群设置」按钮），
            依赖当前用户在该群的身份（群主 / 群管理 / 普通群成员）显示不同管理项；
            左侧三宫格仅保留「退群 / 解散」两个群生命周期按钮，UI 更聚焦。 */}
        <div class="mt-2 grid grid-cols-2 gap-1.5">
          <button
            type="button"
            class="rounded-lg border border-zinc-300 bg-white px-1.5 py-1.5 text-[11px] hover:bg-zinc-50 disabled:opacity-40 dark:border-zinc-600 dark:bg-zinc-900 dark:hover:bg-zinc-800"
            disabled={!selectedGroupId || selectedIsOwner}
            onClick={onLeaveClick}
          >
            {t('groupsLeave')}
          </button>
          <button
            type="button"
            class="rounded-lg border border-rose-300 bg-rose-50 px-1.5 py-1.5 text-[11px] text-rose-800 hover:bg-rose-100 disabled:opacity-40 dark:border-rose-900 dark:bg-rose-950/40 dark:text-rose-200 dark:hover:bg-rose-950/70"
            disabled={!selectedGroupId || !selectedIsOwner || selectedDissolved}
            onClick={onDissolveClick}
          >
            {t('groupsDissolve')}
          </button>
        </div>
      </div>

      {groups.length === 0 ? (
        <div class="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center text-sm text-zinc-500 dark:text-zinc-400">
          <p>{t('groupsEmptyList')}</p>
          <p class="text-xs">{t('groupsPlanHint')}</p>
        </div>
      ) : (
        <ul class="hailuo-chat-list bg-gradient-to-b from-slate-100/70 to-emerald-50/50 dark:from-zinc-950 dark:to-zinc-900">
          {groups.map((g) => {
            const meta = previews[g.group_id];
            const dissolved = Boolean(g.dissolved_at);
            const unsynced = g.role !== 'owner' && g.sync_tier === 'unsynced';
            const selected = selectedGroupId === g.group_id;
            const hue = groupAvatarHue(g.group_id || g.name);
            // REL-FIX-5：待审批入群申请数（仅群主侧 > 0；成员节点恒 0）。
            const pendingCount = Number(g.pending_join_count ?? 0);
            return (
              <li key={g.group_id}>
                {/* 用 div + role 承载整行，避免「待审批」按钮嵌在 button 里（非法 HTML） */}
                <div
                  role="button"
                  tabIndex={0}
                  class={`hailuo-chat-row cursor-pointer ${
                    selected ? 'hailuo-chat-row-selected' : 'hailuo-chat-row-idle'
                  } ${dissolved ? 'opacity-60' : ''}`}
                  onClick={() => onSelect(g.group_id)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      onSelect(g.group_id);
                    }
                  }}
                >
                  <span
                    class="flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-sm font-bold text-white shadow-md ring-2 ring-white dark:ring-zinc-800"
                    style={{ backgroundColor: `hsl(${hue}, 58%, 50%)` }}
                    aria-hidden="true"
                  >
                    {groupAvatarLetter(g.name)}
                  </span>
                  <div class="min-w-0 flex-1">
                    <div class="flex items-start justify-between gap-2">
                      <span class="truncate font-semibold text-zinc-900 dark:text-zinc-50">{g.name}</span>
                      {meta?.lastAt && (
                        <span class="shrink-0 text-[10px] text-zinc-500">
                          {formatRelativeTime(meta.lastAt)}
                        </span>
                      )}
                    </div>
                    {meta?.preview ? (
                      <p class="mt-0.5 truncate text-xs text-zinc-500 dark:text-zinc-400">{meta.preview}</p>
                    ) : (
                      <p class="mt-0.5 truncate text-xs text-fg3">
                        {t('groupsNoMessages')}
                      </p>
                    )}
                    {typeof g.member_count === 'number' ? (
                      <p class="mt-0.5 text-[11px] text-zinc-500 dark:text-zinc-400">
                        {t('groupsMemberCount', undefined, { count: g.member_count })}
                      </p>
                    ) : null}
                    <div class="mt-1 flex flex-wrap gap-1">
                      {/* REL-FIX-5：待审批入群申请角标。
                          群主不进群设置也能看到有申请在等；只显示**数量**，不显示申请人 handle/URL。 */}
                      {pendingCount > 0 && (
                        <button
                          type="button"
                          class="rounded bg-rose-100 px-1.5 py-0.5 text-[10px] font-semibold text-rose-700 hover:bg-rose-200 dark:bg-rose-950/50 dark:text-rose-200 dark:hover:bg-rose-950/80"
                          data-testid="group-pending-join-badge"
                          title={t('groupsPendingJoinBadgeHint', undefined, { count: pendingCount })}
                          onClick={(e) => {
                            // 直接进审批，不再要求先进群再翻群设置
                            e.stopPropagation();
                            onOpenJoinRequests(g.group_id);
                          }}
                        >
                          {t('groupsPendingJoinBadge', undefined, { count: pendingCount })}
                        </button>
                      )}
                      {unsynced && (
                        <span class="rounded bg-amber-100 px-1.5 py-0.5 text-[10px] text-amber-900 dark:bg-amber-950/50 dark:text-amber-100">
                          {t('groupsUnsyncedBadge')}
                        </span>
                      )}
                      {dissolved && (
                        <span class="rounded bg-zinc-200 px-1.5 py-0.5 text-[10px] text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300">
                          {t('groupsDissolvedBadge')}
                        </span>
                      )}
                    </div>
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
