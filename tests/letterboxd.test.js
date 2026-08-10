import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { makeSandbox, sleep } from "./helpers/app-sandbox.js";

// The rating lives behind three identical Supabase Edge deployments (three free
// accounts, 500k invocations each). These tests pin the two properties that
// matter: a film is always asked of the same project, and one project being
// down costs the next caller nothing.

// The app runs in a vm, so its objects carry that realm's prototypes and
// deepStrictEqual would compare identities rather than values.
const plain = (value) => JSON.parse(JSON.stringify(value));

async function boot({ handler, storageSeed = new Map() } = {}) {
  const ctx = makeSandbox({ storageSeed });
  ctx.run();
  await sleep(80);
  const calls = [];
  if (handler) {
    ctx.sandbox.fetch = async (url, opts) => {
      calls.push(String(url));
      return handler(String(url), opts, calls.length);
    };
  }
  return { helpers: ctx.sandbox.window.alphyBridge._test, calls, storage: ctx.storage, ctx };
}

const ok = (body) => ({ ok: true, status: 200, headers: { get: () => "" }, json: async () => body });

test("a film always goes to the same project, and the ring is the failover order", async () => {
  const { helpers } = await boot();
  const endpoints = helpers.LETTERBOXD_ENDPOINTS;
  assert.equal(endpoints.length, 3);
  assert.ok(endpoints.every((url) => /^https:\/\/[a-z]+\.supabase\.co\/functions\/v1\/letterboxd$/.test(url)));

  // Deterministic: the same id always starts at the same project.
  const first = helpers.letterboxdEndpointOrder("tt0111161");
  assert.deepEqual(plain(first), plain(helpers.letterboxdEndpointOrder("tt0111161")));
  // Every order is a full permutation, so a failure can always fall through.
  for (const id of ["tt0111161", "tt0137523", "tt6751668", "tt1877830"]) {
    const order = helpers.letterboxdEndpointOrder(id);
    assert.deepEqual(plain(order).sort(), plain(endpoints).sort(), `${id} lost an endpoint`);
  }
  // And the load actually spreads rather than pinning everything to one.
  const starts = new Set();
  for (let i = 1000; i < 1200; i += 1) starts.add(helpers.letterboxdEndpointOrder(`tt${i}0000`)[0]);
  assert.equal(starts.size, 3, "ids should reach all three projects");
});

test("a rating is fetched once and then served from storage", async () => {
  const { helpers, calls, storage } = await boot({
    handler: () => ok({ imdb: "tt0111161", found: true, slug: "the-shawshank-redemption", r: 4.6, n: 3008699 }),
  });
  // The slug rides along so the watch-page badge can link out to the film.
  const expected = { r: 4.6, n: 3008699, slug: "the-shawshank-redemption" };
  assert.deepEqual(plain(await helpers.letterboxdRating("tt0111161")), expected);
  assert.deepEqual(plain(await helpers.letterboxdRating("tt0111161")), expected);
  assert.equal(calls.length, 1, "the second ask must not touch the network");
  assert.ok([...storage.keys()].some((k) => k.endsWith("letterboxd.v1:tt0111161")));
});

test("a title Letterboxd does not carry is remembered as a miss", async () => {
  // Letterboxd is a film site: a series has no page at all. Re-asking on every
  // open would spend a request per view for a verdict that cannot change.
  const { helpers, calls, storage } = await boot({ handler: () => ok({ imdb: "tt0903747", found: false }) });
  assert.equal(await helpers.letterboxdRating("tt0903747"), null);
  assert.equal(await helpers.letterboxdRating("tt0903747"), null);
  assert.equal(calls.length, 1);
  assert.equal(JSON.parse(storage.get("alphy.cache.letterboxd.v1:tt0903747")).v.r, 0);
});

test("a dead project is skipped, and stops being tried for a while", async () => {
  const { helpers, calls } = await boot({
    handler: (url) => {
      if (url.includes("lcldjrphnkufymdhevyx")) throw new Error("project paused");
      return ok({ found: true, r: 4.27, n: 5862630 });
    },
  });
  // tt0137523 starts on the dead project, so this exercises the fall-through.
  const order = helpers.letterboxdEndpointOrder("tt0137523");
  assert.match(order[0], /lcldjrphnkufymdhevyx/);
  assert.deepEqual(plain(await helpers.letterboxdRating("tt0137523")), { r: 4.27, n: 5862630, slug: "" });
  assert.equal(calls.length, 2, "one failure, then the next project answers");

  // The dead one is now on cooldown: another id that would have started there
  // skips it outright instead of paying the same timeout again.
  const before = calls.length;
  await helpers.letterboxdRating("tt7654321");
  assert.equal(calls.length - before, 1, "the cooling project must not be retried");
});

