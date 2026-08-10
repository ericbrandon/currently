/*
 * CurrentlyBC app-shell service worker. Hand-rolled (ported from the
 * sidestream worker) so the entire caching policy is this one screen,
 * with zero runtime deps.
 *
 * THE POLICY — four caches:
 *   - SHELL (name = build hash, injected): index.html + built assets +
 *     icons, precached at install. A new build activates, deletes every
 *     older shell cache, and leaves the runtime caches alone.
 *   - DATA: same-origin /data/*. Year files (/data/<year>/…) carry a
 *     content hash in their filename and are immutable → cache-first,
 *     cached on first successful fetch. The unhashed pointers
 *     (manifest.json, marine_zones.geojson) → network-first with a
 *     deadline, falling back to the cached copy so the app still boots
 *     offline.
 *   - TILES: the OpenFreeMap basemap origin (style, glyphs, sprites,
 *     tiles) → cache-first with an entry cap, so areas you've viewed
 *     keep rendering offline.
 *   - WEATHER: Environment Canada + NWS marine forecasts →
 *     network-first, cached fallback (the app's own 15 s timeout and
 *     issued-at display govern staleness).
 *   - Navigations: network-first with a deadline, fallback to the
 *     cached shell.
 *   - Everything else (other cross-origin, non-GET) is never touched.
 *
 * __CACHE_NAME__ / __PRECACHE__ are injected at build time by
 * scripts/vite-plugin-sw.ts (the cache name derives from the hash of
 * all precached content, so any shell change produces a new cache and
 * an activate-time purge of the old one).
 */

const SHELL_CACHE = self.__CACHE_NAME__;
const PRECACHE = self.__PRECACHE__;

const DATA_CACHE = "currently-data-v1";
const TILE_CACHE = "currently-tiles-v1";
const WEATHER_CACHE = "currently-weather-v1";
const RUNTIME_CACHES = new Set([DATA_CACHE, TILE_CACHE, WEATHER_CACHE]);

const TILE_ORIGIN = "https://tiles.openfreemap.org";
const WEATHER_ORIGINS = new Set([
  "https://api.weather.gc.ca",
  "https://api.weather.gov",
]);

/** Content-hashed, immutable year files: /data/2026/tidal_primary.477a7ba9.json */
const HASHED_DATA_RE = /^\/data\/\d{4}\//;

/**
 * How long a navigation (or a data-pointer fetch) may wait for the
 * network before the cached copy answers instead. A phone PWA resumed
 * after hours idle has a radio that is neither up nor definitively
 * down — `fetch` doesn't reject, it hangs — and without a deadline the
 * user watches a blank standalone window. 2.5 s is above a normal
 * cold-start round-trip on a slow connection and far below the point
 * where a person concludes the app is broken.
 */
const NAV_TIMEOUT_MS = 2500;

/**
 * Entry caps for the unbounded-growth caches. Vector tiles run
 * ~10–80 KB each, so 600 entries is roughly a region's worth of
 * browsing (~20 MB) — enough to cover a cruising area offline without
 * eating the storage quota. The data cap only ever bites after many
 * data-correction deploys pile up stale-hash files; 60 entries is ~3×
 * a full three-year set.
 */
const TILE_CACHE_MAX = 600;
const DATA_CACHE_MAX = 60;

/**
 * Weather gets a laxer deadline: falling back means showing an
 * hour-old forecast, so a slow-but-alive connection deserves more
 * patience than a navigation — but the deadline must stay under the
 * app's own 15 s fetch abort (marineForecast.ts) or the fallback never
 * gets a chance to answer.
 */
const WEATHER_TIMEOUT_MS = 10000;

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(SHELL_CACHE).then((cache) => cache.addAll(PRECACHE)));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(
        names
          .filter((n) => n !== SHELL_CACHE && !RUNTIME_CACHES.has(n))
          .map((n) => caches.delete(n)),
      );
      await self.clients.claim();
      await warmDataCache();
    })(),
  );
});

/**
 * Fill the data cache from the worker itself on activate. Without this,
 * a first-time visitor's data fetches all happen BEFORE the worker has
 * registered and taken control, so nothing lands in the cache and
 * offline only starts working from the second online visit — the worst
 * possible failure mode for a boating app ("installed at the dock, no
 * data on the water"). Nearly free: the year files are immutable with a
 * one-year max-age, so these fetches are answered by the browser's HTTP
 * cache, not the network. Runs again on every deploy's activation,
 * which also backfills any year files added since. Reads the manifest's
 * per-year file fields tolerantly — unknown fields are ignored, missing
 * ones skipped — so manifest schema changes can't break activation.
 */
const MANIFEST_YEAR_FILE_KEYS = [
  "tidal_primary",
  "tidal_secondary",
  "current_primary",
  "current_secondary",
  "noaa_tidal_primary",
  "noaa_current_primary",
];

