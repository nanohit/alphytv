// Deno Deploy entrypoint for the AlphyTV resolver.
//
// Why this exists: the same resolver logic runs on Cloudflare Workers
// (worker/src/index.js), but a Worker executes on the Cloudflare PoP nearest
// the user, and the PoP serving Russian users gets EMPTY responses from
// mzona.net/getVideoSources (its egress IP is filtered). A non-Cloudflare host
// resolves fine (verified from RU via Deno's EU region). This wrapper reuses the
// exact same handler so there is a single source of truth — only the
// environment plumbing and a kpId->Zenith cache live here.
//
// The cache matters: mzona soft rate-limits per egress IP, and that IP is shared
// across Deno Deploy tenants. Caching each kpId->Zenith mapping (stable for days)
// means a popular title hits mzona ONCE, then serves from KV instantly — far
// fewer upstream calls, far less chance of tripping the rate limit.
//
// Deploy: Deno Deploy app, entrypoint `resolver-deno/main.js`. Set POISKKINO_TOKEN
// env var (needed for /search; /resolve-zona and /health do not need it).

import worker, { pickAllowOrigin } from "../worker/src/index.js";

const env = {
  // Primary metadata source (kinopoisk.dev / poiskkino). A POOL of keys may be set
  // comma-separated in POISKKINO_TOKENS (~200/day each, rotated by exhaustion); the
  // singular POISKKINO_TOKEN is still honoured. This is the only IMDb-capable source
  // (the unofficial fallback's search carries no IMDb), so keeping it funded keeps
  // IMDb ratings on the search page.
  POISKKINO_TOKENS: Deno.env.get("POISKKINO_TOKENS"),
  POISKKINO_TOKEN: Deno.env.get("POISKKINO_TOKEN"),
  POISKKINO_BASE_URL: Deno.env.get("POISKKINO_BASE_URL") || "https://api.poiskkino.dev",
  // Fallback metadata when the primary daily quota (200/day) is exhausted. A POOL
  // of kinopoiskapiunofficial keys (comma-separated in KINOPOISK_UNOFFICIAL_TOKENS,
  // ~500/day each) rotated by exhaustion; the singular var is still honoured.
  KINOPOISK_UNOFFICIAL_TOKENS: Deno.env.get("KINOPOISK_UNOFFICIAL_TOKENS"),
  KINOPOISK_UNOFFICIAL_TOKEN: Deno.env.get("KINOPOISK_UNOFFICIAL_TOKEN"),
  KINOPOISK_UNOFFICIAL_BASE_URL: Deno.env.get("KINOPOISK_UNOFFICIAL_BASE_URL") || "https://kinopoiskapiunofficial.tech",
  ALLOWED_ORIGIN:
    Deno.env.get("ALLOWED_ORIGIN") ||
    "https://alphytv.vercel.app,https://alphy.tv,https://www.alphy.tv,http://127.0.0.1:5177,http://localhost:5177",
};

// Persistent kpId -> Zenith cache. Deno KV is optional and is not automatically
// attached to every Deploy project. The edge Cache API needs no database setup,
// while the in-memory map protects a warm isolate. We use all available layers
// so a missing KV can never silently turn every page view into a fresh mzona
// request (mzona soft-rate-limits shared datacenter egress).
let kv = null;
try {
  kv = await Deno.openKv();
} catch {
  kv = null;
}
let edgeCache = null;
try {
  edgeCache = globalThis.caches?.open ? await globalThis.caches.open("alphy-zona-v1") : null;
} catch {
  edgeCache = null;
}
const zonaMemoryCache = new Map();
const zonaInflight = new Map();
const zenithMemoryCache = new Map();
const zenithInflight = new Map();
const CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const ZENITH_FRESH_MS = 60 * 60 * 1000;
const ZENITH_STALE_MS = 24 * 60 * 60 * 1000;

function corsHeadersFor(request) {
  const requestOrigin = request.headers.get("origin") || "";
  return {
    "access-control-allow-origin": pickAllowOrigin(requestOrigin, env.ALLOWED_ORIGIN),
    "access-control-allow-methods": "GET, OPTIONS",
    "access-control-allow-headers": "content-type, authorization",
    "vary": "Origin",
  };
}

function jsonResponse(request, body, status = 200, cacheControl = "no-store") {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: {
      ...corsHeadersFor(request),
      "content-type": "application/json; charset=utf-8",
      "cache-control": cacheControl,
    },
  });
}

function zonaCacheRequest(kpId) {
  return new Request(`https://alphy-zona-cache.invalid/${encodeURIComponent(kpId)}`);
}

async function readZonaCache(kpId) {
  const memoryHit = zonaMemoryCache.get(kpId);
  if (memoryHit?.embedUrl) return { ...memoryHit, cache: "memory" };

  if (kv) {
    try {
      const hit = await kv.get(["zona", kpId]);
      if (hit.value?.embedUrl) {
        zonaMemoryCache.set(kpId, hit.value);
        return { ...hit.value, cache: "kv" };
      }
    } catch {
      // Keep serving through the other cache layers.
    }
  }

  if (edgeCache) {
    try {
      const hit = await edgeCache.match(zonaCacheRequest(kpId));
      if (hit) {
        const value = await hit.json();
        if (value?.embedUrl) {
          zonaMemoryCache.set(kpId, value);
          return { ...value, cache: "edge" };
        }
      }
    } catch {
      // Keep serving through mzona.
    }
  }

  return null;
}

