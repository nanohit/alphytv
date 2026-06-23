import { list, put } from "@vercel/blob";

export const CATALOG_PATH = "catalog/curated.json";
const MAX_LISTS = 24;
const MAX_ITEMS_PER_LIST = 60;
const MAX_BODY_BYTES = 512 * 1024;

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
  const item = {
    id: text(value?.id, 80) || crypto.randomUUID(),
    key,
    title,
    year: text(value?.year, 12),
    poster,
    backdrop,
    description: text(value?.description, 3000),
    isSeries: !!value?.isSeries,
    movieLength: positiveNumber(value?.movieLength),
    rating: {
      kp: positiveNumber(value?.rating?.kp),
      imdb: positiveNumber(value?.rating?.imdb),
    },
    target,
    cachedAt: text(value?.cachedAt, 40) || new Date().toISOString(),
  };
  if (!item.poster) delete item.poster;
  if (!item.backdrop) delete item.backdrop;
  if (!item.description) delete item.description;
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

async function catalogBlob() {
  const result = await list({ prefix: CATALOG_PATH, limit: 10 });
  return (result.blobs || []).find((blob) => blob.pathname === CATALOG_PATH) || null;
}

export async function readCatalog() {
  const blob = await catalogBlob();
  if (!blob?.url) return { catalog: emptyCatalog(), blobUrl: "" };
  const uncachedUrl = new URL(blob.url);
  uncachedUrl.searchParams.set("admin_read", Date.now().toString(36));
  const response = await fetch(uncachedUrl, { cache: "no-store" });
  if (!response.ok) throw new Error(`Blob catalog read failed: ${response.status}`);
  const catalog = normalizeCatalog(await response.json());
  return { catalog, blobUrl: blob.url };
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
  const blob = await put(CATALOG_PATH, body, {
    access: "public",
    allowOverwrite: true,
    addRandomSuffix: false,
    cacheControlMaxAge: 60,
    contentType: "application/json; charset=utf-8",
  });
  return { catalog, blobUrl: blob.url };
}
