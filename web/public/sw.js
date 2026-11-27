// 海螺节点 Service Worker（M7-6 PWA 第一版）
//
// 设计要点：
//   - 静态资源（HTML / JS / CSS / SVG / 字体）走 cache-first + 后台 SWR 刷新
//   - 同源页面导航（HTML 顶层文档）走 network-first，断网时回退预存 /offline.html
//   - 跨源 GET 默认 network only（不缓存）—— 防止粉丝 Token 鉴权响应被边缘缓存
//     污染（M6-Pre1：粉丝 Token 模式响应已带 Cache-Control: private, no-store + Vary: Authorization，
//     SW 同样必须不缓存）。任何带 Authorization 头的请求**一律 bypass**，
//     SW 直接走 fetch(request) 不命中 Cache Storage、不写入 Cache Storage。
//   - 非 GET 请求一律 bypass（POST/PUT/DELETE 上传删帖等写层动作不进缓存）
//
// §F-02 红线（与本仓库其它前端代码一致）：
//   - 本文件零业务私密写层 URL 字面量、零构建期 env 读取（SW 上下文无 env 注入通道）
//   - 不引入任何业务 client（lib/api.ts / lib/workerA.ts 等不可在 SW 中作为模块依赖）
//   - 不读 localStorage / sessionStorage（SW 上下文也没有）
//   - 仅对 self.location.origin 同源资源做 cache-first；跨源全部 network only
//
// 缓存版本：每次更新 SW 必修改 SW_VERSION，触发 activate 时清理旧 cache
// 旧版本清理在 activate 阶段执行，避免无限期堆积
// M7-16：bump 小版本以激活 activate 清理；RUNTIME 写入后 FIFO trim 防 Quota 膨胀
// M7-32b：QuotaExceeded 时 postMessage 通知页面 toast
const SW_VERSION = 'hailuo-pwa-v1.2';
const STATIC_CACHE = `${SW_VERSION}-static`;
const RUNTIME_CACHE = `${SW_VERSION}-runtime`;

/** RUNTIME_CACHE 最大条目数（审计 §3.1 P1；超出按 keys() 顺序删最前项） */
const RUNTIME_CACHE_MAX_ITEMS = 150;

// 预缓存清单 —— 只放确认存在的静态文件，避免 install 阶段 addAll 整批失败
const PRECACHE_URLS = [
  '/offline.html',
  '/favicon.svg',
  '/manifest.json',
  '/icon-192.svg',
  '/icon-512.svg',
];

self.addEventListener('install', (event) => {
  // 提前激活以便首次安装后立即接管页面
  self.skipWaiting();
  event.waitUntil(
    caches
      .open(STATIC_CACHE)
      .then((cache) => cache.addAll(PRECACHE_URLS))
      .catch(() => {
        /* 任一资源 404 时静默忽略，不阻塞首装；后续运行期 fetch handler 仍可按需补缓存 */
      }),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      // 清理旧版本 cache（保留当前 STATIC_CACHE / RUNTIME_CACHE）
      const keys = await caches.keys();
      await Promise.all(
        keys.map((key) => {
          if (key !== STATIC_CACHE && key !== RUNTIME_CACHE) {
            return caches.delete(key);
          }
          return Promise.resolve(true);
        }),
      );
      // 立即接管已打开的客户端，避免用户必须刷新才能用上新 SW
      await self.clients.claim();
    })(),
  );
});

/** 是否同源资源 */
function isSameOrigin(url) {
  return new URL(url).origin === self.location.origin;
}

/** 文档导航请求（顶层 HTML） */
function isNavigationRequest(request) {
  return request.mode === 'navigate' || (request.method === 'GET' && request.headers.get('accept')?.includes('text/html'));
}

/** 同源静态资源（按扩展名识别，与 Astro dist/ 产物对齐） */
function isStaticAsset(url) {
  const path = new URL(url).pathname;
  return (
    path.startsWith('/_astro/') ||
    /\.(?:js|css|svg|png|jpg|jpeg|webp|woff2?|ttf|otf|ico|json)$/.test(path)
  );
}