async function writeZonaCache(value) {
  if (!value?.kpId || !value?.embedUrl || !value?.zenithId) return;
  const stored = {
    kpId: String(value.kpId),
    zenithId: String(value.zenithId),
    zenithIds: value.zenithIds || [String(value.zenithId)],
    embedUrl: value.embedUrl,
  };
  zonaMemoryCache.set(stored.kpId, stored);

  const writes = [];
  if (kv) {
    writes.push(kv.set(["zona", stored.kpId], stored, { expireIn: CACHE_TTL_MS }));
  }
  if (edgeCache) {
    writes.push(edgeCache.put(
      zonaCacheRequest(stored.kpId),
      new Response(JSON.stringify(stored), {
        headers: {
          "content-type": "application/json; charset=utf-8",
          "cache-control": `public, max-age=${Math.floor(CACHE_TTL_MS / 1000)}`,
        },
      }),
    ));
  }
  await Promise.allSettled(writes);
}

async function resolveAndCacheZona(request, kpId) {
  const workerUrl = new URL(request.url);
  workerUrl.searchParams.set("kpId", kpId);
  const response = await worker.fetch(new Request(workerUrl, {
    method: request.method,
    headers: request.headers,
  }), env);
  try {
    const data = await response.clone().json();
    if (response.ok && data?.ok && data.embedUrl && data.zenithId) {
      await writeZonaCache(data);
    }
  } catch {
    // Preserve the original resolver response.
  }
  return response;
}

async function handleResolveZonaCached(request, url) {
  const kpId = (url.searchParams.get("kpId") || url.searchParams.get("id") || "").trim();
  if (!/^\d+$/.test(kpId)) return worker.fetch(request, env);

  const hit = await readZonaCache(kpId);
  if (hit?.embedUrl) {
    return jsonResponse(request, { ok: true, ...hit, cached: true }, 200, "public, max-age=300");
  }

  // Collapse simultaneous requests for the same title. Without this, one page
  // refresh can consume several scarce mzona calls before the first one caches.
  const inflightKey = `${kpId}|${request.headers.get("origin") || ""}`;
  if (!zonaInflight.has(inflightKey)) {
    const pending = resolveAndCacheZona(request, kpId).finally(() => zonaInflight.delete(inflightKey));
    zonaInflight.set(inflightKey, pending);
  }
  const response = await zonaInflight.get(inflightKey);
  // A Response body can be consumed only once; every waiter gets its own clone.
  return response.clone();
}

function zenithCacheRequest(id) {
  return new Request(`https://alphy-zenith-cache.invalid/${encodeURIComponent(id)}`);
}

async function readZenithCache(id) {
  let stored = zenithMemoryCache.get(id) || null;
  if (!stored && edgeCache) {
    try {
      const response = await edgeCache.match(zenithCacheRequest(id));
      if (response) {
        stored = await response.json();
        if (stored?.value?.hasSources) zenithMemoryCache.set(id, stored);
      }
    } catch {
      // A cache miss must never break the live resolver.
    }
  }
  if (!stored?.value?.hasSources || !stored.storedAt) return null;
  const age = Date.now() - stored.storedAt;
  if (age > ZENITH_STALE_MS) return null;
  return { ...stored, fresh: age <= ZENITH_FRESH_MS };
}

async function writeZenithCache(id, value) {
  const stored = { storedAt: Date.now(), value };
  zenithMemoryCache.set(id, stored);
  if (edgeCache) {
    await edgeCache.put(
      zenithCacheRequest(id),
      new Response(JSON.stringify(stored), {
        headers: {
          "content-type": "application/json; charset=utf-8",
          "cache-control": `public, max-age=${Math.floor(ZENITH_STALE_MS / 1000)}`,
        },
      }),
    ).catch(() => {});
  }
}

async function fetchAndCacheZenith(request, id) {
  const response = await worker.fetch(request, env);
  try {
    const value = await response.clone().json();
    if (response.ok && value?.ok && value?.hasSources) {
      await writeZenithCache(id, value);
    }
  } catch {
    // Preserve the upstream response unchanged.
  }
  return response;
}

async function handleZenithCached(request, url) {
  const idOrUrl = (url.searchParams.get("id") || url.searchParams.get("url") || "").trim();
  const id = idOrUrl.match(/(?:^|\/)(\d+)(?:$|[/?#])/)?.[1] || idOrUrl.match(/^\d+$/)?.[0] || "";
  if (!id) return worker.fetch(request, env);

  const cached = await readZenithCache(id);
  if (cached?.fresh) {
    return jsonResponse(request, { ...cached.value, cached: true }, 200, "public, max-age=300");
  }

  const inflightKey = `${id}|${request.headers.get("origin") || ""}`;
  if (!zenithInflight.has(inflightKey)) {
    const pending = fetchAndCacheZenith(request, id).finally(() => zenithInflight.delete(inflightKey));
    zenithInflight.set(inflightKey, pending);
  }
  const response = await zenithInflight.get(inflightKey);
  if (response.ok || !cached?.value) return response.clone();

  return jsonResponse(request, {
    ...cached.value,
    cached: true,
    stale: true,
  }, 200, "public, max-age=60");
}

Deno.serve((request) => {
  const url = new URL(request.url);
  if (request.method === "GET" && url.pathname === "/resolve-zona") {
    return handleResolveZonaCached(request, url);
  }
  if (request.method === "GET" && url.pathname === "/zenith") {
    return handleZenithCached(request, url);
  }
  if (request.method === "GET" && url.pathname === "/health" && url.searchParams.has("diag")) {
    return jsonResponse(request, {
      ok: true,
      service: "alphy-resolver",
      zonaCache: {
        kv: !!kv,
        edge: !!edgeCache,
        memoryEntries: zonaMemoryCache.size,
      },
      zenithCache: {
        edge: !!edgeCache,
        memoryEntries: zenithMemoryCache.size,
      },
    });
  }
  return worker.fetch(request, env);
});