test("nothing but an IMDb id ever reaches the network", async () => {
  const { helpers, calls } = await boot({ handler: () => ok({ found: true, r: 4 }) });
  for (const bad of ["", null, "tt", "123456", "../../etc", "tt1;rm -rf", "javascript:alert(1)"]) {
    assert.equal(await helpers.letterboxdRating(bad), null, `${JSON.stringify(bad)} was accepted`);
  }
  assert.deepEqual(calls, []);
});

test("an out-of-range score is treated as no score at all", async () => {
  // The 0-5 scale is the one thing the badge relies on; a 0-10 value would be
  // rendered as if it were stars.
  for (const r of [0, -1, 9.1, "abc", null]) {
    const { helpers } = await boot({ handler: () => ok({ found: true, r }) });
    assert.equal(await helpers.letterboxdRating("tt0111161"), null, `r=${r} leaked through`);
  }
});

test("the badge is appended, never rendered inline, and is skipped for series", async () => {
  const source = await readFile(new URL("../app.js", import.meta.url), "utf8");
  const start = source.indexOf("function fillLetterboxdBadge");
  const block = source.slice(start, start + 1100);
  assert.ok(start > 0);
  // It must not be able to hold up the sidebar.
  assert.match(block, /letterboxdImdbId\(meta\)[\s\S]*\.then\(/);
  assert.match(block, /meta\?\.isSeries/);
  // A late answer must not land on a page the user has already navigated away from.
  assert.match(block, /isStale\(token\)/);
  assert.match(block, /keyFor\(state\.currentTarget\) !== keyFor\(target\)/);
});

test("a grid asks once per shard and never triggers scraping", async () => {
  const asked = [];
  const { helpers, storage } = await boot({
    handler: (url) => {
      asked.push(url);
      const ids = new URL(url).searchParams.get("imdb").split(",");
      // The table answers only what it holds; an unknown film is simply absent.
      const items = {};
      for (const id of ids) if (id !== "tt9999999") items[id] = { r: 4.1, n: 100, slug: `s-${id}` };
      return ok({ items });
    },
  });
  const ids = ["tt0111161", "tt0137523", "tt6751668", "tt1877830", "tt9999999"];
  await helpers.letterboxdBatch(ids);

  // One request per shard, not one per film.
  assert.ok(asked.length <= 3 && asked.length >= 1, `${asked.length} requests for ${ids.length} films`);
  assert.ok(asked.every((url) => url.includes(",") || new URL(url).searchParams.get("imdb").split(",").length >= 1));
  // Every id went to the shard its hash picks, so batch and single agree.
  for (const url of asked) {
    const endpoint = url.split("?")[0];
    for (const id of new URL(url).searchParams.get("imdb").split(",")) {
      assert.equal(helpers.letterboxdEndpointOrder(id)[0], endpoint, `${id} went to the wrong shard`);
    }
  }
  assert.equal(JSON.parse(storage.get("alphy.cache.letterboxd.v1:tt0111161")).v.r, 4.1);
  // A film the table has never seen must stay unknown rather than be cached as
  // "no rating" — opening it later is what fills it in.
  assert.equal(storage.get("alphy.cache.letterboxd.v1:tt9999999"), undefined);
});

test("a batch never re-asks for something already cached", async () => {
  const asked = [];
  const { helpers } = await boot({
    handler: (url) => { asked.push(url); return ok({ items: { tt0111161: { r: 4.6, n: 1, slug: "x" } } }); },
  });
  await helpers.letterboxdBatch(["tt0111161"]);
  await helpers.letterboxdBatch(["tt0111161"]);
  assert.equal(asked.length, 1);
});

test("a film the server could not answer for is still asked only once", async () => {
  // A search grid renders twice, and an unanswerable film leaves nothing in the
  // cache to suppress the second pass — which is how one grid became four calls.
  const asked = [];
  const { helpers } = await boot({
    handler: (url) => { asked.push(url); return ok({ items: {} }); },
  });
  await helpers.letterboxdBatch(["tt0111161", "tt0137523"]);
  await helpers.letterboxdBatch(["tt0111161", "tt0137523"]);
  assert.equal(asked.length, 2, "two shards, one pass — not two passes");
});

test("a second render pass waits for the first request instead of painting early", async () => {
  // The grid renders twice and the second pass builds new card elements. If it
  // skipped the in-flight request it would read an empty cache and paint nothing.
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const asked = [];
  const { helpers, storage } = await boot({
    handler: async (url) => {
      asked.push(url);
      await gate;
      return ok({ items: { tt0111161: { r: 4.6, n: 7, slug: "x" } } });
    },
  });
  const first = helpers.letterboxdBatch(["tt0111161"]);
  const second = helpers.letterboxdBatch(["tt0111161"]);
  release();
  await Promise.all([first, second]);
  assert.equal(asked.length, 1, "the second pass must not fire its own request");
  assert.equal(JSON.parse(storage.get("alphy.cache.letterboxd.v1:tt0111161")).v.r, 4.6,
    "and it must not return before the cache is filled");
});
