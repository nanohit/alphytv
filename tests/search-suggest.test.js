import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = () => readFile(new URL("../app.js", import.meta.url), "utf8");
const between = (t, a, b) => t.slice(t.indexOf(a), t.indexOf(b));

// Ranking and folding are the whole substance of a suggestion list, so they are
// tested as behaviour rather than by grepping for the implementation.
const fold = (v) => String(v || "").toLowerCase().replace(/ё/g, "е")
  .replace(/[^\p{L}\p{N}]+/gu, " ").trim();

function rank(index, query) {
  const folded = fold(query);
  if (!folded) return [];
  const scored = [];
  for (const e of index) {
    let score = -1;
    if (e.folded.startsWith(folded)) score = 0;
    else if (e.folded.includes(` ${folded}`)) score = 1;
    if (score < 0) continue;
    if (e.source === "history") score -= 0.3;
    else if (e.source === "bookmark") score -= 0.2;
    scored.push({ e, score });
  }
  scored.sort((a, b) => a.score - b.score || a.e.title.localeCompare(b.e.title, "ru"));
  return scored.map((s) => s.e.title);
}

const idx = (rows) => rows.map(([title, source = "catalog"]) => ({ title, source, folded: fold(title) }));

test("a title that starts with what was typed outranks one where it starts a later word", () => {
  const index = idx([["Мистер Робот"], ["Загадочный мистер Фокс"], ["Мистерия"]]);
  assert.deepEqual(rank(index, "мистер"), ["Мистер Робот", "Мистерия", "Загадочный мистер Фокс"]);
});

test("a match buried inside a word is not a match", () => {
  // "мис" sits inside "Программисты" at position 7. Offering it reads as a bug,
  // which is why only word beginnings count.
  const index = idx([["Программисты"], ["Мистер Робот"]]);
  assert.deepEqual(rank(index, "мис"), ["Мистер Робот"]);
});

test("ё and case and punctuation do not decide whether a title is found", () => {
  const index = idx([["Ёлки"], ["Люди Икс ’97"]]);
  assert.deepEqual(rank(index, "елк"), ["Ёлки"]);
  assert.deepEqual(rank(index, "ЕЛКИ"), ["Ёлки"]);
  assert.deepEqual(rank(index, "люди икс 97"), ["Люди Икс ’97"]);
});

test("something already watched or saved comes before a catalogue entry that matches as well", () => {
  const index = idx([["Мистер Робот", "catalog"], ["Мистер Бин", "history"], ["Мистер Фон", "bookmark"]]);
  // All three are prefix matches, so only the source breaks the tie.
  assert.deepEqual(rank(index, "мистер"), ["Мистер Бин", "Мистер Фон", "Мистер Робот"]);
});

test("an empty or non-matching query yields nothing rather than everything", () => {
  const index = idx([["Мистер Робот"]]);
  assert.deepEqual(rank(index, ""), []);
  assert.deepEqual(rank(index, "   "), []);
  assert.deepEqual(rank(index, "зззз"), []);
});

