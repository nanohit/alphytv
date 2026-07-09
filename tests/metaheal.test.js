import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

// Loads the real app.js in a vm with a stub DOM and verifies the watch-page
// meta pipeline for kinds that carry no kpId (Ortified/Opravar):
//   1. a rotted (bare) ort history entry heals from the published curated catalog
//   2. onOrtProgress cannot clobber stored rating/movieLength/title
//   3. openCuratedItem's meta handoff survives localStorage quota exhaustion
const code = await readFile(new URL("../app.js", import.meta.url), "utf8");

const EMBED = "https://api.ortified.ws/embed/movie/88776";
const ORT_KEY = `ort:${EMBED}`;
const CATALOG = {
  schema: 1, revision: 243, forYou: "on",
  lists: [{ id: "l1", title: "Новинки", items: [{
    id: "x1", key: ORT_KEY, title: "Обсессия", year: "2025",
    poster: "https://static.cdnlbox.club/poster/web/2025/obsession.webp",
    description: "Безнадежный романтик Беар давно влюблён.",
    isSeries: false, movieLength: 109, rating: { kp: 7.251, imdb: 8.1 },
    target: { kind: "ort", embedUrl: EMBED },
  }] }],
};

function makeSandbox({ storageSeed = new Map(), catalog = CATALOG, quotaLimit = Infinity, startPath = "/" } = {}) {
  const storage = new Map(storageSeed);
  let used = [...storage.entries()].reduce((n, [k, v]) => n + k.length + String(v).length, 0);
  const localStorage = {
    getItem: (k) => (storage.has(k) ? storage.get(k) : null),
    setItem: (k, v) => {
      const value = String(v);
      const delta = k.length + value.length - (storage.has(k) ? k.length + storage.get(k).length : 0);
      if (used + delta > quotaLimit) { const e = new Error("QuotaExceededError"); e.name = "QuotaExceededError"; throw e; }
      used += delta; storage.set(k, value);
    },
    removeItem: (k) => { if (storage.has(k)) { used -= k.length + storage.get(k).length; storage.delete(k); } },
    key: (i) => [...storage.keys()][i] ?? null,
    get length() { return storage.size; },
  };

  const listeners = { window: {}, document: {} };
  function makeEl() {
    const store = { innerHTML: "", textContent: "", value: "", className: "", hidden: false };
    const classes = new Set();
    return new Proxy({}, {
      get(_, prop) {
        if (prop in store) return store[prop];
        switch (prop) {
          case "classList": return { add: (...c) => c.forEach((x) => classes.add(x)), remove: (...c) => c.forEach((x) => classes.delete(x)), toggle: (c, f) => (f ? classes.add(c) : classes.delete(c)), contains: (c) => classes.has(c) };
          case "style": return new Proxy({}, { get: () => () => {}, set: () => true });
          case "dataset": return {};
          case "children": case "childNodes": return [];
          case "querySelectorAll": return () => [];
          case "querySelector": case "closest": return () => null;
          case "appendChild": case "insertBefore": return (x) => x;
          case "getBoundingClientRect": return () => ({ top: 0, left: 0, width: 0, height: 0, right: 0, bottom: 0 });
          case "parentElement": case "parentNode": case "firstChild": case "nextSibling": return null;
          case "offsetWidth": case "offsetHeight": case "clientWidth": case "clientHeight": case "scrollLeft": case "scrollWidth": case "videoWidth": case "videoHeight": case "duration": case "currentTime": return 0;
          case "nodeType": return 1;
          case "tagName": return "DIV";
          case "getContext": return () => null;
          case "hasAttribute": case "contains": case "matches": return () => false;
          case "getAttribute": return () => null;
          case "play": case "load": return () => Promise.resolve();
          default: return () => {};
        }
      },
      set(_, prop, value) { store[prop] = value; return true; },
    });
  }

  const location = { pathname: startPath, search: "", hash: "", origin: "https://alphy.tv", host: "alphy.tv", hostname: "alphy.tv", href: `https://alphy.tv${startPath}`, protocol: "https:", assign: () => {}, replace: () => {}, reload: () => {} };
  const historyObj = {
    pushState: (_s, _t, url) => { if (typeof url === "string") { const u = new URL(url, "https://alphy.tv"); location.pathname = u.pathname; location.search = u.search; location.hash = u.hash; location.href = u.href; } },
    replaceState: (...a) => historyObj.pushState(...a),
    state: null, back: () => {}, length: 1,
  };

  const fetchStub = async (input) => {
    const url = String(input);
    const json = (body) => ({ ok: true, status: 200, headers: { get: () => "application/json" }, json: async () => body, text: async () => JSON.stringify(body) });
    if (url.includes("curated-config.json")) return json({ blobUrl: "/curated-live.json", fallbackUrl: "/curated-fallback.json" });
    if (url.includes("curated-live.json") || url.includes("curated-fallback.json")) return json(catalog);
    return { ok: false, status: 503, headers: { get: () => "" }, json: async () => ({}), text: async () => "" };
  };

  const documentObj = new Proxy({}, {
    get(_, prop) {
      switch (prop) {
        case "getElementById": case "createElement": return () => makeEl();
        case "createTextNode": return (t) => ({ nodeType: 3, textContent: t });
        case "addEventListener": return (type, fn) => { (listeners.document[type] ||= []).push(fn); };
        case "removeEventListener": return () => {};
        case "querySelector": return () => null;
        case "querySelectorAll": return () => [];
        case "body": case "documentElement": case "head": return makeEl();
        case "title": return "";
        case "visibilityState": return "visible";
        case "hidden": return false;
        case "fullscreenElement": return null;
        case "readyState": return "complete";
        default: return () => {};
      }
    },
    set: () => true,
  });

  const sandbox = {
    console, JSON, Math, Date, Promise, Number, String, Boolean, Array, Object, Set, Map, WeakMap, WeakSet, Symbol, Error, TypeError, RangeError, RegExp, parseInt, parseFloat, isFinite, isNaN, encodeURIComponent, decodeURIComponent, encodeURI, decodeURI, Infinity, NaN, undefined,
    setTimeout, clearTimeout, setInterval, clearInterval, queueMicrotask,
    URL, URLSearchParams, AbortController, TextDecoder, TextEncoder, Blob,
    atob: (s) => Buffer.from(s, "base64").toString("binary"),
    btoa: (s) => Buffer.from(s, "binary").toString("base64"),
    crypto: { randomUUID: () => "00000000-0000-4000-8000-000000000000", getRandomValues: (a) => a, subtle: { digest: async () => new ArrayBuffer(32) } },
    fetch: fetchStub,
    localStorage,
    sessionStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    location, history: historyObj, document: documentObj,
    navigator: { userAgent: "vm-test", language: "ru", languages: ["ru"], clipboard: { writeText: async () => {} }, mediaSession: null },
    screen: { width: 1440, height: 900 },
    innerWidth: 1440, innerHeight: 900, devicePixelRatio: 2,
    matchMedia: () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {} }),
    requestAnimationFrame: (fn) => setTimeout(fn, 16), cancelAnimationFrame: (id) => clearTimeout(id),
    CustomEvent: class { constructor(type, opts) { this.type = type; this.detail = opts?.detail; } },
    Event: class { constructor(type) { this.type = type; } },
    IntersectionObserver: class { observe() {} unobserve() {} disconnect() {} },
    ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
    MutationObserver: class { observe() {} disconnect() {} },
    Image: class { set src(_) { setTimeout(() => this.onerror?.(), 1); } },
    XMLHttpRequest: class { open() {} send() { setTimeout(() => this.onerror?.(new Error("no net")), 1); } setRequestHeader() {} abort() {} },
    DOMParser: class { parseFromString() { return documentObj; } },
    postMessage: () => {},
    getComputedStyle: () => ({ getPropertyValue: () => "" }),
    scrollTo: () => {},
    alert: () => {}, confirm: () => false,
    performance: { now: () => Date.now() },
    structuredClone: (x) => JSON.parse(JSON.stringify(x)),
    Hls: undefined, shaka: undefined,
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.self = sandbox;
  sandbox.top = sandbox;
  sandbox.addEventListener = (type, fn) => { (listeners.window[type] ||= []).push(fn); };
  sandbox.removeEventListener = () => {};
  sandbox.dispatchEvent = () => true;
  vm.createContext(sandbox);
  return { sandbox, storage, listeners, run: () => vm.runInContext(code, sandbox) };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("rotted ort history entry heals from the curated catalog", async () => {
  const seed = new Map();
  seed.set("alphy.history", JSON.stringify([{
    key: ORT_KEY, kind: "ort", target: { kind: "ort", embedUrl: EMBED },
    title: "", poster: "", year: "", progress: 0.3, position: 300, duration: 1000, updatedAt: Date.now() - 86400e3,
  }]));
  const ctx = makeSandbox({ storageSeed: seed, startPath: "/o/88776" });
  ctx.run();
  await sleep(400);
  const hist = JSON.parse(ctx.storage.get("alphy.history") || "[]");
  const entry = hist.find((h) => h.key === ORT_KEY);
  assert.equal(entry?.title, "Обсессия", "title healed from catalog");
  assert.ok(entry?.poster, "poster healed");
  assert.equal(entry?.year, "2025");
  assert.ok(entry?.progress > 0.2, "progress preserved through the heal");
  const ortmetaRaw = ctx.storage.get(`alphy.cache.ortmeta:${EMBED}`);
  const ortmeta = ortmetaRaw ? JSON.parse(ortmetaRaw).v : null;
  assert.ok(ortmeta?.description && ortmeta?.rating?.kp, "ortmeta cache refreshed with description+rating");
});