async function warmDataCache() {
  try {
    const cache = await caches.open(DATA_CACHE);
    const resp = await fetch("/data/manifest.json", { cache: "no-cache" });
    if (!resp.ok) return;
    await cache.put("/data/manifest.json", resp.clone());
    const manifest = await resp.json();
    const paths = ["/data/marine_zones.geojson"];
    for (const y of manifest.years ?? []) {
      for (const key of MANIFEST_YEAR_FILE_KEYS) {
        if (y[key]) paths.push(`/data/${y[key]}`);
      }
    }
    await Promise.all(
      paths.map(async (p) => {
        if (await cache.match(p, { ignoreVary: true })) return;
        const r = await fetch(p);
        if (r.ok) await cache.put(p, r);
      }),
    );
  } catch {
    // Offline or mid-flight failure: nothing to warm; runtime caching
    // still fills the cache on the next online session.
  }
}

// The update toast's "Refresh" path (registerSW.ts): promote the waiting
// worker; the page reloads on controllerchange.
self.addEventListener("message", (event) => {
  if (event.data === "SKIP_WAITING") self.skipWaiting();
});

/**
 * Race the network against a deadline; on timeout or failure fall back
 * to `cachedFallback()`. The loser of the race is never aborted: an
 * AbortController would kill the very response we might still need, and
 * a stray fetch settling in the background is harmless.
 */
async function networkFirst(request, cachedFallback, onSuccess, timeoutMs = NAV_TIMEOUT_MS) {
  const network = fetch(request);
  network.catch(() => {});
  let timer;
  try {
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("nav-timeout")), timeoutMs);
    });
    const response = await Promise.race([network, timeout]);
    if (onSuccess && response.ok) onSuccess(response.clone());
    return response;
  } catch {
    const cached = await cachedFallback();
    if (cached) return cached;
    // Nothing cached to fall back on: the slow network is still strictly
    // better than an error page.
    try {
      const response = await network;
      if (onSuccess && response.ok) onSuccess(response.clone());
      return response;
    } catch {
      return Response.error();
    }
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Cache-first with runtime fill: serve from `cacheName`, else fetch and
 * cache the response (via `event.waitUntil` so the put outlives the
 * respondWith). The text/html guard keeps an SPA-fallback answer to a
 * missing file from being cached under the file's key — sticky and
 * silent.
 */
async function cacheFirst(event, request, cacheName, trimTo, trimFilter) {
  const cached = await caches.match(request, { cacheName, ignoreVary: true });
  if (cached) return cached;
  const response = await fetch(request);
  if (response.ok) {
    const contentType = response.headers.get("content-type") || "";
    if (!contentType.includes("text/html")) {
      const copy = response.clone();
      event.waitUntil(
        (async () => {
          const cache = await caches.open(cacheName);
          await cache.put(request, copy);
          if (trimTo) await trimCache(cache, trimTo, trimFilter);
        })(),
      );
    }
  }
  return response;
}

/**
 * Drop the oldest entries beyond `max`. Cache keys are returned in
 * insertion order in practice, so this is an adequate LRU-ish bound —
 * precision doesn't matter, only that growth is capped.
 */
async function trimCache(cache, max, filter) {
  let keys = await cache.keys();
  if (filter) keys = keys.filter((k) => filter(new URL(k.url).pathname));
  for (const key of keys.slice(0, Math.max(0, keys.length - max))) {
    await cache.delete(key);
  }
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);

  if (url.origin === self.location.origin) {
    if (request.mode === "navigate") {
      // '/' is the canonical shell URL — Cloudflare Pages redirects
      // /index.html to it, and redirected cache entries can't answer
      // navigations. Scoped to THIS build's cache: during the
      // install→activate window two builds' caches coexist, and an
      // unscoped lookup can hand back the OLD shell whose asset URLs
      // this build no longer has (blank page, no error).
      event.respondWith(
        networkFirst(request, () => caches.match("/", { cacheName: SHELL_CACHE, ignoreVary: true })),
      );
      return;
    }

    if (HASHED_DATA_RE.test(url.pathname)) {
      event.respondWith(
        cacheFirst(event, request, DATA_CACHE, DATA_CACHE_MAX, (p) => HASHED_DATA_RE.test(p)),
      );
      return;
    }

    if (url.pathname.startsWith("/data/")) {
      // manifest.json / marine_zones.geojson: the freshness pointers.
      // Network-first so a new year's data is picked up immediately;
      // cached fallback so an offline launch still boots.
      event.respondWith(
        networkFirst(
          request,
          () => caches.match(request, { cacheName: DATA_CACHE, ignoreVary: true }),
          (copy) =>
            event.waitUntil(caches.open(DATA_CACHE).then((c) => c.put(request, copy))),
        ),
      );
      return;
    }

    // Shell assets: cache-first if precached, else passthrough.
    event.respondWith(
      (async () => {
        const cached = await caches.match(request, { cacheName: SHELL_CACHE, ignoreVary: true });
        return cached ?? fetch(request);
      })(),
    );
    return;
  }

  // -- Cross-origin ---------------------------------------------------

  if (url.origin === TILE_ORIGIN) {
    event.respondWith(cacheFirst(event, request, TILE_CACHE, TILE_CACHE_MAX));
    return;
  }

  if (WEATHER_ORIGINS.has(url.origin)) {
    event.respondWith(
      networkFirst(
        request,
        () => caches.match(request, { cacheName: WEATHER_CACHE, ignoreVary: true }),
        (copy) =>
          event.waitUntil(caches.open(WEATHER_CACHE).then((c) => c.put(request, copy))),
        WEATHER_TIMEOUT_MS,
      ),
    );
    return;
  }

  // Any other cross-origin request is none of our business.
});
