/**
 * 站主资料缓存（getMe 结果），供侧栏 / 时间线 / 发帖器共享。
 */
import { signal } from '@preact/signals';
import { resolveWorkerAUrl, getOwnerJwt } from './auth';
import { createWorkerAClient, type OwnerProfile } from './workerA';

export const ownerProfile = signal<OwnerProfile | null>(null);
export const ownerProfileLoading = signal<boolean>(false);
export const ownerProfileError = signal<string | null>(null);

let loadPromise: Promise<OwnerProfile | null> | null = null;

/** 拉取或刷新站主资料；并发调用合并为一次请求 */
export async function loadOwnerProfile(force = false): Promise<OwnerProfile | null> {
  const url = await resolveWorkerAUrl();
  const jwt = getOwnerJwt();
  if (!url || !jwt) {
    ownerProfile.value = null;
    return null;
  }

  if (!force && ownerProfile.value) return ownerProfile.value;
  if (!force && loadPromise) return loadPromise;

  ownerProfileLoading.value = true;
  ownerProfileError.value = null;

  loadPromise = (async () => {
    try {
      const client = createWorkerAClient({ baseUrl: url, getJwt: getOwnerJwt });
      const profile = await client.getMe();
      ownerProfile.value = profile;
      return profile;
    } catch {
      ownerProfileError.value = '无法加载站主资料';
      return ownerProfile.value;
    } finally {
      ownerProfileLoading.value = false;
      loadPromise = null;
    }
  })();

  return loadPromise;
}

/** 注册成功后本地更新，避免再等一轮 getMe */
export function patchOwnerProfile(patch: Partial<OwnerProfile>): void {
  const cur = ownerProfile.value;
  if (!cur) return;
  ownerProfile.value = { ...cur, ...patch };
}
