import type { Env } from '../env';

/** M16-1b：私信/群聊密文表（dm_* / group_*）统一走 MESSAGING_DB；互粉/拉黑/users 仍用 DB。 */
export function messagingDb(env: Env): D1Database {
  return env.MESSAGING_DB;
}
