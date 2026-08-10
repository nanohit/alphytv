import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { makeSandbox, sleep } from "./helpers/app-sandbox.js";

const PREFIX = "alphy.cache.";
const wrap = (value) => JSON.stringify({ v: value, exp: Date.now() + 3600e3 });

const hit = (id, title, year, extra = {}) => ({
  id: String(id),
  title,
  originalTitle: "",
  year,
  poster: "",
  quality: "FHD",
  serialStatus: "",
  rating: { kp: null, imdb: null },
  type: 1,
  typeLabel: "фильм",
  isSeries: false,
  ...extra,
});

// The bridge reads both a search and a per-title confirmation through the same
// TTL cache the live code writes to, so seeding storage exercises the real
// ranking and confirmation logic with no network in the picture at all.
function seedBridge({ searches = {}, kpOf = {} } = {}) {
  const seed = new Map();
  for (const [query, items] of Object.entries(searches)) {
    seed.set(`${PREFIX}liftwsearch.v1:${query.toLowerCase().replace(/ё/g, "е")}`, wrap(items));
  }
  for (const [liftId, kpId] of Object.entries(kpOf)) {
    seed.set(`${PREFIX}liftwkpof.v1:${liftId}`, wrap(kpId));
  }
  return seed;
}

async function boot(storageSeed) {
  const ctx = makeSandbox({ storageSeed });
  ctx.run();
  await sleep(80);
  return { ctx, helpers: ctx.sandbox.window.alphyBridge._test };
}

test("a LiftW candidate is accepted only after its own /info confirms the Kinopoisk id", async () => {
  const { ctx, helpers } = await boot(seedBridge({
    searches: { "Дюна": [hit(11, "Дюна", 2021), hit(22, "Дюна", 2021)] },
    // Same title, same year, two different films. Only the second one *is* the
    // Kinopoisk title we asked for, and nothing but its own id can say so.
    kpOf: { 11: "555555", 22: "1234" },
  }));

  assert.equal(await helpers.findLiftwByKpId("1234", { title: "Дюна", year: 2021, isSeries: false }), "22");
  // The pairing is an identity and is cached, so a retry never re-runs the fan-out.
  assert.equal(JSON.parse(ctx.storage.get(`${PREFIX}liftwbykp.v1:1234`)).v, "22");
});

test("a title match alone is never accepted as a Kinopoisk match", async () => {
  const { ctx, helpers } = await boot(seedBridge({
    searches: { "Дюна": [hit(11, "Дюна", 2021), hit(22, "Дюна", 2021)] },
    kpOf: { 11: "555555", 22: "666666" },
  }));

  // Both candidates carry the exact title and year that was searched for. Neither
  // reports the requested Kinopoisk id, so the bridge returns nothing rather than
  // handing playback a plausible-looking wrong film.
  assert.equal(await helpers.findLiftwByKpId("1234", { title: "Дюна", year: 2021, isSeries: false }), "");
  const cached = JSON.parse(ctx.storage.get(`${PREFIX}liftwbykp.v1:1234`));
  assert.equal(cached.v, "", "the miss is cached so a retry costs nothing");
});

test("the bridge refuses to search for a placeholder watch-head label", async () => {
  const { helpers } = await boot(seedBridge({}));
  for (const label of ["LiftW 1143", "Zenith 88776", "kpId 838", "Фильм 42"]) {
    assert.equal(helpers.isPlaceholderTitle(label), true, label);
    assert.equal(await helpers.findLiftwByKpId("1234", { title: label, year: 2021 }), "");
  }
  assert.equal(helpers.isPlaceholderTitle("Дюна"), false);
  assert.equal(helpers.isPlaceholderTitle("Клан Сопрано"), false);
  // A real title that merely ends in a number is not a placeholder.
  assert.equal(helpers.isPlaceholderTitle("Терминатор 2"), false);
});

test("candidate ranking drops what could only fail confirmation", async () => {
  const { helpers } = await boot(new Map());
  const hints = { title: "Дюна", year: 2021, isSeries: false };
  assert.equal(helpers.liftwCandidateScore(hit(1, "Дюна", 1984), hints), 0, "wrong year");
  assert.equal(helpers.liftwCandidateScore(hit(2, "Дюна", 2021, { isSeries: true }), hints), 0, "wrong format");
  // A year the search payload does not carry is not evidence against a candidate.
  assert.ok(helpers.liftwCandidateScore(hit(3, "Дюна", null), hints) > 0);
  // An exact title outranks a prefix match, which outranks an unrelated one.
  const exact = helpers.liftwCandidateScore(hit(4, "Дюна", 2021), hints);
  const prefix = helpers.liftwCandidateScore(hit(5, "Дюна: Часть вторая", 2021), hints);
  const other = helpers.liftwCandidateScore(hit(6, "Довод", 2021), hints);
  assert.ok(exact > prefix && prefix > other, `${exact} > ${prefix} > ${other}`);
});