test("ort progress reports cannot clobber stored meta", async () => {
  const seed = new Map();
  seed.set("alphy.history", JSON.stringify([{
    key: ORT_KEY, kind: "ort", target: { kind: "ort", embedUrl: EMBED },
    title: "Обсессия", poster: "https://p/x.webp", year: "2025",
    rating: { kp: 7.251, imdb: 8.1 }, movieLength: 109,
    progress: 0.3, position: 300, duration: 1000, updatedAt: Date.now() - 86400e3,
  }]));
  // Empty catalog: nothing to heal from, currentMeta arrives with rating {} —
  // the exact setup that used to wipe stored ratings on every progress tick.
  const ctx = makeSandbox({ storageSeed: seed, startPath: "/o/88776", catalog: { schema: 1, revision: 1, lists: [] } });
  ctx.run();
  await sleep(300);
  const handlers = ctx.listeners.window.message || [];
  assert.ok(handlers.length, "message handlers registered");
  for (const fn of handlers) {
    try { fn({ data: { alphyOrtProgress: true, position: 500, duration: 1000 }, origin: "https://api.ortified.ws" }); } catch { /* other listeners */ }
  }
  await sleep(50);
  const hist = JSON.parse(ctx.storage.get("alphy.history") || "[]");
  const entry = hist.find((h) => h.key === ORT_KEY);
  assert.equal(entry?.title, "Обсессия");
  assert.equal(entry?.rating?.kp, 7.251, "rating survives a bare progress tick");
  assert.equal(entry?.movieLength, 109);
  assert.equal(entry?.progress, 0.5, "progress itself is recorded");
});

