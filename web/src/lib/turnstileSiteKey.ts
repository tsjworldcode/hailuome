/** 官方海螺注册中心 hailuo-register Widget 的公开 Site Key（与默认 REGISTRY_URL 配套） */
const DEFAULT_REGISTRY_TURNSTILE_SITE_KEY = '0x4AAAAAADMYb_bOx7zeI9EI';

/** 注册中心 Turnstile Site Key（构建时 PUBLIC_TURNSTILE_SITE_KEY 注入，未设则回落官方默认值） */
export function getTurnstileSiteKey(): string | null {
  const raw = import.meta.env.PUBLIC_TURNSTILE_SITE_KEY;
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (trimmed.length > 0) return trimmed;
  }
  return DEFAULT_REGISTRY_TURNSTILE_SITE_KEY;
}
