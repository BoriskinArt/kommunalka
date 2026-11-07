// Service worker: офлайн-работа. Данные пользователя хранятся в IndexedDB и при обновлении не затрагиваются.
const VERSION = '1.0.5';
const SHELL = `shell-${VERSION}`;
const OCR = 'ocr-v5.1.1';

const SHELL_FILES = [
  './', 'index.html', 'styles.css', 'manifest.webmanifest',
  'js/app.js', 'js/db.js', 'js/money.js', 'js/parser.js', 'js/extract.js', 'js/photo.js',
  'icons/icon-192.png', 'icons/icon-512.png',
  'vendor/pdfjs/pdf.min.mjs', 'vendor/pdfjs/pdf.worker.min.mjs',
];
const OCR_FILES = [
  'vendor/tesseract/tesseract.min.js', 'vendor/tesseract/worker.min.js',
  'vendor/tesseract/tesseract-core-simd-lstm.wasm.js', 'vendor/tesseract/tesseract-core-lstm.wasm.js',
  'vendor/tesseract/lang/rus.traineddata.gz',
];

self.addEventListener('install', (event) => {
  // cache: 'reload' — брать свежие файлы с сервера, а не из HTTP-кэша браузера.
  event.waitUntil(caches.open(SHELL).then((c) => c.addAll(SHELL_FILES.map((f) => new Request(f, { cache: 'reload' })))).then(() => self.skipWaiting()));
  // Модуль OCR (~9 МБ) докачиваем в фоне, не задерживая установку.
  caches.open(OCR).then(async (c) => {
    for (const f of OCR_FILES) if (!(await c.match(f))) await c.add(f).catch(() => {});
  });
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const k of await caches.keys()) if (k !== SHELL && k !== OCR) await caches.delete(k);
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  event.respondWith((async () => {
    if (req.mode === 'navigate') {
      const cached = await caches.match('index.html');
      if (cached) return cached;
    }
    const hit = await caches.match(req, { ignoreSearch: true });
    if (hit) return hit;
    const res = await fetch(req);
    if (res.ok && /\/vendor\/tesseract\//.test(req.url)) {
      const c = await caches.open(OCR);
      c.put(req, res.clone());
    }
    return res;
  })());
});
