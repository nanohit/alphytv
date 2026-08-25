import {
  CATALOG_BLOB_URL,
  normalizeCatalog,
  readCatalog as readLegacyCatalog,
} from "./_catalog-store.js";

const BLOB_API_URL = "https://vercel.com/api/blob/";
const BLOB_API_VERSION = "12";
const CATALOG_PATH = "catalog/curated.json";
const POINTER_PATH = "catalog/current.json";
const MAX_BODY_BYTES = 512 * 1024;
const POINTER_MAX_AGE = 60;
const VERSION_MAX_AGE = 365 * 24 * 60 * 60;

const STORE_ORIGIN = new URL(CATALOG_BLOB_URL).origin;
export const CATALOG_POINTER_URL =
  process.env.ALPHY_CATALOG_POINTER_URL ||
  new URL(POINTER_PATH, `${STORE_ORIGIN}/`).href;

function adminReadUrl(value) {
  const url = new URL(value);
  url.searchParams.set("admin_read", `${Date.now().toString(36)}-${crypto.randomUUID()}`);
  return url;
}

function trustedSnapshotUrl(value) {
  try {
    const url = new URL(String(value || ""));
    return url.protocol === "https:" && url.origin === STORE_ORIGIN ? url : null;
  } catch {
    return null;
  }
}

async function readVersionedCatalog() {
  const manifestResponse = await fetch(adminReadUrl(CATALOG_POINTER_URL), { cache: "no-store" });
  if (!manifestResponse.ok) {
    throw new Error(`Blob catalog manifest read failed: ${manifestResponse.status}`);
  }

  const manifest = await manifestResponse.json();
  const snapshotUrl = trustedSnapshotUrl(manifest?.blobUrl);
  if (!snapshotUrl) throw new Error("Blob catalog manifest has an invalid snapshot URL");

  const catalogResponse = await fetch(adminReadUrl(snapshotUrl), { cache: "no-store" });
  if (!catalogResponse.ok) {
    throw new Error(`Blob catalog snapshot read failed: ${catalogResponse.status}`);
  }

  const catalog = normalizeCatalog(await catalogResponse.json());
  return {
    catalog,
    blobUrl: snapshotUrl.href,
    manifestUrl: CATALOG_POINTER_URL,
  };
}

export async function readCatalog() {
  try {
    return await readVersionedCatalog();
  } catch {
    // Before the first save after this migration there is no current.json yet.
    // The old stable blob remains authoritative until the first versioned write.
    const legacy = await readLegacyCatalog();
    return { ...legacy, manifestUrl: CATALOG_POINTER_URL };
  }
}

async function putBlob(pathname, body, { maxAge, allowOverwrite }) {
  const token = String(process.env.BLOB_READ_WRITE_TOKEN || "").trim();
  if (!token) throw new Error("BLOB_READ_WRITE_TOKEN is not configured");

  const storeId = new URL(CATALOG_BLOB_URL).hostname.split(".")[0];
  if (!storeId) throw new Error("Could not determine Blob store id");

  const requestUrl = new URL(BLOB_API_URL);
  requestUrl.searchParams.set("pathname", pathname);
  let lastError = null;

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const response = await fetch(requestUrl, {
      method: "PUT",
      headers: {
        "Authorization": `Bearer ${token}`,
        "x-api-version": BLOB_API_VERSION,
        "x-api-blob-request-id": `${storeId}:${Date.now()}:${crypto.randomUUID()}`,
        "x-api-blob-request-attempt": String(attempt),
        "x-vercel-blob-store-id": storeId,
        "x-vercel-blob-access": "public",
        "x-add-random-suffix": "0",
        "x-allow-overwrite": allowOverwrite ? "1" : "0",
        "x-cache-control-max-age": String(maxAge),
        "x-content-type": "application/json; charset=utf-8",
      },
      body,
    });

    const text = await response.text();
    if (response.ok) {
      const result = JSON.parse(text);
      if (!result?.url) throw new Error("Blob write returned no URL");
      return result;
    }

    lastError = new Error(`Blob write failed: ${response.status} ${text.slice(0, 180)}`);
    if (response.status !== 429 && response.status < 500) break;
    await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)));
  }

  throw lastError || new Error("Blob write failed");
}

export async function writeCatalog(rawCatalog, expectedRevision) {
  const current = await readCatalog();
  if (Number.isInteger(expectedRevision) && expectedRevision !== current.catalog.revision) {
    const error = new Error("catalog_revision_conflict");
    error.code = "catalog_revision_conflict";
    error.current = current;
    throw error;
  }

  const catalog = normalizeCatalog(rawCatalog, {
    nextRevision: current.catalog.revision + 1,
  });
  catalog.updatedAt = new Date().toISOString();

  const body = JSON.stringify(catalog);
  if (Buffer.byteLength(body, "utf8") > MAX_BODY_BYTES) {
    const error = new Error("catalog_too_large");
    error.code = "catalog_too_large";
    throw error;
  }

  // Never overwrite a snapshot that a browser may cache for a year. A random
  // suffix also makes a retry safe if a previous attempt wrote the snapshot but
  // failed before it could publish the pointer.
  const versionPath = [
    `catalog/curated-r${catalog.revision}`,
    Date.now().toString(36),
    crypto.randomUUID().slice(0, 8),
  ].join("-") + ".json";

  const snapshot = await putBlob(versionPath, body, {
    maxAge: VERSION_MAX_AGE,
    allowOverwrite: false,
  });

  // Keep the old stable object current for pre-deploy/open-tab clients and as a
  // migration fallback. New clients do not use it once current.json exists.
  await putBlob(CATALOG_PATH, body, {
    maxAge: POINTER_MAX_AGE,
    allowOverwrite: true,
  });

  const manifest = {
    schema: 1,
    revision: catalog.revision,
    updatedAt: catalog.updatedAt,
    blobUrl: snapshot.url,
  };
  await putBlob(POINTER_PATH, JSON.stringify(manifest), {
    maxAge: POINTER_MAX_AGE,
    allowOverwrite: true,
  });

  return {
    catalog,
    blobUrl: snapshot.url,
    manifestUrl: CATALOG_POINTER_URL,
  };
}
