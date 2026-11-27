/** @jsxImportSource preact */
import type { VNode } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { formatOwnerHandleDisplay } from '../lib/handleDisplay';
import { loadOwnerProfile, ownerProfile, ownerProfileLoading } from '../lib/ownerProfile';
import { initLanguage, t } from '../lib/i18n';
import { PendingCertifyBadge } from './PendingCertifyBadge';
import { buildWorkerBImageUrl } from '../lib/mediaUrls';

function displayLabel(handle: string, displayName: string | null | undefined): string {
  if (displayName?.trim()) return displayName.trim();
  return handle;
}

/** FNV-1a 32-bit：与 PostCard 同算法，仅做头像色相散列。 */
function fnv1a32(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h >>> 0;
}

function avatarHue(seed: string): number {
  return fnv1a32(seed) % 360;
}

/** 取展示名首字（字母大写；汉字/其它字符原样），与 Timeline 色块头像一致。 */
function avatarLetter(label: string): string {
  const c = label.trim().charAt(0);
  if (!c) return '?';
  // 仅 ASCII 字母做大写，避免对汉字/emoji 误用 toUpperCase
  return /[a-zA-Z]/.test(c) ? c.toUpperCase() : c;
}

/** UX-APPLE-1b：窄轨仅头像；lg+ 展开昵称/handle。 */
export function OwnerNavProfile(): VNode {
  useEffect(() => {
    initLanguage();
    void loadOwnerProfile();
  }, []);

  const profile = ownerProfile.value;
  const loading = ownerProfileLoading.value;

  if (loading && !profile) {
    return (
      <div class="mb-3 flex justify-center rounded-2xl p-2 lg:justify-start">
        <div class="h-10 w-10 animate-pulse rounded-full bg-zinc-200 dark:bg-zinc-800" />
      </div>
    );
  }

  if (!profile) return <></>;

  const label = displayLabel(profile.handle, profile.display_name);
  // M9-PH-2：登记后展示正式名（主中心裸名 / 其它 handle@regN）；未登记仍用 @短名
  const handleLine = formatOwnerHandleDisplay(profile);
  const aria = profile.registered
    ? `${label}，${handleLine}`
    : `${label}，${handleLine}，${t('navProfileUnregistered')}`;

  return (
    <a
      href="/profile"
      class="mb-3 flex flex-col items-center gap-1 rounded-2xl p-2 transition hover:bg-zinc-100/80 dark:hover:bg-zinc-900/60 lg:flex-row lg:items-center lg:gap-2 lg:justify-start"
      aria-label={aria}
      title={`${label} ${handleLine}`}
    >
      <OwnerAvatar
        avatarKey={profile.avatar_key}
        workerBUrl={profile.worker_b_url}
        alt={label}
        seed={profile.handle}
      />
      <div class="hidden min-w-0 flex-1 lg:block">
        <div class="truncate text-sm font-semibold text-zinc-900 dark:text-zinc-50">{label}</div>
        <div class="truncate text-xs text-zinc-500 dark:text-zinc-400">{handleLine}</div>
      </div>
      <PendingCertifyBadge compact className="mt-0.5 lg:mt-0" />
    </a>
  );
}

/**
 * UX-LEFTNAV-PROFILE-BOTTOM-FIX：有 avatar_key 时走 Worker B 真图；
 * 缺失或加载失败 → 色相 + 首字（与 PostCard 一致），绝不回退 /favicon.svg。
 * 见 .cursor/rules/09-validation-and-debug.mdc「OwnerNavProfile 头像 / favicon 误用」。
 *
 * UX-LEFTNAV-LETTER-FALLBACK：用户反馈灰色 UserRound 不像「以前那些颜色+字母/汉字」，
 * 故无图时改回 hsl 色块 + 首字，而不是人像线框图标。
 */
function OwnerAvatar({ avatarKey, workerBUrl, alt, seed }: {
  readonly avatarKey: string;
  readonly workerBUrl: string;
  readonly alt: string;
  readonly seed: string;
}): VNode {
  const [errored, setErrored] = useState(false);
  const url = !errored && avatarKey && workerBUrl
    ? buildWorkerBImageUrl(workerBUrl, avatarKey)
    : '';
  if (!url) {
    const hue = avatarHue(seed || alt);
    const letter = avatarLetter(alt || seed);
    return (
      <span
        class="flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-sm font-semibold text-white"
        style={`background-color: hsl(${hue}, 60%, 55%)`}
        aria-hidden="true"
      >
        {letter}
      </span>
    );
  }
  return (
    <img
      src={url}
      alt={alt}
      width={40}
      height={40}
      class="h-10 w-10 shrink-0 rounded-full object-cover"
      onError={() => setErrored(true)}
    />
  );
}
