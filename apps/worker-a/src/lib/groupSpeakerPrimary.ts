/**
 * 发言人第一跳主责名单：固定最多 PRIMARY_FANOUT 人，群主必须在里面。
 * 优先自己在转发树上的孩子，不够再从已知成员里补。人数不足 8 时只推现有的人。
 */
import type { Env } from '../env';
import { messagingDb } from './messagingDb';
import { normalizeGroupMemberUrl } from './groupMemberUrl';
import { PRIMARY_FANOUT } from './groupRelayTree';

export const SPEAKER_PRIMARY_FANOUT = PRIMARY_FANOUT;

function hash32(input: string): number {
  let h = 2166136261;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function pushUnique(targets: string[], seen: Set<string>, urls: string[], limit: number): void {
  for (const raw of urls) {
    if (targets.length >= limit) return;
    const url = normalizeGroupMemberUrl(raw);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    targets.push(url);
  }
}

/**
 * 选出发言人要直接推送的人。
 * - 发言人不是群主时，群主一定在名单里（占 1 个名额）
 * - 其余名额先给「我为父」的孩子，再从其他已知成员按发言人地址轮转补满
 * - 发言人自己、excludeUrls 不会入选
 */
export function selectSpeakerPrimaryTargets(input: {
  speakerUrl: string;
  ownerUrl: string;
  childUrls?: string[];
  peerUrls?: string[];
  excludeUrls?: string[];
  limit?: number;
}): string[] {
  const limit = input.limit ?? SPEAKER_PRIMARY_FANOUT;
  const speaker = normalizeGroupMemberUrl(input.speakerUrl);
  const owner = normalizeGroupMemberUrl(input.ownerUrl);
  const exclude = new Set(
    [speaker, ...(input.excludeUrls ?? []).map((url) => normalizeGroupMemberUrl(url))].filter(Boolean),
  );
  const targets: string[] = [];
  const seen = new Set<string>(exclude);

  if (owner && owner !== speaker) {
    targets.push(owner);
    seen.add(owner);
  }

  const children = [...(input.childUrls ?? [])]
    .map((url) => normalizeGroupMemberUrl(url))
    .filter(Boolean)
    .sort();
  pushUnique(targets, seen, children, limit);

  const peers = [...(input.peerUrls ?? [])]
    .map((url) => normalizeGroupMemberUrl(url))
    .filter(Boolean)
    .sort();
  if (peers.length > 0 && targets.length < limit) {
    const start = hash32(speaker) % peers.length;
    pushUnique(targets, seen, peers.slice(start).concat(peers.slice(0, start)), limit);
  }

  return targets;
}

/** 用本机已同步的转发树和成员行，组装这场发言的主责名单。 */
export async function loadSpeakerPrimaryTargets(
  env: Env,
  groupId: string,
  speakerUrl: string,
  ownerUrl: string,
  opts?: { excludeUrls?: string[] },
): Promise<string[]> {
  const db = messagingDb(env);
  const group = await db
    .prepare(`SELECT tree_id, owner_worker_b_url FROM groups WHERE group_id = ? LIMIT 1`)
    .bind(groupId)
    .first<{ tree_id: number; owner_worker_b_url: string }>();

  const resolvedOwner = ownerUrl || group?.owner_worker_b_url || '';
  const treeId = group?.tree_id ?? 0;
  const speaker = normalizeGroupMemberUrl(speakerUrl);

  const { results: edges } = await db
    .prepare(
      `SELECT parent_worker_b_url, child_worker_b_url
         FROM group_relay_edges
        WHERE group_id = ? AND tree_id = ?`,
    )
    .bind(groupId, treeId)
    .all<{ parent_worker_b_url: string; child_worker_b_url: string }>();

  const childUrls: string[] = [];
  const peerUrls: string[] = [];
  for (const edge of edges ?? []) {
    peerUrls.push(edge.parent_worker_b_url, edge.child_worker_b_url);
    if (normalizeGroupMemberUrl(edge.parent_worker_b_url) === speaker) {
      childUrls.push(edge.child_worker_b_url);
    }
  }

  const { results: members } = await db
    .prepare(
      `SELECT member_worker_b_url FROM group_members
        WHERE group_id = ? AND status IN ('active', 'pending')`,
    )
    .bind(groupId)
    .all<{ member_worker_b_url: string }>();
  for (const row of members ?? []) peerUrls.push(row.member_worker_b_url);

  return selectSpeakerPrimaryTargets({
    speakerUrl,
    ownerUrl: resolvedOwner,
    childUrls,
    peerUrls,
    excludeUrls: opts?.excludeUrls,
  });
}