self.addEventListener('fetch', (event) => {
  const { request } = event;

  // 非 GET 一律放行（POST 发帖 / DELETE 删帖等写层动作）
  if (request.method !== 'GET') {
    return;
  }

  // 任何携带 Authorization 头的请求一律不缓存（与 Worker B M6-Pre1 enforced 模式策略一致）
  if (request.headers.has('authorization')) {
    return;
  }

  const url = request.url;

  // 跨源 GET：network only，避免污染（粉丝节点搜索 / 第三方资源）
  if (!isSameOrigin(url)) {
    return;
  }

  // 同源页面导航：network-first → offline.html fallback
  if (isNavigationRequest(request)) {
    event.respondWith(networkFirstNavigation(request));
    return;
  }

  // 同源静态资源：cache-first + 后台 SWR
  if (isStaticAsset(url)) {
    event.respondWith(cacheFirstSwr(request));
    return;
  }

  // 同源其它 GET（罕见）：默认走 network，不进 cache，避免私有响应误缓存
});

/**
 * RUNTIME_CACHE 条目超上限时按 FIFO 删最前项（不阻塞响应路径，失败静默）。
 */
async function trimRuntimeCache(cache) {
  try {
    const keys = await cache.keys();
    const excess = keys.length - RUNTIME_CACHE_MAX_ITEMS;
    if (excess <= 0) return;
    for (let i = 0; i < excess; i++) {
      await cache.delete(keys[i]);
    }
  } catch {
    /* trim 失败不影响主流程 */
  }
}

/** QuotaExceeded 判别（Cache API 与 IDB 同源配额） */
function isQuotaExceededError(err) {
  if (!err) return false;
  if (err.name === 'QuotaExceededError') return true;
  return /QuotaExceeded/i.test(String(err.message || ''));
}

/** 通知已打开页面：离线缓存写入失败（debounce 由页面 toast 层承担） */
async function notifyClientsCacheQuota() {
  try {
    const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of clients) {
      client.postMessage({ type: 'hailuo:sw-cache-quota' });
    }
  } catch {
    /* 静默 */
  }
}

/** 写入 RUNTIME_CACHE 后触发 trim */
function putRuntimeWithTrim(cache, request, response) {
  return cache
    .put(request, response)
    .then(() => trimRuntimeCache(cache))
    .catch((err) => {
      if (isQuotaExceededError(err)) {
        void notifyClientsCacheQuota();
      }
      /* 其它写失败：静默，页面仍走 network */
    });
}

/**
 * cache-first + stale-while-revalidate：先返回缓存，背景拉新更新缓存。
 * 静态资源（hash 命名的 _astro/* / icon / favicon）首要诉求是离线可用与快返回。
 */
async function cacheFirstSwr(request) {
  const cache = await caches.open(RUNTIME_CACHE);
  const cached = await cache.match(request);

  const networkPromise = fetch(request)
    .then((response) => {
      if (response && response.ok && response.type === 'basic') {
        void putRuntimeWithTrim(cache, request, response.clone());
      }
      return response;
    })
    .catch(() => null);

  if (cached) {
    // 不 await network，让它在后台跑（SWR）
    networkPromise.catch(() => {});
    return cached;
  }

  const network = await networkPromise;
  if (network) return network;

  // 完全离线 + 未缓存：返回简易 503
  return new Response('离线', {
    status: 503,
    statusText: 'Service Unavailable',
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  });
}

/**
 * 顶层导航：network-first；网络失败时回 cache，cache 也无再回 /offline.html。
 * 保证用户在断网时仍能看到友好提示页（而非浏览器自带断网页）。
 */
async function networkFirstNavigation(request) {
  const runtimeCache = await caches.open(RUNTIME_CACHE);
  try {
    const response = await fetch(request);
    if (response && response.ok && response.type === 'basic') {
      void putRuntimeWithTrim(runtimeCache, request, response.clone());
    }
    return response;
  } catch {
    const cached = await runtimeCache.match(request);
    if (cached) return cached;
    const staticCache = await caches.open(STATIC_CACHE);
    const offline = await staticCache.match('/offline.html');
    if (offline) return offline;
    return new Response('离线', {
      status: 503,
      statusText: 'Service Unavailable',
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    });
  }
}

// Web Push 预入口（M9+ 实装）：postMessage / push 事件占位，本版不绑定实际推送
// self.addEventListener('push', (event) => { ... });
// self.addEventListener('notificationclick', (event) => { ... });
