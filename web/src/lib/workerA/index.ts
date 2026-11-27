// M-REFACTOR-1b：Worker A 客户端聚合入口
import { createWorkerATransport } from './transport';
import { createAuthApi } from './auth';
import { createBlacklistApi } from './blacklist';
import { createDmApi } from './dm';
import { createFollowsApi } from './follows';
import { createFriendRequestsApi } from './friendRequests';
import { createGroupsApi } from './groups';
import { createInteractionsApi } from './interactions';
import { createMediaApi } from './media';
import { createMessagingMediaApi } from './messagingMedia';
import { createNodeApi } from './node';
import { createOperationLogsApi } from './operationLogs';
import { createOwnerVaultApi } from './ownerVault';
import { createPostsApi } from './posts';
import { createPrivateNotesApi } from './privateNotes';
import { createRegistryApi } from './registry';
import { createRegistrySyncApi } from './registrySync';
import { createUrlChangeApi } from './urlChange';
import type { WorkerAClient, WorkerAClientOptions } from './types';

export * from './types';
export type { WorkerATransport } from './transport';
export { buildQuery, createWorkerATransport } from './transport';

export function createWorkerAClient(opts: WorkerAClientOptions): WorkerAClient {
  const t = createWorkerATransport(opts);
  return {
    ...createAuthApi(t),
    ...createBlacklistApi(t),
    ...createDmApi(t),
    ...createFollowsApi(t),
    ...createFriendRequestsApi(t),
    ...createGroupsApi(t),
    ...createInteractionsApi(t),
    ...createMediaApi(t),
    ...createMessagingMediaApi(t),
    ...createNodeApi(t),
    ...createOperationLogsApi(t),
    ...createOwnerVaultApi(t),
    ...createPostsApi(t),
    ...createPrivateNotesApi(t),
    ...createRegistryApi(t),
    ...createRegistrySyncApi(t),
    ...createUrlChangeApi(t),
  } satisfies WorkerAClient;
}
