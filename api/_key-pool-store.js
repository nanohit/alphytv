import crypto from "node:crypto";

import { CATALOG_BLOB_URL } from "./_catalog-store.js";

export const KEY_POOL_PATH = "admin/key-pool.enc.json";
export const KEY_POOL_BLOB_URL =
  process.env.ALPHY_KEY_POOL_BLOB_URL ||
  new URL(`/${KEY_POOL_PATH}`, CATALOG_BLOB_URL).href;

const BLOB_API_URL = "https://vercel.com/api/blob/";
const BLOB_API_VERSION = "12";
const MAX_KEYS = 80;
const MAX_BODY_BYTES = 128 * 1024;
const PROVIDERS = new Set(["poiskkino", "unofficial"]);

function text(value, max = 500) {
  return String(value ?? "").trim().slice(0, max);
}

function masterSecret() {
  const secret = text(
    process.env.ALPHY_KEY_POOL_MASTER_KEY || process.env.BLOB_READ_WRITE_TOKEN,
    20_000,
  );
  if (!secret) throw new Error("key_pool_master_key_not_configured");
  return secret;
}

function encryptionKey() {
  return crypto.createHash("sha256")
    .update("alphy-key-pool\0v1\0")
    .update(masterSecret())
    .digest();
}

function generatedRuntimeToken() {
  return crypto.randomBytes(32).toString("base64url");
}

function validRuntimeToken(value) {
  const token = text(value, 200);
  return /^[A-Za-z0-9_-]{32,}$/.test(token) ? token : "";
}

function normalizeScopes(provider, value) {
  return {
    resolver: value?.resolver === true,
    recommendations: provider === "unofficial" && value?.recommendations === true,
    // Unofficial keys are intentionally distributable: they are free, CORS is
    // public, and direct requests preserve the viewer's egress IP. Existing
    // entries default on during this migration; PoiskKino can never opt in.
    browser: provider === "unofficial" && value?.browser !== false,
  };
}

function normalizeKey(value, previous = null) {
  const provider = text(value?.provider, 32);
  const keyValue = text(value?.value, 512);
  if (!PROVIDERS.has(provider) || !keyValue) return null;
  const now = new Date().toISOString();
  return {
    id: text(value?.id, 100) || previous?.id || crypto.randomUUID(),
    provider,
    label: text(value?.label, 80) || (provider === "poiskkino" ? "PoiskKino" : "Kinopoisk Unofficial"),
    value: keyValue,
    enabled: value?.enabled !== false,
    scopes: normalizeScopes(provider, value?.scopes),
    createdAt: text(previous?.createdAt || value?.createdAt, 40) || now,
    updatedAt: now,
  };
}

export function emptyKeyPool() {
  return {
    schema: 1,
    revision: 0,
    updatedAt: null,
    runtimeToken: generatedRuntimeToken(),
    keys: [],
  };
}

export function normalizeKeyPool(value, { nextRevision = null, previous = null } = {}) {
  const priorById = new Map((previous?.keys || []).map((entry) => [entry.id, entry]));
  const seenIds = new Set();
  const seenValues = new Set();
  const keys = [];
  for (const raw of Array.isArray(value?.keys) ? value.keys.slice(0, MAX_KEYS) : []) {
    const prior = priorById.get(text(raw?.id, 100)) || null;
    const entry = normalizeKey(raw, prior);
    if (!entry) continue;
    if (seenIds.has(entry.id)) entry.id = crypto.randomUUID();
    const dedupe = `${entry.provider}\0${entry.value}`;
    if (seenValues.has(dedupe)) continue;
    seenIds.add(entry.id);
    seenValues.add(dedupe);
    keys.push(entry);
  }
  const revision = nextRevision == null ? Number(value?.revision) : nextRevision;
  return {
    schema: 1,
    revision: Number.isInteger(revision) && revision >= 0 ? revision : 0,
    updatedAt: text(value?.updatedAt, 40) || null,
    runtimeToken:
      validRuntimeToken(value?.runtimeToken) ||
      validRuntimeToken(previous?.runtimeToken) ||
      generatedRuntimeToken(),
    keys,
  };
}

function encryptPool(pool) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", encryptionKey(), iv);
  cipher.setAAD(Buffer.from("alphy-key-pool:v1", "utf8"));
  const encrypted = Buffer.concat([
    cipher.update(JSON.stringify(pool), "utf8"),
    cipher.final(),
  ]);
  return JSON.stringify({
    schema: 1,
    alg: "A256GCM",
    iv: iv.toString("base64url"),
    tag: cipher.getAuthTag().toString("base64url"),
    data: encrypted.toString("base64url"),
  });
}

function decryptPool(envelope) {
  if (envelope?.schema !== 1 || envelope?.alg !== "A256GCM") {
    throw new Error("key_pool_envelope_invalid");
  }
  const decipher = crypto.createDecipheriv(
    "aes-256-gcm",
    encryptionKey(),
    Buffer.from(String(envelope.iv || ""), "base64url"),
  );
  decipher.setAAD(Buffer.from("alphy-key-pool:v1", "utf8"));
  decipher.setAuthTag(Buffer.from(String(envelope.tag || ""), "base64url"));
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(String(envelope.data || ""), "base64url")),
    decipher.final(),
  ]);
  return JSON.parse(decrypted.toString("utf8"));
}

