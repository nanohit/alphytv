import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { makeSandbox, sleep } from "./helpers/app-sandbox.js";
import {
  buildData, buildIndex, mergeDelta, needsRebase, net, codepoint, partitionRows,
} from "../scripts/publish-search-cdn.mjs";

// The search index moved from Supabase Storage to jsDelivr: a tiny pointer on
// Supabase, an index and per-letter base + delta files pinned to a commit.
// These pin that a browser gets the same rows either way, that it falls back to
// Supabase when the new path cannot answer, and that the publisher ships small
// deltas and only rebuilds a letter when its delta has grown.

const plain = (value) => JSON.parse(JSON.stringify(value));
const ok = (body) => ({ ok: true, status: 200, headers: { get: () => "" }, json: async () => body });
const missing = () => ({ ok: false, status: 404, headers: { get: () => "" }, json: async () => ({}) });
const C1 = "a".repeat(40);
const C2 = "b".repeat(40);

// [name, year, slug, isSeries, embedId, kp, originName]
const row = (name, year, slug, kp = "") => [name, year, slug, 0, 1, kp, ""];

async function boot(files) {
  const ctx = makeSandbox();
  ctx.run();
  await sleep(80);
  const asked = [];
  ctx.sandbox.fetch = async (url) => {
    const href = String(url);
    asked.push(href);
    const answer = typeof files === "function" ? files(href) : files[href];
    return answer === undefined ? missing() : ok(answer);
  };
  return { app: ctx.sandbox.window.alphyBridge._test, asked };
}

const POINTER = "https://xoathqkggcuyoyutxwri.supabase.co/storage/v1/object/public/index/pointer.json";
const cdn = (commit, file) => `https://cdn.jsdelivr.net/gh/nanohit/alphytv@${commit}/${file}`;
const P = "43f"; // п

test("prefix partitions preserve matching at any word in either language", async () => {
  const rows = [
    ["Пираты Карибского моря", 2003, "pirates", 0, 1, "4374", "Pirates of the Caribbean"],
    ["Пи", 1998, "pi", 0, 2, "1", "Pi"],
    ["Пираты. Пиратский фильм", 2026, "p", 0, 3, "2", ""],
  ];
  const parts = partitionRows(rows, "п");
  assert.equal(parts.get("пир").length, 2, "multiple matching words never duplicate the title");
  assert.equal(partitionRows(rows, "к").get("кар")[0][2], "pirates");
  assert.equal(partitionRows(rows, "c").get("car")[0][2], "pirates");
});

test("a cold long prefix downloads its small partition, never the giant letter", async () => {
  const entry = [`b/${P}.1111111111111111.json`, C1, 20000, null, null, "i/3333333333333333.json"];
  const { app, asked } = await boot({
    [POINTER]: { v: 1, c: C2, f: "i/0123456789abcdef.json" },
    [cdn(C2, "i/0123456789abcdef.json")]: { v: 1, l: { [P]: entry } },
    [cdn(C2, "i/3333333333333333.json")]: { пир: ["p/4444444444444444.json", C1, 1] },
    [cdn(C1, "p/4444444444444444.json")]: [row("Пираты", 2003, "piraty")],
  });
  assert.equal((await app.loadSearchRows("пираты"))[0][2], "piraty");
  assert.ok(asked.every((url) => !url.includes("/b/") && !url.includes("/index/v3/")));
});

test("a delta replaces titles by slug, drops the ones that left, and adds the new", async () => {
  const { app } = await boot({});
  const base = [row("Пираты", 2003, "piraty"), row("Паразиты", 2019, "parazity"), row("Побег", 1994, "pobeg")];
  const merged = app.applySearchDelta(base, {
    u: [row("Пираты", 2003, "piraty", "4374"), row("Пекло", 2026, "peklo")],
    r: ["pobeg"],
  });
  assert.deepEqual(plain(merged).map((r) => r[2]).sort(), ["parazity", "peklo", "piraty"]);
  assert.equal(plain(merged).find((r) => r[2] === "piraty")[5], "4374");
  assert.equal(app.applySearchDelta(base, null), base, "no delta, the base itself");
});

test("a letter is read from jsDelivr: pointer, index, base and delta, and never from the Supabase shard", async () => {
  const index = { v: 1, l: { [P]: [`b/${P}.1111111111111111.json`, C1, 2, `d/${P}.2222222222222222.json`, C1] } };
  const files = {
    [POINTER]: { v: 1, c: C2, f: "i/0123456789abcdef.json" },
    [cdn(C2, "i/0123456789abcdef.json")]: index,
    [cdn(C1, `b/${P}.1111111111111111.json`)]: [row("Пираты", 2003, "piraty"), row("Побег", 1994, "pobeg")],
    [cdn(C1, `d/${P}.2222222222222222.json`)]: { u: [row("Пекло", 2026, "peklo")], r: ["pobeg"] },
  };
  const { app, asked } = await boot(files);
  const rows = plain(await app.loadShard("п"));
  assert.deepEqual(rows.map((r) => r[2]).sort(), ["peklo", "piraty"]);
  assert.ok(!asked.some((url) => url.includes("/object/public/index/v3/")), "the old shard must not be fetched");
  // Matching on the merged letter works exactly as before.
  assert.equal(plain(app.matchShard(rows, "пекло"))[0].slug, "peklo");
});

