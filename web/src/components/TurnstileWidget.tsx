/** @jsxImportSource preact */
import type { VNode } from 'preact';
import { useCallback, useEffect, useRef } from 'preact/hooks';
import { language, t, turnstileLangFor } from '../lib/i18n';

declare global {
  interface Window {
    turnstile?: {
      render: (
        container: HTMLElement,
        options: {
          sitekey: string;
          callback?: (token: string) => void;
          'expired-callback'?: () => void;
          'error-callback'?: (code?: string) => void;
          theme?: 'auto' | 'light' | 'dark';
          language?: string;
        },
      ) => string;
      remove: (widgetId: string) => void;
      reset: (widgetId: string) => void;
    };
  }
}

const SCRIPT_SRC = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
let scriptLoadPromise: Promise<void> | null = null;

function loadTurnstileScript(): Promise<void> {
  if (typeof window === 'undefined') return Promise.resolve();
  if (window.turnstile) return Promise.resolve();
  if (scriptLoadPromise) return scriptLoadPromise;
  scriptLoadPromise = new Promise((resolve, reject) => {
    const existing = document.querySelector(`script[src^="${SCRIPT_SRC}"]`);
    if (existing) {
      existing.addEventListener('load', () => resolve(), { once: true });
      existing.addEventListener('error', () => reject(new Error(t('turnstileScriptLoadFailed'))), { once: true });
      return;
    }
    const script = document.createElement('script');
    script.src = SCRIPT_SRC;
    script.async = true;
    script.defer = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error(t('turnstileScriptLoadFailed')));
    document.head.appendChild(script);
  });
  return scriptLoadPromise;
}

interface Props {
  readonly siteKey: string;
  readonly onToken: (token: string) => void;
  readonly onExpire?: () => void;
  readonly onError?: () => void;
}

/** Cloudflare Turnstile 人机验证（注册中心 precheck 必填） */
export function TurnstileWidget({ siteKey, onToken, onExpire, onError }: Props): VNode {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const widgetIdRef = useRef<string | null>(null);

  const renderWidget = useCallback(() => {
    const el = containerRef.current;
    if (!el || !window.turnstile) return;
    if (widgetIdRef.current) {
      window.turnstile.remove(widgetIdRef.current);
      widgetIdRef.current = null;
    }
    widgetIdRef.current = window.turnstile.render(el, {
      sitekey: siteKey,
      theme: 'auto',
      language: turnstileLangFor(language.value),
      callback: (token) => onToken(token),
      'expired-callback': () => {
        onExpire?.();
        onError?.();
      },
      'error-callback': () => onError?.(),
    });
  }, [siteKey, onToken, onExpire, onError]);

  useEffect(() => {
    let cancelled = false;
    void loadTurnstileScript()
      .then(() => {
        if (!cancelled) renderWidget();
      })
      .catch(() => onError?.());
    return () => {
      cancelled = true;
      if (widgetIdRef.current && window.turnstile) {
        window.turnstile.remove(widgetIdRef.current);
        widgetIdRef.current = null;
      }
    };
  }, [renderWidget, onError]);

  return <div ref={containerRef} class="min-h-[65px]" aria-label={t('turnstileAria')} />;
}
