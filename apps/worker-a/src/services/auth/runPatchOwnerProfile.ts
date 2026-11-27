/**
 * NCF-2B-5：PATCH /auth/profile 核心（窄 deps，无 Env / Hono）。
 */
import { normalizePatchProfileBody } from './profileUtils';
import type {
  OwnerMeUserRow,
  OwnerPatchProfileCommand,
  OwnerPatchProfileDeps,
  OwnerPatchProfileResult,
  OwnerPatchProfileSuccessData,
} from './types';

async function buildProfileResponseData(
  row: OwnerMeUserRow,
  deps: OwnerPatchProfileDeps,
  fallback: { displayName: string; bio: string; contactEmail: string },
): Promise<OwnerPatchProfileSuccessData> {
  const registryIdentity = await deps.registryIdentity.load();
  const pubkey = row.pubkey ?? '';
  return {
    handle: row.handle,
    display_name: row.display_name ?? fallback.displayName,
    bio: row.bio ?? fallback.bio,
    worker_b_url: row.worker_b_url ?? '',
    avatar_key: row.avatar_key ?? '',
    contact_email: row.contact_email ?? fallback.contactEmail,
    created_at: row.created_at ?? '',
    pubkey,
    dm_pubkey: row.dm_pubkey ?? '',
    registry_user_id: registryIdentity.userId,
    pubkey_fingerprint: await deps.identityResolve.pubkeyFingerprint(
      pubkey,
      registryIdentity.pubkeyFingerprint,
    ),
    did_v2: await deps.identityResolve.didV2(registryIdentity.didV2, pubkey),
    registered: true,
  };
}

export async function runPatchOwnerProfile(
  command: OwnerPatchProfileCommand,
  deps: OwnerPatchProfileDeps,
): Promise<OwnerPatchProfileResult> {
  const normalized = normalizePatchProfileBody(command.body);
  if (!normalized.ok) {
    if (normalized.reason === 'use_registration_profile') {
      return {
        status: 'use_registration_profile',
        httpStatus: 409,
        error_code: 'USE_REGISTRATION_PROFILE',
        message: '出生日期、性别等人口学字段已下架，不能通过公开资料接口更新',
      };
    }
    return {
      status: 'bad_request',
      httpStatus: 400,
      error_code: 'BAD_REQUEST',
      message: '公开资料格式不正确',
    };
  }

  const handle = await deps.userRepo.getOwnerHandle();
  if (!handle) {
    return {
      status: 'not_registered',
      httpStatus: 409,
      error_code: 'USER_NOT_REGISTERED',
      message: '节点尚未完成登记，暂不能编辑公开资料',
    };
  }

  try {
    await deps.userRepo.updateProfile({
      handle,
      displayName: normalized.displayName,
      bio: normalized.bio,
      avatarKey: normalized.avatarKey,
      contactEmail: normalized.contactEmail,
    });
    await deps.publicProfile.syncToKv(handle);
  } catch (err) {
    deps.logger.error('更新公开资料失败', err);
    return {
      status: 'internal_error',
      httpStatus: 500,
      error_code: 'INTERNAL_ERROR',
      message: '更新公开资料失败',
    };
  }

  const updated = await deps.userRepo.loadOwnerUserByHandle(handle);
  if (!updated) {
    return {
      status: 'internal_error',
      httpStatus: 500,
      error_code: 'INTERNAL_ERROR',
      message: '更新公开资料失败',
    };
  }

  return {
    status: 'ok',
    httpStatus: 200,
    data: await buildProfileResponseData(updated, deps, {
      displayName: normalized.displayName,
      bio: normalized.bio,
      contactEmail: normalized.contactEmail,
    }),
  };
}
