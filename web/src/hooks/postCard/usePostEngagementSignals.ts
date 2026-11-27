/**
 * NCF-WEB-2：视口印象 / dwell / skim 信号采集（singleton observePost）。
 */
import { useEffect, useRef } from 'preact/hooks';
import { observePost } from '../../lib/postObserver';
import {
  DWELL_TICK_MS,
  extractTagsFromContent,
  recordDwell,
  recordImpression,
  recordSkim,
} from '../../lib/forYou';
import { IMPRESSION_DELAY_MS } from './shared';

export type UsePostEngagementSignalsArgs = {
  handle: string;
  content: string;
};

export function usePostEngagementSignals({ handle, content }: UsePostEngagementSignalsArgs) {
  // M7-8 / M7-8b / M7-8c：观察 article 视口状态采多路信号
  const articleRef = useRef<HTMLElement | null>(null);
  // M7-8c：首屏跟踪 + tag 提取（useRef 避免重渲染重算）
  const firstScreenRef = useRef<boolean | null>(null);
  const tagsRef = useRef<readonly string[]>(extractTagsFromContent(content));

  useEffect(() => {
    tagsRef.current = extractTagsFromContent(content);
  }, [content]);

  useEffect(() => {
    const el = articleRef.current;
    if (!el) return;
    // M7-12：observer 以顶层 singleton + Map<Element, Handler> 委托
    let impressionTimer: ReturnType<typeof setTimeout> | null = null;
    let dwellInterval: ReturnType<typeof setInterval> | null = null;
    let impressionFired = false;
    const unobserve = observePost(el, (entry) => {
      if (firstScreenRef.current === null) {
        firstScreenRef.current = entry.isIntersecting === true;
      }
      if (entry.isIntersecting && entry.intersectionRatio > 0.5) {
        if (impressionTimer === null && !impressionFired) {
          impressionTimer = setTimeout(() => {
            impressionTimer = null;
            impressionFired = true;
            void recordImpression(handle, {
              tags: tagsRef.current,
              firstScreen: firstScreenRef.current === true,
            });
            dwellInterval = setInterval(() => {
              void recordDwell(handle);
            }, DWELL_TICK_MS);
          }, IMPRESSION_DELAY_MS);
        }
      } else {
        if (impressionTimer !== null) {
          clearTimeout(impressionTimer);
          impressionTimer = null;
          void recordSkim(handle);
        }
        if (dwellInterval !== null) {
          clearInterval(dwellInterval);
          dwellInterval = null;
        }
      }
    });
    return () => {
      if (impressionTimer !== null) clearTimeout(impressionTimer);
      if (dwellInterval !== null) clearInterval(dwellInterval);
      unobserve();
    };
  }, [handle, content]);

  return { articleRef, tagsRef };
}
