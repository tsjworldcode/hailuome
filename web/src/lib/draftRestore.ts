// M7-19：Composer / InlineComposer 共享草稿恢复（?draft= 优先 + drafts[0] 回落）

import { getDraft, listDrafts } from './localDb';

/** 从 URLSearchParams 取 ?draft=<id>；非正整数返回 null */
export function readDraftIdFromUrl(): number | null {
  if (typeof window === 'undefined') return null;
  try {
    const params = new URLSearchParams(window.location.search);
    const raw = params.get('draft');
    if (raw === null || raw === '') return null;
    if (!/^\d+$/.test(raw)) return null;
    const n = Number.parseInt(raw, 10);
    if (!Number.isFinite(n) || n <= 0) return null;
    return n;
  } catch {
    return null;
  }
}

export interface RestoreDraftTarget {
  readonly setContent: (text: string) => void;
  readonly setDraftId: (id: number | undefined) => void;
  readonly getContent: () => string;
  readonly onRestored?: () => void;
}

export interface RestoreDraftResult {
  readonly restored: boolean;
  /** listDrafts 长度（失败时为 0） */
  readonly draftCount: number;
}

/**
 * mount 时恢复草稿：URL ?draft= 优先，否则 drafts[0]。
 * 仅在 getContent() 仍为空时写入，避免覆盖用户已输入未 debounce 的内容。
 */
export async function restoreDraftToForm(target: RestoreDraftTarget): Promise<RestoreDraftResult> {
  if (typeof indexedDB === 'undefined') return { restored: false, draftCount: 0 };
  if (target.getContent().trim() !== '') return { restored: false, draftCount: 0 };

  let draftCount = 0;
  try {
    draftCount = (await listDrafts()).length;
  } catch {
    draftCount = 0;
  }

  const queryId = readDraftIdFromUrl();
  if (queryId !== null) {
    try {
      const picked = await getDraft(queryId);
      if (picked && picked.content.trim()) {
        target.setContent(picked.content);
        target.setDraftId(picked.draft_id);
        target.onRestored?.();
        return { restored: true, draftCount };
      }
    } catch {
      // 回落到最新一条
    }
  }

  try {
    const drafts = await listDrafts();
    draftCount = drafts.length;
    const latest = drafts[0];
    if (!latest || !latest.content.trim()) return { restored: false, draftCount };
    target.setContent(latest.content);
    target.setDraftId(latest.draft_id);
    target.onRestored?.();
    return { restored: true, draftCount };
  } catch {
    return { restored: false, draftCount: 0 };
  }
}
