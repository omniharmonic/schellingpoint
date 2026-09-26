/*
 * unconference service worker (MT §12.7, §12.10).
 *
 * Scope, deliberately narrow:
 *   · the app shell (the offline page, the icons, the manifest) is precached, so a phone with
 *     no signal in a basement conference room still opens something instead of a browser error;
 *   · the *published* schedule of a gathering — `/api/v1/schedule*` and the public program
 *     reads — is cached stale-while-revalidate, so yesterday's answer is shown instantly and
 *     replaced the moment the network comes back.
 *
 * What is deliberately NOT cached, and must never be:
 *   · anything requiring a session. A cached private response is a private response sitting on
 *     a shared device for the next person who opens the browser. Every `/api/` route that is
 *     not the public schedule is network-only, and any response carrying `Cache-Control:
 *     private` or `no-store` is dropped on the floor.
 *   · check-in. There is no offline check-in queue here on purpose: a QR ticket is a 15-minute
 *     signed token, so a scan replayed from a queue an hour later cannot be verified, and a
 *     door that says "accepted" while nothing was recorded is worse than a door that says "no
 *     signal". Check-in stays a live POST.
 *   · POST, PUT, PATCH, DELETE — a write is never served from, or written to, a cache.
 */

const VERSION = 'v2'
const SHELL = `unconference-shell-${VERSION}`
const SCHEDULE = `unconference-schedule-${VERSION}`

const SHELL_ASSETS = [
  '/offline',
  '/manifest.webmanifest',
  '/icons/unconference-192.png',
  '/icons/unconference-512.png',
]

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL).then((cache) => cache.addAll(SHELL_ASSETS)).then(() => self.skipWaiting()),
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== SHELL && k !== SCHEDULE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  )
})

/** Never keep a response that says it is private, or that is not a plain 200 from us. */
function storable(response) {
  if (!response || !response.ok || response.type !== 'basic') return false
  const control = (response.headers.get('cache-control') || '').toLowerCase()
  return !control.includes('private') && !control.includes('no-store')
}

/** The keyless public reads: a gathering's published schedule and the program behind it. */
function isPublicSchedule(url) {
  return (
    url.pathname.startsWith('/api/v1/schedule') ||
    /^\/api\/v1\/events\/[^/]+\/(schedule|tracks|venues|timeslots)(\/|$)/.test(url.pathname)
  )
}

self.addEventListener('fetch', (event) => {
  const request = event.request
  if (request.method !== 'GET') return

  const url = new URL(request.url)
  if (url.origin !== self.location.origin) return

  // A calendar feed URL carries a credential; a data export is somebody's whole life. Never.
  if (url.pathname.startsWith('/api/calendar/') || url.pathname.startsWith('/api/me/')) return

  if (url.pathname.startsWith('/api/')) {
    if (!isPublicSchedule(url)) return
    // Stale-while-revalidate: answer from the cache at once, refresh behind it.
    event.respondWith(
      caches.open(SCHEDULE).then(async (cache) => {
        const cached = await cache.match(request)
        const network = fetch(request)
          .then((response) => {
            if (storable(response)) cache.put(request, response.clone())
            return response
          })
          .catch(() => cached)
        return cached || network
      }),
    )
    return
  }

  // Pages: network first so a signed-in person always sees the truth, cache as the fallback,
  // and the offline page when there is neither.
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (storable(response)) {
            const copy = response.clone()
            caches.open(SHELL).then((cache) => cache.put(request, copy))
          }
          return response
        })
        .catch(async () => (await caches.match(request)) || (await caches.match('/offline')) || Response.error()),
    )
    return
  }

  // Static assets: cache first, they are content-hashed or versioned by Next.
  if (url.pathname.startsWith('/_next/static/') || url.pathname.startsWith('/icons/') || url.pathname.startsWith('/fonts/')) {
    event.respondWith(
      caches.open(SHELL).then(async (cache) => {
        const cached = await cache.match(request)
        if (cached) return cached
        const response = await fetch(request)
        if (storable(response)) cache.put(request, response.clone())
        return response
      }),
    )
  }
})

// Payloads contain no private message text. Opening the destination still requires app auth.
self.addEventListener('push', (event) => {
  let data = {}
  try { data = event.data ? event.data.json() : {} } catch { /* still show a generic update */ }
  event.waitUntil(self.registration.showNotification('unconference', {
    body: 'You have a new gathering update. Open the app to read it.',
    icon: '/icons/unconference-192.png',
    tag: typeof data.tag === 'string' ? data.tag : 'gathering-update',
    data: { url: typeof data.url === 'string' ? data.url : '/' },
  }))
})
self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  let target = new URL('/', self.location.origin)
  try {
    const candidate = new URL(event.notification.data?.url || '/', self.location.origin)
    if (candidate.origin === self.location.origin) target = candidate
  } catch { /* ignore malformed destinations */ }
  event.waitUntil(self.clients.openWindow(target.href))
})