export async function readKeyPool() {
  const url = new URL(KEY_POOL_BLOB_URL);
  url.searchParams.set("admin_read", Date.now().toString(36));
  const response = await fetch(url, { cache: "no-store" });
  if (response.status === 404) return { pool: emptyKeyPool(), exists: false };
  if (!response.ok) throw new Error(`key_pool_blob_read_failed:${response.status}`);
  const pool = normalizeKeyPool(decryptPool(await response.json()));
  return { pool, exists: true };
}

async function putEncryptedPool(body) {
  const token = text(process.env.BLOB_READ_WRITE_TOKEN, 20_000);
  if (!token) throw new Error("BLOB_READ_WRITE_TOKEN is not configured");
  const storeId = new URL(KEY_POOL_BLOB_URL).hostname.split(".")[0];
  if (!storeId) throw new Error("key_pool_store_id_missing");

  const requestUrl = new URL(BLOB_API_URL);
  requestUrl.searchParams.set("pathname", KEY_POOL_PATH);
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
    const responseText = await response.text();
    if (response.ok) return JSON.parse(responseText);
    lastError = new Error(`key_pool_blob_write_failed:${response.status}:${responseText.slice(0, 160)}`);
    if (response.status !== 429 && response.status < 500) break;
    await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)));
  }
  throw lastError || new Error("key_pool_blob_write_failed");
}

export async function writeKeyPool(rawPool, expectedRevision = null) {
  const current = await readKeyPool();
  if (Number.isInteger(expectedRevision) && expectedRevision !== current.pool.revision) {
    const error = new Error("key_pool_revision_conflict");
    error.code = "key_pool_revision_conflict";
    error.current = current.pool;
    throw error;
  }
  const pool = normalizeKeyPool(rawPool, {
    nextRevision: current.pool.revision + 1,
    previous: current.pool,
  });
  pool.updatedAt = new Date().toISOString();
  const body = encryptPool(pool);
  if (Buffer.byteLength(body, "utf8") > MAX_BODY_BYTES) {
    const error = new Error("key_pool_too_large");
    error.code = "key_pool_too_large";
    throw error;
  }
  const blob = await putEncryptedPool(body);
  return { pool, blobUrl: blob.url || KEY_POOL_BLOB_URL };
}

// Operational master-key rotation: caller must already hold a decrypted pool.
// Rewrites only the ciphertext envelope and deliberately keeps its revision.
export async function rewriteKeyPoolCiphertext(rawPool) {
  const pool = normalizeKeyPool(rawPool);
  const blob = await putEncryptedPool(encryptPool(pool));
  return { pool, blobUrl: blob.url || KEY_POOL_BLOB_URL };
}

export async function ensureKeyPool() {
  const current = await readKeyPool();
  if (current.exists) return current.pool;
  return (await writeKeyPool(current.pool, current.pool.revision)).pool;
}

export function runtimeTokenMatches(pool, supplied) {
  const expected = Buffer.from(String(pool?.runtimeToken || ""), "utf8");
  const actual = Buffer.from(String(supplied || ""), "utf8");
  return expected.length > 0 && expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

export function runtimePool(pool) {
  return {
    schema: 1,
    revision: pool.revision,
    updatedAt: pool.updatedAt,
    keys: pool.keys
      .filter((entry) => entry.enabled && (entry.scopes.resolver || entry.scopes.recommendations))
      .map((entry) => ({
        id: entry.id,
        provider: entry.provider,
        label: entry.label,
        value: entry.value,
        scopes: {
          resolver: entry.scopes.resolver,
          recommendations: entry.scopes.recommendations,
        },
      })),
  };
}

export function clientPool(pool) {
  return {
    schema: 1,
    revision: Number(pool?.revision) || 0,
    updatedAt: pool?.updatedAt || null,
    keys: (Array.isArray(pool?.keys) ? pool.keys : [])
      .filter((entry) => (
        entry.enabled && entry.provider === "unofficial" && entry.scopes?.browser === true
      ))
      .map((entry) => ({
        id: entry.id,
        value: entry.value,
      })),
  };
}

export async function importLegacyKeys(rawEntries) {
  const current = await readKeyPool();
  if (!current.exists) return { pool: current.pool, imported: 0 };
  const keys = [...current.pool.keys];
  const existing = new Map(keys.map((entry, index) => [`${entry.provider}\0${entry.value}`, index]));
  let imported = 0;
  let changed = false;
  for (const raw of Array.isArray(rawEntries) ? rawEntries.slice(0, MAX_KEYS) : []) {
    const provider = text(raw?.provider, 32);
    const value = text(raw?.value, 512);
    const dedupe = `${provider}\0${value}`;
    if (!PROVIDERS.has(provider) || !value) continue;
    if (existing.has(dedupe)) {
      const index = existing.get(dedupe);
      if (!keys[index].scopes.resolver) {
        keys[index] = {
          ...keys[index],
          scopes: { ...keys[index].scopes, resolver: true },
          updatedAt: new Date().toISOString(),
        };
        changed = true;
      }
      continue;
    }
    const entry = normalizeKey({
      provider,
      value,
      label: text(raw?.label, 80) || `Deno legacy ${provider}`,
      enabled: true,
      scopes: { resolver: true, recommendations: false },
    });
    if (!entry) continue;
    keys.push(entry);
    existing.set(dedupe, keys.length - 1);
    imported += 1;
    changed = true;
  }
  if (!changed) return { pool: current.pool, imported: 0 };
  const result = await writeKeyPool({ ...current.pool, keys }, current.pool.revision);
  return { pool: result.pool, imported };
}
