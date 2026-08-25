// Public curated-catalog cache layer.
//
// catalog.js still asks for /curated-live.json. We intercept only that one
// request and resolve it through a tiny 60-second Blob manifest. The manifest
// points at a unique snapshot URL, so a browser can keep the large JSON for a
// year without ever risking stale content after an admin save.
(function () {
  "use strict";

  const PUBLIC_CATALOG_PATH = "/curated-live.json";
  const MANIFEST_URL =
    "https://nvpuetq65dds3gtx.public.blob.vercel-storage.com/catalog/current.json";
  const MANIFEST_TTL_MS = 60 * 1000;
  const BLOB_HOST_SUFFIX = ".public.blob.vercel-storage.com";
  const nativeFetch = window.fetch.bind(window);

  let manifestPromise = null;
  let manifestExpiresAt = 0;

  function isTrustedSnapshotUrl(value) {
    try {
      const url = new URL(String(value || ""));
      return url.protocol === "https:" && url.hostname.endsWith(BLOB_HOST_SUFFIX);
    } catch {
      return false;
    }
  }

  async function loadManifest() {
    const now = Date.now();
    if (manifestPromise && now < manifestExpiresAt) return manifestPromise;

    manifestExpiresAt = now + MANIFEST_TTL_MS;
    manifestPromise = nativeFetch(MANIFEST_URL, {
      cache: "default",
      credentials: "omit",
    })
      .then(async (response) => {
        if (!response.ok) throw new Error(`catalog manifest ${response.status}`);
        const manifest = await response.json();
        if (!isTrustedSnapshotUrl(manifest?.blobUrl)) {
          throw new Error("catalog manifest has an invalid snapshot URL");
        }
        return manifest;
      })
      .catch((error) => {
        manifestPromise = null;
        manifestExpiresAt = 0;
        throw error;
      });

    return manifestPromise;
  }

  window.fetch = async function alphyCatalogFetch(input, init) {
    let requestUrl;
    try {
      requestUrl = new URL(input instanceof Request ? input.url : String(input), location.href);
    } catch {
      return nativeFetch(input, init);
    }

    if (requestUrl.origin !== location.origin || requestUrl.pathname !== PUBLIC_CATALOG_PATH) {
      return nativeFetch(input, init);
    }

    try {
      const manifest = await loadManifest();
      return await nativeFetch(manifest.blobUrl, {
        cache: "force-cache",
        credentials: "omit",
      });
    } catch {
      // Migration/failure safety: until current.json exists (or if Blob is
      // temporarily unavailable), keep using the old stable curated.json path.
      return nativeFetch(input, init);
    }
  };
})();