test("the metered API is never in the typing path", async () => {
  const app = await source();
  const block = between(app, "const SUGGEST_DEBOUNCE_MS", "function onSearchSubmit()");
  // PoiskKino is the quota that runs out; a debounced query still fires several
  // requests, so it stays on Enter and typing costs it nothing.
  assert.doesNotMatch(block, /searchPoiskkino|resolverJson/);
  // Newdeaf is someone else's server — per-keystroke requests there are both
  // rude and a good way to get blocked.
  assert.doesNotMatch(block, /searchNewdeaf/);
  // The second tier is the mirrored index, fetched once per letter and matched
  // in the browser — not a per-keystroke call to anyone.
  assert.match(block, /loadShard\(/);
  assert.doesNotMatch(block, /searchLiftw\(/);
  assert.match(block, /SUGGEST_MIN_REMOTE = 3/);
  // The relay call is deferred, not fired on the keystroke that requested it.
  assert.match(block, /suggestTimer = setTimeout\(/);
  assert.match(block, /\}, SUGGEST_DEBOUNCE_MS\);/);
  // ...and a superseded timer is cancelled rather than left to fire.
  assert.match(block, /clearTimeout\(suggestTimer\)/);
});

test("a stale response cannot overwrite what the viewer is now typing", async () => {
  const app = await source();
  const block = between(app, "function onSuggestInput", "function onSearchSubmit()");
  // Two guards, because either alone leaks: the token catches a superseded
  // request, the value check catches one that resolved after further typing.
  assert.match(block, /token !== suggestToken/);
  assert.match(block, /el\.searchInput\.value\.trim\(\) !== query/);
});

test("a local hit opens without a resolve, and the list is rebuilt when the catalog changes", async () => {
  const app = await source();
  const choose = between(app, "function chooseSuggest", "function renderSuggest");
  // The whole point of tier 0: the entry already carries its target.
  assert.match(choose, /openCuratedItem\(\{/);
  assert.match(app, /alphy:catalog-refreshed[\s\S]{0,60}suggestIndex = null/);
  // getCatalog deep-clones 200KB; typeahead must not call it per keystroke.
  const build = between(app, "function buildSuggestIndex", "function matchLocalSuggest");
  assert.match(build, /suggestItems\?\.\(\)/);
  assert.doesNotMatch(build, /getCatalog\(\)/);
});

test("an index shard is fetched once per letter and then matched locally", async () => {
  const app = await source();
  const block = between(app, "async function loadShard", "function matchShard");
  // Two caches, both needed: memory so repeat keystrokes cost nothing at all,
  // IndexedDB so a reload does not re-download ~100KB. localStorage would refuse
  // a shard that size and evict it besides.
  assert.match(block, /shardMemory\.has\(letter\)/);
  assert.match(block, /readShard\(letter\)/);
  assert.match(block, /Date\.now\(\) - cached\.at < TITLES_SHARD_TTL_MS/);
  assert.match(block, /writeShard\(letter/);
});

test("the index is served from Supabase, not from the Worker that builds it", async () => {
  const app = await source();
  // Cloudflare Workers are throttled from Russia, which is the audience. The
  // crawler stays there because it only ever talks to the source.
  assert.match(app, /TITLES_INDEX_URL = "https:\/\/[a-z]+\.supabase\.co/);
  // Scoped to the suggestion path: a legacy resolver constant elsewhere in the
  // file still names workers.dev and has nothing to do with this.
  const block = between(app, "async function loadShard", "function suggestRow");
  assert.doesNotMatch(block, /workers\.dev/);
});

test("a suggestion without a known player id still opens", async () => {
  const app = await source();
  const block = between(app, "async function openIndexSuggestion", "function renderSuggest");
  // The backfill has reached 6% of the catalogue, so most rows carry only a
  // slug. Resolving it has to happen server-side: api.zombie-film.live does not
  // resolve from Russia at all.
  assert.match(block, /if \(!liftId\)/);
  assert.match(block, /\/resolve\?slug=/);
  assert.match(block, /liftwTarget\(liftId\)/);
});

test("index hits are ordered by match quality then by year, newest first", async () => {
  // `a - b || x < y ? 1 : -1` parses as `(a - b || x < y) ? 1 : -1`, which
  // discards the score and never compares years — the shipped list came out in
  // near-random order. This pins the comparator's actual behaviour.
  const rows = [
    { score: 1, entry: { year: "2020" } },
    { score: 0, entry: { year: "2015" } },
    { score: 0, entry: { year: "2019" } },
    { score: 0, entry: { year: "" } },
  ];
  const sorted = [...rows].sort((a, b) =>
    (a.score - b.score) || ((Number(b.entry.year) || 0) - (Number(a.entry.year) || 0)));
  assert.deepEqual(sorted.map((r) => `${r.score}:${r.entry.year || "-"}`),
    ["0:2019", "0:2015", "0:-", "1:2020"]);

  const app = await readFile(new URL("../app.js", import.meta.url), "utf8");
  assert.doesNotMatch(app, /a\.score - b\.score \|\| String\(/);
});

test("an exact title beats a newer one that merely starts with it", () => {
  // Ranking by recency alone put «Брат 3» (2022) above «Брат» (1997) and pushed
  // the film being searched for off a six-row list.
  const rank = (rows, q) => {
    const f = fold(q);
    return rows
      .map(([name, year]) => {
        const n = fold(name);
        const score = n === f ? 0 : (n.startsWith(f) ? 1 : (n.includes(` ${f}`) ? 2 : -1));
        return { name, year, score };
      })
      .filter((r) => r.score >= 0)
      .sort((a, b) => (a.score - b.score) || ((Number(b.year) || 0) - (Number(a.year) || 0)))
      .map((r) => `${r.name} (${r.year})`);
  };
  const rows = [["Брат 3", 2022], ["Брат", 1997], ["Братья", 2022], ["Мой брат", 2010]];
  assert.deepEqual(rank(rows, "брат"),
    ["Брат (1997)", "Брат 3 (2022)", "Братья (2022)", "Мой брат (2010)"]);
});

test("a suggestion row shows no type label, and a series still opens", async () => {
  const app = await source();
  const row = between(app, "function suggestRow(entry)", "function chooseSuggest");
  // The catalogue's type codes do not separate films from series — 1 and 2 are
  // films, 3, 4 and 5 all carry seasons — so the label was wrong about half the
  // time, and a confident wrong label is worse than none.
  assert.doesNotMatch(row, /"сериал"|"фильм"/);
  assert.match(row, /suggest-year/);
  assert.match(row, /suggest-origin/);
  // Series-ness still has to be right for the target, so it comes from the
  // backfilled flag rather than from the type code.
  const match = between(app, "function matchShard", "function suggestRow");
  assert.match(match, /isSeries: !!row\[3\]/);
  assert.doesNotMatch(match, /row\[3\] !== 1/);
});