test("when the pointer cannot be read, the Supabase shard serves as before", async () => {
  const supabaseShard = `https://xoathqkggcuyoyutxwri.supabase.co/storage/v1/object/public/index/v3/${P}.json`;
  const { app, asked } = await boot({ [supabaseShard]: [row("Пираты", 2003, "piraty")] });
  const rows = plain(await app.loadShard("п"));
  assert.equal(rows[0][2], "piraty");
  assert.ok(asked.includes(POINTER));
  assert.ok(asked.includes(supabaseShard));
});

test("a letter in memory answers at once, and a moved pointer swaps in the newer rows", async () => {
  let pointer = { v: 1, c: C2, f: "i/0000000000000001.json" };
  const files = (url) => ({
    [POINTER]: pointer,
    [cdn(C2, "i/0000000000000001.json")]: { v: 1, l: { [P]: [`b/${P}.aaaaaaaaaaaaaaaa.json`, C1, 1, null, null] } },
    [cdn(C2, "i/0000000000000002.json")]: { v: 1, l: { [P]: [`b/${P}.aaaaaaaaaaaaaaaa.json`, C1, 1, `d/${P}.bbbbbbbbbbbbbbbb.json`, C2] } },
    [cdn(C1, `b/${P}.aaaaaaaaaaaaaaaa.json`)]: [row("Пираты", 2003, "piraty")],
    [cdn(C2, `d/${P}.bbbbbbbbbbbbbbbb.json`)]: { u: [row("Пекло", 2026, "peklo")], r: [] },
  })[url];
  const { app, asked } = await boot(files);
  assert.equal(plain(await app.loadShard("п")).length, 1);

  pointer = { v: 1, c: C2, f: "i/0000000000000002.json" };
  await app.currentSearchPointer({ force: true });
  const before = asked.length;
  assert.equal(plain(await app.loadShard("п")).length, 1, "the keystroke is answered from memory");
  await sleep(30);
  assert.equal(plain(await app.loadShard("п")).length, 2, "and the next one sees the new title");
  assert.ok(!asked.slice(before).some((url) => url.includes(`b/${P}.aaaaaaaaaaaaaaaa.json`)),
    "an unchanged base is never downloaded again");
});

test("equal score and year are ordered by title, whatever order the letter holds them in", async () => {
  const { app } = await boot({});
  const rows = [row("Пекло", 2020, "b"), row("Пекло", 2020, "a"), row("Пекло 2", 2020, "c"), row("Пекло", 2020, "d")];
  const reversed = [...rows].reverse();
  const first = plain(app.matchShard(rows, "пекло")).map((entry) => entry.title);
  const second = plain(app.matchShard(reversed, "пекло")).map((entry) => entry.title);
  assert.deepEqual(first, second);
});

// --- the publisher -----------------------------------------------------------

test("changes fold into a letter's delta: newest row wins, removal and return both count", () => {
  const since = "2026-09-11T10:00:00.000Z";
  const changes = [
    ["Пекло", 2026, "peklo", 0, 1, "", "", ["п"], "2026-09-11T10:05:00.000Z", 1],
    ["Пекло", 2026, "peklo", 0, 1, "999", "Hell", ["п", "h"], "2026-09-11T10:06:00.000Z", 1],
    ["Старое", 1990, "old", 0, 1, "", "", ["с"], "2026-09-11T10:07:00.000Z", 2],
    ["Раньше", 1990, "early", 0, 1, "", "", ["п"], "2026-09-11T09:00:00.000Z", 3],
  ];
  const removed = [
    { letter: "п", slug: "gone", removed_at: "2026-09-11T10:08:00.000Z" },
    { letter: "п", slug: "back", removed_at: "2026-09-11T10:01:00.000Z" },
  ];
  const later = [["Назад", 2001, "back", 0, 1, "", "", ["п"], "2026-09-11T10:09:00.000Z", 4]];
  const delta = mergeDelta({ u: [row("Прежнее", 2000, "kept")], r: [] }, "п", since, [...changes, ...later], removed);
  assert.deepEqual(delta.u.map((r) => r[2]), ["back", "kept", "peklo"]);
  assert.equal(delta.u.find((r) => r[2] === "peklo")[5], "999", "the newest version of a title");
  assert.equal(delta.u.find((r) => r[2] === "peklo").length, 7, "only the fields a shard row carries");
  assert.deepEqual(delta.r, ["gone"]);
});

test("a letter is rebuilt only once its delta outgrows a tenth of it", () => {
  const small = { u: Array(150).fill(row("x", 1, "x")), r: [] };
  assert.equal(needsRebase({ n: 19000 }, small), false);
  assert.equal(needsRebase({ n: 1000 }, { u: Array(201).fill(0), r: [] }), true);
  assert.equal(needsRebase({ n: 19000 }, { u: Array(1901).fill(0), r: [] }), true);
});