test("the confirmation hop is fail-closed inside the opaque client sandbox", async () => {
  const source = await readFile(new URL("../app.js", import.meta.url), "utf8");
  const start = source.indexOf("async function liftwKpIdFor");
  const end = source.indexOf("async function findLiftwByKpId", start);
  const block = source.slice(start, end);
  assert.ok(start >= 0 && end > start);
  assert.match(block, /preferSandbox:\s*true/);
  assert.match(block, /directFallback:\s*false/);
});

test("LiftW is tried before HDRezka when the Kinopoisk chain is exhausted", async () => {
  const source = await readFile(new URL("../app.js", import.meta.url), "utf8");
  const start = source.indexOf("log(\"kp-sources-exhausted\"");
  const block = source.slice(start, start + 700);
  const lift = block.indexOf("tryLiftwLastResort");
  const rezka = block.indexOf("tryRezkaLastResort");
  assert.ok(lift > 0 && rezka > lift, "LiftW must precede the 720p-capped last resort");
});

test("LiftW runtimes survive every shape info.time arrives in", async () => {
  const { helpers } = await boot(new Map());
  assert.equal(helpers.liftwRuntimeMinutes("121 мин. / 02:01"), 121);
  assert.equal(helpers.liftwRuntimeMinutes("30 мин"), 30);
  assert.equal(helpers.liftwRuntimeMinutes("60 мин."), 60);
  // A series reports per-episode first, total in brackets; per-episode is what a
  // card should show.
  assert.equal(helpers.liftwRuntimeMinutes("55 мин. серия (5160 мин. всего)"), 55);
  // Reading the first "N мин" turned this into a 25-minute feature.
  assert.equal(helpers.liftwRuntimeMinutes("2 ч 25 мин"), 145);
  assert.equal(helpers.liftwRuntimeMinutes("2 ч"), 120);
  assert.equal(helpers.liftwRuntimeMinutes(null), null);
  assert.equal(helpers.liftwRuntimeMinutes(""), null);
});

test("an empty Kinopoisk id can no longer mask a real one during a two-pass render", async () => {
  const { helpers } = await boot(new Map());
  // First pass: a placeholder head with no id. Second pass: the source payload.
  const placeholder = helpers.mergeMetadata({}, { title: "LiftW 1143", kpId: "" });
  const settled = helpers.mergeMetadata(placeholder, { title: "Человек-паук", kpId: "838" });
  assert.equal(settled.kpId, "838");
  // An id already in hand still wins over a later blank one.
  assert.equal(helpers.mergeMetadata({ kpId: "838" }, { kpId: "" }).kpId, "838");
  assert.equal(helpers.mergeMetadata({}, {}).kpId, "");
});

test("an unknown runtime renders as nothing rather than a dash", async () => {
  const { helpers } = await boot(new Map());
  assert.equal(helpers.formatDuration(null), "");
  assert.equal(helpers.formatDuration(0), "");
  assert.equal(helpers.formatDuration(undefined, true), "СЕРИАЛ");
  assert.equal(helpers.formatDuration(121), "2 ч 1 м");
  assert.equal(helpers.formatDuration(45), "45 мин");
});

test("a search card names its source in the caption, not in a poster pill", async () => {
  const source = await readFile(new URL("../app.js", import.meta.url), "utf8");
  const start = source.indexOf("function makeLiftwCard");
  const end = source.indexOf("function makeCollapsCard", start);
  const block = source.slice(start, end);
  assert.ok(start >= 0 && end > start);
  assert.match(block, /sub:\s*\[item\.year, item\.typeLabel, status,[\s\S]*"LFT"\]/);
  // "Все серии" says nothing the type label has not already said.
  assert.match(block, /все серии[\s\S]*\?\s*""\s*:\s*item\.serialStatus/i);
  // The corner pill is reserved for a release worth warning about.
  assert.match(block, /flag:\s*isTelesync\s*\?\s*"TS"\s*:\s*""/);
  // The ratings already show on hover; the card no longer repeats them below.
  assert.doesNotMatch(block, /liftw-ratings|formatRating/);
  assert.doesNotMatch(source, /ratingPill/);
});
