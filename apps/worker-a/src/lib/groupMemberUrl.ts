/** M16-1c：群 membership 权威键归一化（对齐 DM/关注 URL 口径）。 */
export function normalizeGroupMemberUrl(value: string): string {
  return value.trim().replace(/\/+$/, '');
}