function fakeTitles({ letters, bases, changes = [], removed = [] }) {
  const calls = [];
  let clock = Date.parse("2026-09-11T12:00:00Z");
  net.token = "t";
  net.now = () => { clock += 1000; return clock; };
  net.get = async (url) => {
    calls.push(url);
    const u = new URL(url);
    if (u.pathname.endsWith("/letters")) return { letters };
    if (u.pathname.endsWith("/changes")) {
      const after = u.searchParams.get("after_at");
      return { rows: changes.filter((c) => c[8] > after), next: null };
    }
    if (u.pathname.endsWith("/removed")) return { removed };
    return bases[u.searchParams.get("i")];
  };
  return { calls };
}

test("the publisher's first run bases every letter; later runs ship deltas and move the cursor", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "search-cdn-"));
  try {
    const bases = { п: [row("Пираты", 2003, "piraty")], к: [row("Коко", 2017, "koko")] };
    const first = fakeTitles({ letters: ["п", "к", "i̇"], bases });
    const summary = await buildData(dir, { log: () => {} });
    assert.equal(summary.rebased, 2, "a letter that is not one character is skipped");
    const state = JSON.parse(await readFile(path.join(dir, "state.json"), "utf8"));
    assert.equal(state.letters[codepoint("п")].bc, "pending");
    assert.ok(state.cursor?.after_at, "the cursor starts at the earliest base");
    assert.ok(!first.calls.some((url) => url.includes("/changes")), "nothing to read before a base exists");

    const indexFile = await buildIndex(dir, C1);
    const index = JSON.parse(await readFile(path.join(dir, indexFile), "utf8"));
    assert.equal(index.l[codepoint("п")][1], C1, "pending files are pinned to the data commit");

    // An hour later one title in п changed.
    const at = new Date(Date.parse(state.cursor.after_at) + 3600e3).toISOString();
    fakeTitles({
      letters: ["п", "к"],
      bases,
      changes: [["Пираты", 2003, "piraty", 0, 1, "4374", "Pirates", ["п"], at, 10]],
    });
    const second = await buildData(dir, { log: () => {} });
    assert.equal(second.rebased, 0);
    assert.equal(second.deltas, 1);
    const next = JSON.parse(await readFile(path.join(dir, "state.json"), "utf8"));
    assert.equal(next.letters[codepoint("к")].d, null, "an untouched letter carries no delta");
    const delta = JSON.parse(await readFile(path.join(dir, next.letters[codepoint("п")].d), "utf8"));
    assert.equal(delta.u[0][5], "4374");
    assert.equal(next.letters[codepoint("п")].dc, "pending");
    assert.equal(next.letters[codepoint("п")].bc, C1, "the base keeps its commit, so browsers keep their copy");
    assert.deepEqual(next.cursor, { after_at: at, after_id: 10 });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a delta that outgrows its letter triggers a rebuild, and the old files leave the tree", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "search-cdn-"));
  try {
    fakeTitles({ letters: ["к"], bases: { к: [row("Коко", 2017, "koko")] } });
    await buildData(dir, { log: () => {} });
    await buildIndex(dir, C1);
    const state = JSON.parse(await readFile(path.join(dir, "state.json"), "utf8"));
    const oldBase = state.letters[codepoint("к")].b;

    const at = new Date(Date.parse(state.cursor.after_at) + 60e3).toISOString();
    const many = Array.from({ length: 250 }, (_, i) => [`К ${i}`, 2020, `k-${i}`, 0, 1, "", "", ["к"], at, 100 + i]);
    const fresh = Array.from({ length: 251 }, (_, i) => row(`К ${i}`, 2020, `k-${i}`));
    fakeTitles({ letters: ["к"], bases: { к: fresh }, changes: many });
    const summary = await buildData(dir, { log: () => {} });
    assert.equal(summary.rebased, 1);
    const next = JSON.parse(await readFile(path.join(dir, "state.json"), "utf8"));
    assert.notEqual(next.letters[codepoint("к")].b, oldBase);
    assert.equal(next.letters[codepoint("к")].n, 251);
    const bases = await readdir(path.join(dir, "b"));
    assert.deepEqual(bases, [path.basename(next.letters[codepoint("к")].b)], "the replaced base is removed from the tree");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the search publisher workflow commits data before the index that names it", async () => {
  const workflow = await readFile(new URL("../.github/workflows/search-cdn.yml", import.meta.url), "utf8");
  const data = workflow.indexOf("publish-search-cdn.mjs data");
  const index = workflow.indexOf("publish-search-cdn.mjs index");
  const pointer = workflow.indexOf("publish-search-cdn.mjs pointer");
  assert.ok(data > 0 && index > data && pointer > index);
  assert.match(workflow, /SEARCH_PUBLISH_TOKEN/);
  assert.doesNotMatch(workflow, /force/i, "history is appended, never rewritten: old commits stay readable");
});
