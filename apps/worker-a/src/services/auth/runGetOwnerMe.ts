/**
 * NCF-2B-4：GET /auth/me 核心（窄 deps，无 Env / Hono）。
 */
import type { OwnerMeCommand, OwnerMeDeps, OwnerMeResult, OwnerMeUserRow } from './types';

async function buildRegisteredMeData(
  row: OwnerMeUserRow,
  deps: OwnerMeDeps,
  registryIdentity: Awaited<ReturnType<OwnerMeDeps['registryIdentity']['load']>>,
  followingCount: number,
  mustChange: boolean,
  emailVerified: boolean,
): Promise<OwnerMeResult> {
  const pubkeyFingerprint =
    registryIdentity.pubkeyFingerprint ||
    (await deps.identityResolve.pubkeyFingerprint(row.pubkey, registryIdentity.pubkeyFingerprint));
  const didV2 = await deps.identityResolve.didV2(registryIdentity.didV2, row.pubkey);
  const handleQualified = await deps.identityResolve.handleQualified(
    row.handle,
    registryIdentity.handleQualified,
  );
  return {
    status: 'ok',
    httpStatus: 200,
    data: {
      handle: row.handle,
      handle_qualified: handleQualified || null,
      display_name: row.display_name,
      bio: row.bio,
      worker_b_url: row.worker_b_url,
      avatar_key: row.avatar_key ?? '',
      contact_email: row.contact_email ?? '',
      registration_email: row.registration_email ?? '',
      created_at: row.created_at,
      pubkey: row.pubkey,
      dm_pubkey: row.dm_pubkey ?? '',
      registry_user_id: registryIdentity.userId,
      pubkey_fingerprint: pubkeyFingerprint,
      did_v2: didV2,
      // 是否“已登记”以中心身份为准：仅本地资料行存在不代表登记仍在。
      // 清掉 system_config.owner_user_id / handle_qualified 后应回到可注册态。
      registered: Boolean(registryIdentity.userId || registryIdentity.handleQualified),
      following_count: followingCount,
      email_verified: emailVerified,
      ...(mustChange ? { must_change_credentials: true } : {}),
    },
  };
}

async function buildFallbackMeData(
  command: OwnerMeCommand,
  deps: OwnerMeDeps,
  registryIdentity: Awaited<ReturnType<OwnerMeDeps['registryIdentity']['load']>>,
  followingCount: number,
  mustChange: boolean,
): Promise<OwnerMeResult> {
  const fallbackPubkey = deps.bootstrap.fallbackPubkey();
  const fallbackHandle = deps.bootstrap.fallbackHandle(command.jwtSub);
  return {
    status: 'ok',
    httpStatus: 200,
    data: {
      handle: fallbackHandle,
      handle_qualified: null,
      display_name: '',
      bio: '',
      worker_b_url: deps.bootstrap.workerBUrl(),
      avatar_key: '',
      contact_email: '',
      registration_email: '',
      created_at: '',
      pubkey: fallbackPubkey,
      dm_pubkey: '',
      registry_user_id: registryIdentity.userId,
      pubkey_fingerprint: await deps.identityResolve.pubkeyFingerprint(
        fallbackPubkey,
        registryIdentity.pubkeyFingerprint,
      ),
      did_v2: await deps.identityResolve.didV2(registryIdentity.didV2, fallbackPubkey),
      registered: false,
      following_count: followingCount,
      ...(mustChange ? { must_change_credentials: true } : {}),
    },
  };
}

export async function runGetOwnerMe(
  command: OwnerMeCommand,
  deps: OwnerMeDeps,
): Promise<OwnerMeResult> {
  const [mustChange, registryIdentity, followingCount] = await Promise.all([
    deps.mustChangeRepo.get(),
    deps.registryIdentity.load(),
    deps.userRepo.countFollowing(),
  ]);

  const row = await deps.userRepo.loadOwnerUser();
  if (row) {
    const emailVerified = await deps.profileMeta.emailVerified();
    return buildRegisteredMeData(
      row,
      deps,
      registryIdentity,
      followingCount,
      mustChange,
      emailVerified,
    );
  }

  return buildFallbackMeData(command, deps, registryIdentity, followingCount, mustChange);
}