// Real catalog series keys look like ?season=1&episode=1&episode=1 (duplicated
// param from the admin add flow) while the router rebuilds a clean query — the
// mismatch left every ort series bare even right after a curated click.
const SERIES_EMBED_DIRTY = "https://api.ortified.ws/embed/movie/73418?season=1&episode=1&episode=1";
const SERIES_EMBED_CLEAN = "https://api.ortified.ws/embed/movie/73418?season=1&episode=1";
const SERIES_CATALOG = {
  schema: 1, revision: 244, lists: [{ id: "l1", title: "Анимация", items: [{
    id: "x2", key: `ort:${SERIES_EMBED_DIRTY}`, title: "Задорные друзья", year: "2020",
    poster: "https://static.cdnlbox.club/poster/web/smiling.webp",
    description: "Пим и Чарли поднимают людям настроение.",
    isSeries: true, rating: { kp: 8.2, imdb: 8.5 },
    target: { kind: "ort", embedUrl: SERIES_EMBED_DIRTY },
  }] }],
};

test("ort series heals despite duplicated query params in the catalog key", async () => {
  // Cold private-mode start: empty localStorage, deep link to a series episode.
  const ctx = makeSandbox({ startPath: "/o/73418/s1e1", catalog: SERIES_CATALOG });
  ctx.run();
  await sleep(400);
  const hist = JSON.parse(ctx.storage.get("alphy.history") || "[]");
  const entry = hist.find((h) => h.key === `ort:${SERIES_EMBED_CLEAN}`);
  assert.equal(entry?.title, "Задорные друзья", "series title healed via base-URL key match");
  assert.ok(entry?.poster, "series poster healed");
  const ortmetaRaw = ctx.storage.get(`alphy.cache.ortmeta:${SERIES_EMBED_CLEAN}`);
  const ortmeta = ortmetaRaw ? JSON.parse(ortmetaRaw).v : null;
  assert.ok(ortmeta?.rating?.kp, "ortmeta cached under the clean URL the router uses");
});

