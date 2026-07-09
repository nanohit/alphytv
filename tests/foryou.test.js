import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

// foryou.js is a browser IIFE; evaluate it in a sandbox with stubbed
// window/localStorage/fetch and drive the pure pipeline via _test exports.
async function loadForYou(storage = new Map()) {
  const code = await readFile(new URL("../foryou.js", import.meta.url), "utf8");
  const localStorage = {
    getItem: (key) => (storage.has(key) ? storage.get(key) : null),
    setItem: (key, value) => storage.set(key, String(value)),
    removeItem: (key) => storage.delete(key),
    key: (index) => [...storage.keys()][index] ?? null,
    get length() { return storage.size; },
  };
  const sandbox = {
    console,
    Date,
    JSON,
    Math,
    Promise,
    setTimeout,
    localStorage,
    fetch: async () => { throw new Error("network disabled in tests"); },
    CustomEvent: class CustomEvent {
      constructor(type, options) {
        this.type = type;
        this.detail = options?.detail;
      }
    },
    window: { addEventListener: () => {}, dispatchEvent: () => {} },
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox);
  return { api: sandbox.window.alphyForYou, storage };
}

function historyEntry(overrides = {}) {
  return {
    key: `kp:${overrides.kpId || "1"}`,
    kind: "kp",
    target: { kind: "kp", kpId: overrides.kpId || "1" },
    title: "Фильм",
    progress: 1,
    updatedAt: Date.now(),
    ...overrides,
  };
}

test("buildSeeds: weights favour finished + recent, zen entries go to unresolved", async () => {
  const storage = new Map();
  const now = Date.now();
  storage.set("alphy.history", JSON.stringify([
    historyEntry({ kpId: "100", title: "Свежий досмотренный", progress: 0.95, updatedAt: now }),
    historyEntry({ kpId: "200", title: "Старый брошенный", progress: 0.05, updatedAt: now - 120 * 86400e3 }),
    {
      key: "zen:555", kind: "zen", target: { kind: "zen", zenithId: "555" },
      title: "Зенитный без кп", progress: 0.9, updatedAt: now,
    },
  ]));
  storage.set("alphy.bookmarks", JSON.stringify([
    {
      key: "kp:300", kind: "kp", target: { kind: "kp", kpId: "300" },
      title: "Из закладок", addedAt: now,
    },
  ]));

  const { api } = await loadForYou(storage);
  const { seeds, unresolved, excludeKp, excludeTitles } = api._test.buildSeeds();

  const byId = Object.fromEntries(seeds.map((seed) => [seed.kpId, seed]));
  assert.ok(byId["100"], "finished recent film is a seed");
  assert.ok(byId["100"].weight > byId["200"].weight * 3, "recency+engagement dominate");
  assert.ok(byId["300"], "bookmark-only entry becomes a seed");
  assert.ok(byId["300"].weight < byId["100"].weight, "bookmark weighs less than a finished watch");
  assert.equal(unresolved.length, 1, "zen entry waits for kpId backfill");
  assert.ok(excludeKp.has("100") && excludeKp.has("300"));
  assert.ok(excludeTitles.has(api._test.normTitle("Зенитный без кп")), "watched titles excluded even without kpId");
});

test("scoreCandidates: intersection beats a single top position", async () => {
  const { api } = await loadForYou();
  const seedA = { kpId: "1", weight: 1 };
  const seedB = { kpId: "2", weight: 1 };
  const picked = api._test.scoreCandidates([
    { seed: seedA, similars: [{ id: "10", ru: "Уникум" }, { id: "20", ru: "Пересечение" }] },
    { seed: seedB, similars: [{ id: "20", ru: "Пересечение" }] },
  ], new Set(), new Set());

  assert.equal(picked[0].id, "20", "candidate named by two seeds ranks first");
  assert.equal(picked[0].hits, 2);
  assert.ok(picked[0].final > picked[1].final);
});

test("scoreCandidates: excludes watched kpIds and watched titles", async () => {
  const { api } = await loadForYou();
  const seed = { kpId: "1", weight: 1 };
  const picked = api._test.scoreCandidates(
    [{ seed, similars: [
      { id: "10", ru: "Уже смотрел" },
      { id: "20", ru: "Новое" },
      { id: "30", ru: "Смотрел под другим айди" },
    ] }],
    new Set(["10"]),
    new Set([api._test.normTitle("Смотрел под другим айди")]),
  );
  assert.deepEqual(JSON.parse(JSON.stringify(picked.map((p) => p.id))), ["20"]);
});

