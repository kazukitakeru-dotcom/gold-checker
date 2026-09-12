/* =====================================================================
   Service Worker
   ---------------------------------------------------------------------
   ・アプリ本体（HTML/CSS/JS/アイコン）はキャッシュ優先で即表示する。
   ・価格データ（data/*.json）はネットワーク優先で、失敗したら
     直前に取得できたものを返す。キャッシュから返したレスポンスには
     x-from-cache ヘッダを付け、画面側で「オフライン表示」と分かるようにする。
   ===================================================================== */

const VERSION = 'v1';
const SHELL_CACHE = 'gold-shell-' + VERSION;
const DATA_CACHE = 'gold-data-' + VERSION;

const SHELL_ASSETS = [
  './',
  './index.html',
  './style.css',
  './script.js',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/favicon.svg'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE)
      .then((cache) => cache.addAll(SHELL_ASSETS))
      .then(() => self.skipWaiting())
      .catch(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys
          .filter((key) => key !== SHELL_CACHE && key !== DATA_CACHE)
          .map((key) => caches.delete(key))
      ))
      .then(() => self.clients.claim())
  );
});

function withCacheFlag(response) {
  const headers = new Headers(response.headers);
  headers.set('x-from-cache', '1');
  return response.blob().then((body) => new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: headers
  }));
}

async function handleData(request) {
  const cache = await caches.open(DATA_CACHE);
  try {
    const response = await fetch(request);
    if (response && response.ok) {
      cache.put(request, response.clone());
      return response;
    }
    throw new Error('bad response');
  } catch (error) {
    const cached = await cache.match(request, { ignoreSearch: true });
    if (cached) return withCacheFlag(cached);
    throw error;
  }
}

/** 一定時間で諦めてキャッシュに切り替えるための fetch。 */
function fetchWithTimeout(request, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), timeoutMs);
    fetch(request).then(
      (response) => { clearTimeout(timer); resolve(response); },
      (error) => { clearTimeout(timer); reject(error); }
    );
  });
}

/**
 * アプリ本体はネットワーク優先（2.5 秒でタイムアウト）。
 * 公開直後に古いコードが残り続けるのを避けつつ、オフラインでも起動できる。
 */
async function handleShell(request) {
  const cache = await caches.open(SHELL_CACHE);
  try {
    const response = await fetchWithTimeout(request, 2500);
    if (response && response.ok) {
      cache.put(request, response.clone());
      return response;
    }
    throw new Error('bad response');
  } catch (error) {
    const cached = await cache.match(request, { ignoreSearch: true });
    if (cached) return cached;
    throw error;
  }
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (url.pathname.includes('/data/')) {
    event.respondWith(handleData(request));
    return;
  }

  event.respondWith(
    handleShell(request).catch(() => caches.match('./index.html'))
  );
});