test("curated series click hands meta to the watch page under the clean URL", async () => {
  const ctx = makeSandbox({ catalog: SERIES_CATALOG });
  ctx.run();
  await sleep(150);
  ctx.sandbox.window.alphyBridge.openCuratedItem(SERIES_CATALOG.lists[0].items[0]);
  await sleep(300);
  const ortmetaRaw = ctx.storage.get(`alphy.cache.ortmeta:${SERIES_EMBED_CLEAN}`);
  const ortmeta = ortmetaRaw ? JSON.parse(ortmetaRaw).v : null;
  assert.equal(ortmeta?.title, "Задорные друзья", "handoff keyed by the router's clean URL");
  const hist = JSON.parse(ctx.storage.get("alphy.history") || "[]");
  const entry = hist.find((h) => h.key === `ort:${SERIES_EMBED_CLEAN}`);
  assert.equal(entry?.title, "Задорные друзья", "history entry created with the curated title");
});

test("curated click meta handoff survives quota exhaustion", async () => {
  const seed = new Map();
  let junkSize = 0;
  for (let i = 0; i < 40; i += 1) {
    const key = `alphy.cache.zona:junk${i}`;
    const value = JSON.stringify({ v: "x".repeat(2000), exp: Date.now() - 3600e3 });
    seed.set(key, value); junkSize += key.length + value.length;
  }
  const ctx = makeSandbox({ storageSeed: seed, startPath: "/", quotaLimit: junkSize + 1500 });
  ctx.run();
  await sleep(150);
  ctx.sandbox.window.alphyBridge.openCuratedItem(CATALOG.lists[0].items[0]);
  await sleep(300);
  const ortmetaRaw = ctx.storage.get(`alphy.cache.ortmeta:${EMBED}`);
  const ortmeta = ortmetaRaw ? JSON.parse(ortmetaRaw).v : null;
  assert.equal(ortmeta?.title, "Обсессия", "ortmeta handoff written despite quota pressure");
  const junkLeft = [...ctx.storage.keys()].filter((k) => k.startsWith("alphy.cache.zona:junk")).length;
  assert.equal(junkLeft, 0, "expired cache entries evicted to free space");
  const hist = JSON.parse(ctx.storage.get("alphy.history") || "[]");
  assert.equal(hist.find((h) => h.key === ORT_KEY)?.title, "Обсессия", "history entry carries the curated title");
});