test("scoreCandidates: one seed cannot own more than 5 slots", async () => {
  const { api } = await loadForYou();
  const hot = { kpId: "1", weight: 10 };
  const other = { kpId: "2", weight: 0.2 };
  const hotSimilars = Array.from({ length: 12 }, (_, i) => ({ id: `h${i}`, ru: `Хит ${i}` }));
  const picked = api._test.scoreCandidates([
    { seed: hot, similars: hotSimilars },
    { seed: other, similars: [{ id: "o1", ru: "Тихий" }] },
  ], new Set(), new Set());
  const fromHot = picked.filter((p) => p.primarySeed === "1").length;
  assert.ok(fromHot <= 5, `diversity cap holds (got ${fromHot})`);
  assert.ok(picked.some((p) => p.id === "o1"), "weak seed still contributes");
});

test("toCuratedItem: produces a playable curated-shaped card", async () => {
  const { api } = await loadForYou();
  const item = api._test.toCuratedItem(
    { id: "301", ru: "Матрица", orig: "The Matrix", poster: "https://kinopoiskapiunofficial.tech/images/posters/kp/301.jpg" },
    { year: "1999", isSeries: false, rating: { kp: 8.5, imdb: 8.7 }, movieLength: 136 },
  );
  assert.equal(item.key, "kp:301");
  assert.deepEqual(JSON.parse(JSON.stringify(item.target)), { kind: "kp", kpId: "301" });
  assert.equal(item.title, "Матрица");
  assert.equal(item.year, "1999");
  assert.equal(item.movieLength, 136);
});

test("hide removes a title from the row, persists, and stays hidden after reload", async () => {
  const storage = new Map();
  storage.set("alphy.foryou.last.v1", JSON.stringify({
    items: Array.from({ length: 8 }, (_, i) => ({ id: `fy-${i}`, key: `kp:${i}`, title: `t${i}`, target: { kind: "kp", kpId: String(i) } })),
    at: Date.now(),
  }));
  const { api } = await loadForYou(storage);
  assert.equal(api.getItems().length, 8);
  api.hide("3");
  assert.equal(api.getItems().length, 7);
  assert.ok(!api.getItems().some((item) => item.target.kpId === "3"), "hidden item gone from the row");
  assert.ok(api._test.hiddenIds().has("3"), "dismissal persisted");
  // A fresh session with the same storage keeps it hidden (cached row included).
  const second = await loadForYou(storage);
  assert.ok(!second.api.getItems().some((item) => item.target.kpId === "3"));
  // Hiding is not a taste signal: seeds/history are untouched.
  assert.equal(storage.has("alphy.history"), false);
});

test("hidden ids are excluded from future scoring but do not touch seeds", async () => {
  const storage = new Map();
  storage.set("alphy.foryou.hidden.v1", JSON.stringify([{ id: "20", at: Date.now() }]));
  const { api } = await loadForYou(storage);
  const seed = { kpId: "1", weight: 1 };
  // compute() merges hiddenIds into excludeKp; emulate that contract here.
  const exclude = new Set(api._test.hiddenIds());
  const picked = api._test.scoreCandidates(
    [{ seed, similars: [{ id: "10", ru: "Оставить" }, { id: "20", ru: "Скрытое" }] }],
    exclude,
    new Set(),
  );
  assert.deepEqual(JSON.parse(JSON.stringify(picked.map((p) => p.id))), ["10"]);
});

test("cached row paints instantly; mode off empties it", async () => {
  const storage = new Map();
  storage.set("alphy.foryou.last.v1", JSON.stringify({
    items: Array.from({ length: 7 }, (_, i) => ({ id: `fy-${i}`, key: `kp:${i}`, title: `t${i}`, target: { kind: "kp", kpId: String(i) } })),
    at: Date.now(),
  }));
  const { api } = await loadForYou(storage);
  assert.equal(api.getItems().length, 7, "last row paints instantly before mode arrives");
  api.setMode("off");
  assert.equal(api.getItems().length, 0, "off hides the row everywhere");
});
