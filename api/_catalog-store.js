export const CATALOG_PATH = "catalog/curated.json";
export const CATALOG_BLOB_URL =
  process.env.ALPHY_CATALOG_BLOB_URL ||
  "https://nvpuetq65dds3gtx.public.blob.vercel-storage.com/catalog/curated.json";
const BLOB_API_URL = "https://vercel.com/api/blob/";
const BLOB_API_VERSION = "12";
const MAX_LISTS = 24;
const MAX_ITEMS_PER_LIST = 60;
const MAX_BODY_BYTES = 512 * 1024;
const ITEM_LABEL_MAX = 32;

export function emptyCatalog() {
  return {
    schema: 1,
    revision: 0,
    updatedAt: null,
    lists: [],
  };
}

function text(value, max = 500) {
  return String(value ?? "").trim().slice(0, max);
}

function positiveNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function positiveIntegerText(value) {
  const textValue = text(value, 40);
  return /^\d+$/.test(textValue) ? textValue : "";
}

function normalizeExternalId(value) {
  const imdb = text(value?.imdb || value?.imdbId, 40);
  const tmdb = positiveIntegerText(value?.tmdb || value?.tmdbId);
  const externalId = {};
  if (/^tt\d{5,}$/i.test(imdb)) externalId.imdb = imdb;
  if (tmdb) externalId.tmdb = tmdb;
  return Object.keys(externalId).length ? externalId : null;
}

function publicHttpsUrl(value) {
  try {
    const url = new URL(String(value || ""));
    if (url.protocol !== "https:") return "";
    url.username = "";
    url.password = "";
    return url.href.slice(0, 3000);
  } catch {
    return "";
  }
}

function normalizeTarget(value) {
  const kind = text(value?.kind, 12);
  if (kind === "zen" && /^\d+$/.test(String(value?.zenithId || ""))) {
    return { kind, zenithId: String(value.zenithId) };
  }
  if (kind === "kp" && /^\d+$/.test(String(value?.kpId || ""))) {
    return { kind, kpId: String(value.kpId) };
  }
  if (kind === "ort") {
    const embedUrl = publicHttpsUrl(value?.embedUrl);
    if (/^https:\/\/api\.ortified\.ws\/embed\//i.test(embedUrl)) return { kind, embedUrl };
  }
  if (kind === "opr") {
    const playerUrl = publicHttpsUrl(value?.playerUrl);
    const pageUrl = publicHttpsUrl(value?.pageUrl);
    if (/^https:\/\/(?:gencit\.info|opravar\.online)\/bil\/\d+/i.test(playerUrl)) {
      return { kind, playerUrl, ...(pageUrl ? { pageUrl } : {}) };
    }
  }
  if (kind === "nd") {
    const pageUrl = publicHttpsUrl(value?.pageUrl);
    if (/(^|\.)newdeaf\.co\//i.test(pageUrl)) return { kind, pageUrl };
  }
  if (kind === "soap" && /^\d+$/.test(String(value?.soapId || ""))) {
    return { kind, soapId: String(value.soapId) };
  }
  if (kind === "clps" && /^\d+$/.test(String(value?.kpId || ""))) {
    const target = { kind, kpId: String(value.kpId) };
    const season = positiveIntegerText(value?.season);
    const episode = positiveIntegerText(value?.episode);
    if (season) target.season = Number(season);
    if (episode) target.episode = Number(episode);
    return target;
  }
  return null;
}

function normalizeItem(value) {
  const target = normalizeTarget(value?.target);
  if (!target) return null;
  const title = text(value?.title, 220);
  if (!title) return null;
  const key = text(value?.key, 300) || JSON.stringify(target);
  const poster = publicHttpsUrl(value?.poster);
  const backdrop = publicHttpsUrl(value?.backdrop);
  const label = text(value?.label, ITEM_LABEL_MAX).replace(/\s+/g, " ");
  const externalId = normalizeExternalId(value?.externalId || value?.externalIds);
  const item = {
    id: text(value?.id, 80) || crypto.randomUUID(),
    key,
    title,
    year: text(value?.year, 12),
    poster,
    backdrop,
    description: text(value?.description, 3000),
    label,
    isSeries: !!value?.isSeries,
    movieLength: positiveNumber(value?.movieLength),
    rating: {
      kp: positiveNumber(value?.rating?.kp),
      imdb: positiveNumber(value?.rating?.imdb),
    },
    ...(externalId ? { externalId } : {}),
    target,
    cachedAt: text(value?.cachedAt, 40) || new Date().toISOString(),
  };
  if (!item.poster) delete item.poster;
  if (!item.backdrop) delete item.backdrop;
  if (!item.description) delete item.description;
  if (!item.label) delete item.label;
  if (!item.year) delete item.year;
  if (item.movieLength == null) delete item.movieLength;
  if (item.rating.kp == null) delete item.rating.kp;
  if (item.rating.imdb == null) delete item.rating.imdb;
  return item;
}

export function normalizeCatalog(value, { nextRevision = null } = {}) {
  const seenIds = new Set();
  const lists = [];
  for (const rawList of Array.isArray(value?.lists) ? value.lists.slice(0, MAX_LISTS) : []) {
    const title = text(rawList?.title, 120) || "Новый список";
    let id = text(rawList?.id, 80) || crypto.randomUUID();
    if (seenIds.has(id)) id = crypto.randomUUID();
    seenIds.add(id);
    const itemKeys = new Set();
    const items = [];
    for (const rawItem of Array.isArray(rawList?.items) ? rawList.items.slice(0, MAX_ITEMS_PER_LIST) : []) {
      const item = normalizeItem(rawItem);
      if (!item || itemKeys.has(item.key)) continue;
      itemKeys.add(item.key);
      items.push(item);
    }
    lists.push({ id, title, items });
  }
  const revisionValue = nextRevision == null ? Number(value?.revision) : nextRevision;
  return {
    schema: 1,
    revision: Number.isInteger(revisionValue) && revisionValue >= 0 ? revisionValue : 0,
    updatedAt: text(value?.updatedAt, 40) || null,
    lists,
  };
}

export async function readCatalog() {
  const uncachedUrl = new URL(CATALOG_BLOB_URL);
  uncachedUrl.searchParams.set("admin_read", Date.now().toString(36));
  const response = await fetch(uncachedUrl, { cache: "no-store" });
  if (!response.ok) throw new Error(`Blob catalog read failed: ${response.status}`);
  const catalog = normalizeCatalog(await response.json());
  return { catalog, blobUrl: CATALOG_BLOB_URL };
}

async function putCatalogBlob(body) {
  const token = String(process.env.BLOB_READ_WRITE_TOKEN || "").trim();
  if (!token) throw new Error("BLOB_READ_WRITE_TOKEN is not configured");
  const storeId = new URL(CATALOG_BLOB_URL).hostname.split(".")[0];
  if (!storeId) throw new Error("Could not determine Blob store id");

  const requestUrl = new URL(BLOB_API_URL);
  requestUrl.searchParams.set("pathname", CATALOG_PATH);
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
        "x-allow-overwrite": "1",
        "x-cache-control-max-age": "60",
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
  // A direct Blob API request keeps the Function bundle tiny and avoids the
  // SDK's cold-start module crash observed in Vercel's Node runtime.
  const blob = await putCatalogBlob(body);
  return { catalog, blobUrl: blob.url };
}
