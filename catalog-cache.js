// Instant curated-catalog bootstrap with stale-while-revalidate freshness.
//
// The public path stays entirely off Functions/Edge Config: a repeat visit is
// served synchronously from localStorage, while a first visit uses the
// deployment-baked fallback already sitting on Vercel's CDN. The mutable Blob
// catalog refreshes in the background and hot-applies only when it is newer.
(function () {
  "use strict";

  const CONFIG_PATH = "/curated-config.json";
  const PUBLIC_CATALOG_PATH = "/curated-live.json";
  const ADMIN_CATALOG_PATH = "/api/admin/catalog";
  const FALLBACK_URL = "/curated-fallback.json";
  const MANIFEST_URL =
    "https://nvpuetq65dds3gtx.public.blob.vercel-storage.com/catalog/current.json";
  const BLOB_HOST_SUFFIX = ".public.blob.vercel-storage.com";
  const CACHE_KEY = "alphy.curated.public.v2";
  const REFRESH_KEY = "alphy.curated.public-refresh.v1";
  const REFRESH_MIN_MS = 60 * 1000;
  const nativeFetch = window.fetch.bind(window);

  let fallbackPromise = null;
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
      // Storage is an acceleration layer only; Vercel static/Blob remain usable.
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
      // Never overwrite an admin's live edit/draft with a public refresh.
      if (api.isAdmin?.() || state.dirty) return;
      if (revisionOf(catalog) <= revisionOf(state.catalog)) return;
      state.catalog = catalog;
      api.render();
      try {
        window.dispatchEvent(new CustomEvent("alphy:catalog-refreshed", {
          detail: { revision: revisionOf(catalog) },
        }));
      } catch {
        // CustomEvent is only informational; rendering already happened.
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

  function loadFallback() {
    if (fallbackPromise) return fallbackPromise;
    fallbackPromise = fetchCatalogJson(FALLBACK_URL, {
      cache: "force-cache",
      credentials: "omit",
    }).then((catalog) => {
      storeIfNewer(catalog);
      applyFreshWhenReady(catalog);
      return catalog;
    }).catch((error) => {
      fallbackPromise = null;
      throw error;
    });
    return fallbackPromise;
  }

  async function loadLiveCatalog() {
    const manifestResponse = await nativeFetch(MANIFEST_URL, {
      cache: "default",
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
    markRefreshed();
    applyFreshWhenReady(catalog);
    return catalog;
  }

  function refreshInBackground() {
    refreshScheduled = false;
    if (refreshedRecently()) return;
    if (!refreshPromise) {
      refreshPromise = loadLiveCatalog()
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

  // Start the same-origin CDN read before the large app.js gets parsed. On a
  // cold browser this normally finishes by the time catalog.js asks for data.
  loadFallback().catch(() => {});

  window.fetch = async function alphyCatalogFetch(input, init) {
    let requestUrl;
    try {
      requestUrl = new URL(input instanceof Request ? input.url : String(input), location.href);
    } catch {
      return nativeFetch(input, init);
    }

    if (requestUrl.origin !== location.origin) return nativeFetch(input, init);

    // An admin GET/PUT is already authoritative. Mirror a successful response
    // into the public browser cache so the editor's next normal open sees the
    // just-saved revision immediately instead of waiting for Blob revalidation.
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

    // catalog.js historically fetched this tiny config before it could even ask
    // for the catalog. The values are deployment constants, so remove that RTT.
    if (requestUrl.pathname === CONFIG_PATH) {
      return jsonResponse({
        blobUrl: PUBLIC_CATALOG_PATH,
        fallbackUrl: FALLBACK_URL,
      });
    }

    if (requestUrl.pathname !== PUBLIC_CATALOG_PATH) return nativeFetch(input, init);

    scheduleRefresh();

    // Warm open: zero network on the render-critical path.
    const cached = readCachedCatalog();
    if (cached) return jsonResponse(cached);

    // Cold open: use the deployment-baked snapshot from Vercel's static CDN.
    try {
      return jsonResponse(await loadFallback());
    } catch {
      // If the static asset is unavailable, try the live Blob path; if that also
      // fails, preserve the old same-origin path as the final migration fallback.
      try {
        return jsonResponse(await loadLiveCatalog());
      } catch {
        return nativeFetch(PUBLIC_CATALOG_PATH, {
          cache: "force-cache",
          credentials: "omit",
        });
      }
    }
  };

  window.alphyCatalogCache = {
    cachedRevision: () => revisionOf(readCachedCatalog()),
    refresh: () => loadLiveCatalog(),
  };
})();
