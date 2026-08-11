#!/usr/bin/env node
// Resolves the curated catalogue to IMDb ids once, offline, and writes the
// answer into the repo.
//
// The catalogue is a finite, hand-picked list that changes when a human edits
// it — so its identity should be built at build time, not rediscovered by every
// visitor's browser against a metered API. An earlier pass did the latter and
// spent a day's PoiskKino quota to learn 77 facts that fit in 6KB.
//
// Cinemeta is the source: free, unmetered, CORS-open, and it resolves Russian
// titles ("Большой куш" -> Snatch) because it carries the same alias table
// Stremio ships. A candidate is only accepted when the release year is within a
// year of ours, which is what stops a common title binding to the wrong film.
//
//   node scripts/build-imdb-map.mjs [--check]
//
// --check re-resolves and fails if the committed map disagrees, so CI can catch
// a catalogue edit that never got its identity built.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE = path.join(root, "curated-fallback.json");
const TARGET = path.join(root, "imdb-map.json");
const CHECK = process.argv.includes("--check");

const normalizeTitle = (value) => String(value || "")
  .toLowerCase().replace(/ё/g, "е")
  .replace(/[^a-zа-я0-9]+/gi, " ").trim();

const mapKey = (title, year) => `${normalizeTitle(title)}|${String(year || "").slice(0, 4)}`;

const releaseYear = (meta) => {
  const raw = String(meta?.year ?? meta?.releaseInfo ?? "").slice(0, 4);
  const year = Number(raw);
  return Number.isFinite(year) && year > 1880 ? year : null;
};

async function cinemetaSearch(type, query) {
  const url = `https://v3-cinemeta.strem.io/catalog/${type}/top/search=${encodeURIComponent(query)}.json`;
  const response = await fetch(url, { signal: AbortSignal.timeout(12000) });
  if (!response.ok) throw new Error(`Cinemeta ${response.status}`);
  return (await response.json())?.metas ?? [];
}

// The year is the whole safety net: without it a short title like "Драйв" would
// happily bind to whatever Cinemeta ranks first.
function pick(metas, wantedYear) {
  if (!Number.isFinite(wantedYear)) return null;
  return metas.find((meta) => {
    const year = releaseYear(meta);
    return year !== null && Math.abs(year - wantedYear) <= 1 && /^tt\d{6,10}$/.test(meta?.imdb_id || "");
  }) ?? null;
}

const catalogue = JSON.parse(fs.readFileSync(SOURCE, "utf8"));
const items = (catalogue.lists ?? []).flatMap((list) => list.items ?? []);

const resolved = {};
const unresolved = [];
for (const item of items) {
  const year = Number(String(item.year ?? "").slice(0, 4));
  const type = item.isSeries ? "series" : "movie";
  let hit = null;
  try {
    hit = pick(await cinemetaSearch(type, item.title), year);
  } catch (error) {
    unresolved.push(`${item.title} (${item.year}) — Cinemeta недоступна: ${error.message}`);
    continue;
  }
  if (!hit) { unresolved.push(`${item.title} (${item.year})`); continue; }
  // The matched name is stored purely so a human can audit this file in review.
  resolved[mapKey(item.title, year)] = { imdb: hit.imdb_id, name: hit.name, year: releaseYear(hit) };
}

const built = {
  note: "Собрано scripts/build-imdb-map.mjs из curated-fallback.json. Руками не править.",
  builtFrom: `curated-fallback.json@${catalogue.revision ?? "?"}`,
  count: Object.keys(resolved).length,
  entries: Object.fromEntries(Object.entries(resolved).sort(([a], [b]) => a.localeCompare(b))),
};

if (CHECK) {
  const committed = JSON.parse(fs.readFileSync(TARGET, "utf8"));
  const same = JSON.stringify(committed.entries) === JSON.stringify(built.entries);
  if (!same) {
    console.error("imdb-map.json разошёлся с каталогом — пересобери: node scripts/build-imdb-map.mjs");
    process.exit(1);
  }
  console.log(`imdb-map.json актуален: ${built.count} записей`);
} else {
  fs.writeFileSync(TARGET, `${JSON.stringify(built, null, 2)}\n`);
  console.log(`записано ${built.count} из ${items.length} в imdb-map.json`);
}
if (unresolved.length) {
  console.log(`не сопоставлено ${unresolved.length}:`);
  for (const line of unresolved) console.log(`  ${line}`);
}
