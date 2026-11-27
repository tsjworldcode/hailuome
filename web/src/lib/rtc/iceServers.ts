/**
 * M-RTC-1b：ICE / TURN 配置（仅本机存储；禁止写入日志或错误 message）。
 * - 默认过滤发出 SDP 中的 host 候选（减局域网 IP 暴露）
 * - relay-only 仅在已配置 TURN 时生效（对端看不到自家公网 IP；TURN 运营方可看见）
 */
const CONFIG_LS_KEY = 'hailuo:rtc-ice-config';
/** M-RTC-1 临时键，保存新配置时清除 */
const LEGACY_SS_KEY = 'hailuo:rtc-ice-servers';

export interface RtcIceConfig {
  readonly v: 1;
  readonly stun_urls: readonly string[];
  readonly turn_urls: readonly string[];
  readonly turn_username: string;
  readonly turn_credential: string;
  /** 有 TURN 时才允许 true */
  readonly relay_only: boolean;
  /** 默认 true：发送前去掉 typ host */
  readonly strip_host: boolean;
}

const DEFAULT_STUN = 'stun:stun.cloudflare.com:3478';

export const DEFAULT_RTC_ICE_CONFIG: RtcIceConfig = {
  v: 1,
  stun_urls: [DEFAULT_STUN],
  turn_urls: [],
  turn_username: '',
  turn_credential: '',
  relay_only: false,
  strip_host: true,
};

function normalizeUrlList(raw: readonly string[] | undefined, fallback: string[]): string[] {
  const list = (raw ?? [])
    .map((u) => u.trim())
    .filter(Boolean);
  return list.length > 0 ? list : fallback;
}

export function hasTurnConfigured(config: RtcIceConfig = loadRtcIceConfig()): boolean {
  return config.turn_urls.some((u) => /^turns?:/i.test(u.trim()));
}

export function loadRtcIceConfig(): RtcIceConfig {
  if (typeof window === 'undefined') return DEFAULT_RTC_ICE_CONFIG;
  try {
    const raw = window.localStorage.getItem(CONFIG_LS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<RtcIceConfig>;
      const turnUrls = normalizeUrlList(parsed.turn_urls, []);
      const hasTurn = turnUrls.some((u) => /^turns?:/i.test(u));
      return {
        v: 1,
        stun_urls: normalizeUrlList(parsed.stun_urls, [DEFAULT_STUN]),
        turn_urls: turnUrls,
        turn_username: typeof parsed.turn_username === 'string' ? parsed.turn_username : '',
        turn_credential: typeof parsed.turn_credential === 'string' ? parsed.turn_credential : '',
        relay_only: Boolean(parsed.relay_only) && hasTurn,
        strip_host: parsed.strip_host !== false,
      };
    }
  } catch {
    // 回落默认
  }
  return DEFAULT_RTC_ICE_CONFIG;
}

/** 校验并写入；relay_only 无 TURN 时强制 false。不回显 credential。 */
export function saveRtcIceConfig(input: Omit<RtcIceConfig, 'v'>): RtcIceConfig {
  const turnUrls = normalizeUrlList(input.turn_urls, []);
  const hasTurn = turnUrls.some((u) => /^turns?:/i.test(u));
  const next: RtcIceConfig = {
    v: 1,
    stun_urls: normalizeUrlList(input.stun_urls, [DEFAULT_STUN]),
    turn_urls: turnUrls,
    turn_username: input.turn_username.trim(),
    turn_credential: input.turn_credential,
    relay_only: Boolean(input.relay_only) && hasTurn,
    strip_host: input.strip_host !== false,
  };
  if (typeof window !== 'undefined') {
    window.localStorage.setItem(CONFIG_LS_KEY, JSON.stringify(next));
    try {
      window.sessionStorage.removeItem(LEGACY_SS_KEY);
    } catch {
      // ignore
    }
  }
  return next;
}

export function clearRtcIceConfig(): void {
  if (typeof window === 'undefined') return;
  window.localStorage.removeItem(CONFIG_LS_KEY);
  try {
    window.sessionStorage.removeItem(LEGACY_SS_KEY);
  } catch {
    // ignore
  }
}

/** 供 RTCPeerConnection.iceServers */
export function resolveRtcIceServers(config: RtcIceConfig = loadRtcIceConfig()): RTCIceServer[] {
  const servers: RTCIceServer[] = [];
  for (const urls of config.stun_urls) {
    if (/^stuns?:/i.test(urls)) servers.push({ urls });
  }
  if (servers.length === 0) {
    servers.push({ urls: DEFAULT_STUN });
  }
  if (hasTurnConfigured(config)) {
    const turnEntry: RTCIceServer = {
      urls: [...config.turn_urls],
    };
    if (config.turn_username) turnEntry.username = config.turn_username;
    if (config.turn_credential) turnEntry.credential = config.turn_credential;
    servers.push(turnEntry);
  }
  return servers;
}

export function resolveRtcIceTransportPolicy(
  config: RtcIceConfig = loadRtcIceConfig(),
): RTCIceTransportPolicy {
  return config.relay_only && hasTurnConfigured(config) ? 'relay' : 'all';
}

export function resolveRtcPeerConnectionConfig(
  config: RtcIceConfig = loadRtcIceConfig(),
): RTCConfiguration {
  return {
    iceServers: resolveRtcIceServers(config),
    iceTransportPolicy: resolveRtcIceTransportPolicy(config),
  };
}

/**
 * 从发出的 SDP 去掉 typ host 候选（局域网 IP）。
 * 不改 srflx/relay；也不把假 IP 写进 candidate（假了会连不上）。
 */
export function stripHostCandidatesFromSdp(sdp: string): string {
  const nl = sdp.includes('\r\n') ? '\r\n' : '\n';
  return sdp
    .split(/\r?\n/)
    .filter((line) => {
      if (!/^a=candidate:/i.test(line)) return true;
      return !/\btyp\s+host\b/i.test(line);
    })
    .join(nl);
}

export function applyOutgoingSdpPrivacy(
  desc: RTCSessionDescriptionInit,
  config: RtcIceConfig = loadRtcIceConfig(),
): RTCSessionDescriptionInit {
  if (!desc.sdp || !config.strip_host) return desc;
  return { ...desc, sdp: stripHostCandidatesFromSdp(desc.sdp) };
}

/** @deprecated 使用 saveRtcIceConfig */
export function setRtcIceServersForSession(servers: RTCIceServer[]): void {
  const stun: string[] = [];
  const turn: string[] = [];
  let username = '';
  let credential = '';
  for (const s of servers) {
    const urls = Array.isArray(s.urls) ? s.urls : [s.urls];
    for (const u of urls) {
      if (/^turns?:/i.test(u)) turn.push(u);
      else if (/^stuns?:/i.test(u)) stun.push(u);
    }
    if (s.username) username = s.username;
    if (typeof s.credential === 'string') credential = s.credential;
  }
  saveRtcIceConfig({
    stun_urls: stun.length ? stun : [DEFAULT_STUN],
    turn_urls: turn,
    turn_username: username,
    turn_credential: credential,
    relay_only: false,
    strip_host: true,
  });
}
