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
  POISKKINO_TOKEN: Deno.env.get("POISKKINO_TOKEN"),
  POISKKINO_BASE_URL: Deno.env.get("POISKKINO_BASE_URL") || "https://api.poiskkino.dev",
  ALLOWED_ORIGIN:
    Deno.env.get("ALLOWED_ORIGIN") ||
    "https://alphytv.vercel.app,https://alphy.tv,https://www.alphy.tv,http://127.0.0.1:5177,http://localhost:5177",
};

// Persistent kpId -> Zenith cache. Optional: if KV is unavailable we just skip
// caching and resolve every time.
let kv = null;
try {
  kv = await Deno.openKv();
} catch {
  kv = null;
}
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

function corsHeadersFor(request) {
  const requestOrigin = request.headers.get("origin") || "";
  return {
    "access-control-allow-origin": pickAllowOrigin(requestOrigin, env.ALLOWED_ORIGIN),
    "access-control-allow-methods": "GET, OPTIONS",
    "access-control-allow-headers": "content-type, authorization",
    "vary": "Origin",
  };
}

function jsonResponse(request, body, status = 200) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: {
      ...corsHeadersFor(request),
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

async function handleResolveZonaCached(request, url) {
  const kpId = (url.searchParams.get("kpId") || url.searchParams.get("id") || "").trim();
  if (!/^\d+$/.test(kpId)) return worker.fetch(request, env);

  const key = ["zona", kpId];
  const hit = await kv.get(key);
  if (hit.value && hit.value.embedUrl) {
    return jsonResponse(request, { ok: true, ...hit.value, cached: true });
  }

  const response = await worker.fetch(request, env);
  // Cache only a real, successful resolve so a transient rate-limited null is
  // never persisted.
  try {
    const data = await response.clone().json();
    if (data && data.ok && data.embedUrl && data.zenithId) {
      await kv.set(
        key,
        { kpId: data.kpId, zenithId: data.zenithId, zenithIds: data.zenithIds, embedUrl: data.embedUrl },
        { expireIn: CACHE_TTL_MS },
      );
    }
  } catch {
    // non-JSON / error response — leave uncached
  }
  return response;
}

Deno.serve((request) => {
  const url = new URL(request.url);
  if (kv && request.method === "GET" && url.pathname === "/resolve-zona") {
    return handleResolveZonaCached(request, url);
  }
  return worker.fetch(request, env);
});
