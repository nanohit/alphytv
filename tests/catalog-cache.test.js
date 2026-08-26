import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const source = fs.readFileSync(path.join(__dirname, "..", "catalog-cache.js"), "utf8");

function makeResponse(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function catalog(revision, title = `r${revision}`) {
  return { schema: 1, revision, updatedAt: null, lists: [{ id: "x", title, items: [] }] };
}

async function flush(ms = 15) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function harness({ cached = null, fallback = catalog(4), live = catalog(5), admin = false, dirty = false } = {}) {
  const store = new Map();
  if (cached) {
    store.set("alphy.curated.public.v2", JSON.stringify({
      revision: cached.revision,
      savedAt: 1,
      catalog: cached,
    }));
  }
  const calls = [];

  const nativeFetch = async (input) => {
    const url = new URL(String(input), "https://alphy.tv/");
    calls.push(url.href);
    if (url.pathname === "/curated-fallback.json") return makeResponse(fallback);
    if (url.href.includes("/catalog/current.json")) {
      return makeResponse({ blobUrl: "https://store.public.blob.vercel-storage.com/catalog/r5.json" });
    }
    if (url.hostname.endsWith(".public.blob.vercel-storage.com") && url.pathname.endsWith("/catalog/r5.json")) {
      return makeResponse(live);
    }
    if (url.pathname === "/curated-live.json") return makeResponse(fallback);
    throw new Error(`unexpected fetch ${url.href}`);
  };

  const localStorage = {
    getItem(key) { return store.has(key) ? store.get(key) : null; },
    setItem(key, value) { store.set(key, String(value)); },
    removeItem(key) { store.delete(key); },
  };

  const events = [];
  const window = {
    fetch: nativeFetch,
    localStorage,
    location: { href: "https://alphy.tv/", origin: "https://alphy.tv" },
    requestIdleCallback(callback) { setTimeout(callback, 0); },
    dispatchEvent(event) { events.push(event); },
  };
  window.window = window;

  const context = vm.createContext({
    window,
    localStorage,
    location: window.location,
    URL,
    Request,
    Response,
    CustomEvent: class CustomEvent {
      constructor(type, options = {}) { this.type = type; this.detail = options.detail; }
    },
    setTimeout,
    clearTimeout,
    Date,
    JSON,
    Number,
    String,
    Array,
    Error,
    Promise,
    console,
    requestIdleCallback: window.requestIdleCallback,
  });
  vm.runInContext(source, context, { filename: "catalog-cache.js" });

  let renders = 0;
  function mount(initial) {
    window.alphyCatalog = {
      isAdmin: () => admin,
      render() { renders += 1; },
      _test: { state: { catalog: initial, admin, dirty } },
    };
  }

  return {
    window,
    calls,
    store,
    events,
    mount,
    get renders() { return renders; },
  };
}

test("warm public open returns cached catalog immediately", async () => {
  const h = harness({ cached: catalog(5), fallback: catalog(4), live: catalog(5) });
  h.mount(catalog(5));
  const config = await (await h.window.fetch("/curated-config.json")).json();
  assert.equal(config.blobUrl, "/curated-live.json");
  const result = await (await h.window.fetch("/curated-live.json")).json();
  assert.equal(result.revision, 5);
  await flush(30);
});

test("cold open renders static fallback then hot-applies newer Blob revision", async () => {
  const h = harness({ fallback: catalog(4), live: catalog(5) });
  h.mount(catalog(4));
  const result = await (await h.window.fetch("/curated-live.json")).json();
  assert.equal(result.revision, 4);
  await flush(40);
  assert.equal(h.window.alphyCatalog._test.state.catalog.revision, 5);
  assert.ok(h.renders >= 1);
  const saved = JSON.parse(h.store.get("alphy.curated.public.v2"));
  assert.equal(saved.catalog.revision, 5);
});

test("background refresh never overwrites an admin draft", async () => {
  const h = harness({ cached: catalog(4), fallback: catalog(4), live: catalog(5), admin: true, dirty: true });
  h.mount(catalog(4));
  const result = await (await h.window.fetch("/curated-live.json")).json();
  assert.equal(result.revision, 4);
  await flush(40);
  assert.equal(h.window.alphyCatalog._test.state.catalog.revision, 4);
  assert.equal(h.renders, 0);
  const saved = JSON.parse(h.store.get("alphy.curated.public.v2"));
  assert.equal(saved.catalog.revision, 5);
});

test("older deployment fallback cannot downgrade a newer local snapshot", async () => {
  const h = harness({ cached: catalog(8), fallback: catalog(7), live: catalog(8) });
  h.mount(catalog(8));
  await flush(20);
  const saved = JSON.parse(h.store.get("alphy.curated.public.v2"));
  assert.equal(saved.catalog.revision, 8);
});
