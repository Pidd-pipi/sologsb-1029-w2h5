const SHELL_CACHE = 'echo-step-shell-v2';
const LESSON_CACHE = 'echo-step-lessons-v1';
const APP_SHELL = ['./', './index.html', './manifest.webmanifest'];

function openLessons() {
  return caches.open(LESSON_CACHE);
}

function parseUrl(value) {
  return new URL(value, self.location.href);
}

function lessonUrl(lessonId, version) {
  return `./__lessons__/${encodeURIComponent(lessonId)}?v=${encodeURIComponent(version)}`;
}

function isLessonRequest(request, lessonId) {
  const segments = parseUrl(request.url).pathname.split('/');
  return decodeURIComponent(segments[segments.length - 1] || '') === lessonId;
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE)
      .then((cache) => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      // 应用壳与离线包分开存放；仅清理旧版应用壳缓存，绝不误删离线课节
      .then((keys) => Promise.all(keys
        .filter((key) => key !== SHELL_CACHE && key !== LESSON_CACHE)
        .map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

// ---- 容量账本消息通道：离线包的写入、删除与清点 -----------------------------

self.addEventListener('message', (event) => {
  const data = event.data || {};
  const port = event.ports && event.ports[0];
  const reply = (payload) => { if (port) port.postMessage(payload); };

  if (data.type === 'put') {
    const info = data.lesson || {};
    event.waitUntil(
      openLessons().then((cache) =>
        // 同一课节先清掉旧版本 URL，避免旧版本重复占空间
        cache.keys().then((requests) =>
          Promise.all(requests
            .filter((request) => isLessonRequest(request, info.id))
            .map((request) => cache.delete(request)))
        ).then(() => cache.put(
          lessonUrl(info.id, info.version),
          new Response(info.payload, {
            headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }
          })
        ))
      ).then(() => reply({ ok: true })).catch(() => reply({ ok: false }))
    );
    return;
  }

  if (data.type === 'delete') {
    event.waitUntil(
      openLessons().then((cache) => cache.keys().then((requests) =>
        Promise.all(requests
          .filter((request) => isLessonRequest(request, data.lessonId))
          .map((request) => cache.delete(request)))
      )).then(() => reply({ ok: true })).catch(() => reply({ ok: false }))
    );
    return;
  }

  if (data.type === 'lessons') {
    event.waitUntil(
      openLessons().then((cache) => cache.keys().then((requests) => {
        const entries = requests.map((request) => {
          const url = parseUrl(request.url);
          const segments = url.pathname.split('/');
          return {
            lessonId: decodeURIComponent(segments[segments.length - 1] || ''),
            version: url.searchParams.get('v') || ''
          };
        });
        reply({ ok: true, entries });
      })).catch(() => reply({ ok: false, entries: [] }))
    );
  }
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET' || parseUrl(request.url).origin !== self.location.origin) return;

  const url = parseUrl(request.url);

  // 离线课节包：仅由账本写入，cache-first，绝不被运行时网络请求污染
  if (url.pathname.includes('/__lessons__/')) {
    event.respondWith(
      caches.match(request).then((cached) => cached || Response.error())
    );
    return;
  }

  // 应用壳资源：缓存优先，后台刷新（stale-while-revalidate）
  event.respondWith(
    caches.match(request).then((cached) => {
      const network = fetch(request).then((response) => {
        if (response.ok && url.pathname.startsWith('/assets/')) {
          const copy = response.clone();
          caches.open(SHELL_CACHE).then((cache) => cache.put(request, copy));
        }
        return response;
      }).catch(() => cached || (request.mode === 'navigate' ? caches.match('./index.html') : undefined));
      return cached || network;
    })
  );
});
