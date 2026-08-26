// Instant curated-catalog bootstrap: jsDelivr first, Vercel/Blob only as fallbacks.
(function () {
  "use strict";

  const CONFIG_PATH = "/curated-config.json";
  const PUBLIC_CATALOG_PATH = "/curated-live.json";
  const ADMIN_CATALOG_PATH = "/api/admin/catalog";
  const PRIMARY_CDN_URL =
    "https://cdn.jsdelivr.net/gh/nanohit/alphytv@catalog-cdn/curated-fallback.json";
  const VERCEL_FALLBACK_URL = "/curated-fallback.json";
  const BLOB_MANIFEST_URL =
    "https://nvpuetq65dds3gtx.public.blob.vercel-storage.com/catalog/current.json";
  const BLOB_HOST_SUFFIX = ".public.blob.vercel-storage.com";
  const CACHE_KEY = "alphy.curated.public.v3";
  const REFRESH_KEY = "alphy.curated.public-refresh.v2";
  const REFRESH_MIN_MS = 5 * 60 * 1000;
  const nativeFetch = window.fetch.bind(window);

  let primaryPromise = null;
  let fallbackPromise = null;
  let blobPromise = null;
  let refreshPromise = null;
  let refreshScheduled = false;

  function revisionOf(value) {
    const revision = Number(value?.revision);
    return Number.isFinite(revision) && revision >= 0 ? revision : -1;
  }

  function validCatalog(value) {
    return value &&
      Number(value.schema) === 1 &&
      revisionOf(value) >= 0 &&
      Array.isArray(value.lists);
  }

  function jsonResponse(value) {
    return new Response(JSON.stringify(value), {
      status: 200,
      headers: { "content-type": "application/json; charset=utf-8" },
    });
  }

  function readCachedCatalog() {
    try {
      const saved = JSON.parse(localStorage.getItem(CACHE_KEY) || "null");
      if (!validCatalog(saved?.catalog)) return null;
      return saved.catalog;
    } catch {
      return null;
    }
  }

  function storeIfNewer(catalog) {
    if (!validCatalog(catalog)) return;
    try {
      const current = readCachedCatalog();
      if (current && revisionOf(current) > revisionOf(catalog)) return;
      localStorage.setItem(CACHE_KEY, JSON.stringify({
        revision: revisionOf(catalog),
        savedAt: Date.now(),
        catalog,
      }));
    } catch {
      // Storage is only an acceleration layer.
    }
  }

  function refreshedRecently() {
    try {
      const refreshedAt = Number(localStorage.getItem(REFRESH_KEY) || 0);
      return refreshedAt > 0 && Date.now() - refreshedAt < REFRESH_MIN_MS;
    } catch {
      return false;
    }
  }

  function markRefreshed() {
    try { localStorage.setItem(REFRESH_KEY, String(Date.now())); } catch { /* optional */ }
  }

  function isTrustedSnapshotUrl(value) {
    try {
      const url = new URL(String(value || ""));
      return url.protocol === "https:" && url.hostname.endsWith(BLOB_HOST_SUFFIX);
    } catch {
      return false;
    }
  }

  function activeCatalogState() {
    const api = window.alphyCatalog;
    const state = api?._test?.state;
    return api && state ? { api, state } : null;
  }

  function applyFreshWhenReady(catalog) {
    if (!validCatalog(catalog)) return;
    let attempts = 0;
    const attempt = () => {
      const active = activeCatalogState();
      if (!active) {
        if (attempts++ < 80) setTimeout(attempt, 25);
        return;
      }
      const { api, state } = active;
      if (api.isAdmin?.() || state.dirty) return;
      if (revisionOf(catalog) <= revisionOf(state.catalog)) return;
      state.catalog = catalog;
      api.render();
      try {
        window.dispatchEvent(new CustomEvent("alphy:catalog-refreshed", {
          detail: { revision: revisionOf(catalog), source: "jsdelivr" },
        }));
      } catch {
        // Rendering already happened; the event is informational only.
      }
    };
    attempt();
  }

  async function fetchCatalogJson(url, options) {
    const response = await nativeFetch(url, options);
    if (!response.ok) throw new Error(`catalog ${response.status}`);
    const catalog = await response.json();
    if (!validCatalog(catalog)) throw new Error("catalog payload is invalid");
    return catalog;
  }

  function loadPrimary() {
    if (primaryPromise) return primaryPromise;
    primaryPromise = fetchCatalogJson(PRIMARY_CDN_URL, {
      cache: "no-cache",
      credentials: "omit",
      mode: "cors",
    }).then((catalog) => {
      storeIfNewer(catalog);
      markRefreshed();
      applyFreshWhenReady(catalog);
      return catalog;
    }).finally(() => {
      primaryPromise = null;
    });
    return primaryPromise;
  }

  function loadVercelFallback() {
    if (fallbackPromise) return fallbackPromise;
    fallbackPromise = fetchCatalogJson(VERCEL_FALLBACK_URL, {
      cache: "force-cache",
      credentials: "omit",
    }).then((catalog) => {
      storeIfNewer(catalog);
      applyFreshWhenReady(catalog);
      return catalog;
    }).finally(() => {
      fallbackPromise = null;
    });
    return fallbackPromise;
  }

  function loadBlobFallback() {
    if (blobPromise) return blobPromise;
    blobPromise = (async () => {
      const manifestResponse = await nativeFetch(BLOB_MANIFEST_URL, {
        cache: "no-cache",
        credentials: "omit",
      });
      if (!manifestResponse.ok) throw new Error(`catalog manifest ${manifestResponse.status}`);
      const manifest = await manifestResponse.json();
      if (!isTrustedSnapshotUrl(manifest?.blobUrl)) {
        throw new Error("catalog manifest has an invalid snapshot URL");
      }
      const catalog = await fetchCatalogJson(manifest.blobUrl, {
        cache: "force-cache",
        credentials: "omit",
      });
      storeIfNewer(catalog);
      applyFreshWhenReady(catalog);
      return catalog;
    })().finally(() => {
      blobPromise = null;
    });
    return blobPromise;
  }

  function refreshInBackground() {
    refreshScheduled = false;
    if (refreshedRecently()) return;
    if (!refreshPromise) {
      refreshPromise = loadPrimary()
        .catch(() => null)
        .finally(() => { refreshPromise = null; });
    }
  }

  function scheduleRefresh() {
    if (refreshScheduled || refreshPromise || refreshedRecently()) return;
    refreshScheduled = true;
    if (typeof requestIdleCallback === "function") {
      requestIdleCallback(refreshInBackground, { timeout: 500 });
    } else {
      setTimeout(refreshInBackground, 0);
    }
  }

  // Cold open only: start jsDelivr before app.js parses. Warm opens already have
  // a synchronous local snapshot and do not need any render-blocking catalog I/O.
  if (!readCachedCatalog()) loadPrimary().catch(() => {});

  window.fetch = async function alphyCatalogFetch(input, init) {
    let requestUrl;
    try {
      requestUrl = new URL(input instanceof Request ? input.url : String(input), location.href);
    } catch {
      return nativeFetch(input, init);
    }

    if (requestUrl.origin !== location.origin) return nativeFetch(input, init);

    if (requestUrl.pathname === ADMIN_CATALOG_PATH) {
      const response = await nativeFetch(input, init);
      if (response.ok) {
        response.clone().json().then((payload) => {
          if (!validCatalog(payload?.catalog)) return;
          storeIfNewer(payload.catalog);
          markRefreshed();
        }).catch(() => {});
      }
      return response;
    }

    if (requestUrl.pathname === CONFIG_PATH) {
      return jsonResponse({
        blobUrl: PUBLIC_CATALOG_PATH,
        fallbackUrl: VERCEL_FALLBACK_URL,
      });
    }

    if (requestUrl.pathname !== PUBLIC_CATALOG_PATH) return nativeFetch(input, init);

    scheduleRefresh();

    const cached = readCachedCatalog();
    if (cached) return jsonResponse(cached);

    try {
      return jsonResponse(await loadPrimary());
    } catch {
      try {
        return jsonResponse(await loadVercelFallback());
      } catch {
        try {
          return jsonResponse(await loadBlobFallback());
        } catch {
          return nativeFetch(PUBLIC_CATALOG_PATH, {
            cache: "force-cache",
            credentials: "omit",
          });
        }
      }
    }
  };

  window.alphyCatalogCache = {
    primaryUrl: PRIMARY_CDN_URL,
    cachedRevision: () => revisionOf(readCachedCatalog()),
    refresh: () => loadPrimary(),
    fallback: () => loadVercelFallback().catch(() => loadBlobFallback()),
  };
})();
