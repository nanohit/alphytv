// Full rebuild of the search-index shards into Supabase Storage.
//
// Day to day nothing runs this: the crawler's ingest marks the letters a batch
// touched and the `titles` function rebuilds only those. This is the operator
// path — a shape change, a new mirror project, or a bucket that was emptied —
// and it is deliberately a plain script rather than a function, because a full
// build is ~100 letters of ten PostgREST pages each and has no business inside a
// request budget.
//
//   SUPABASE_SERVICE_ROLE_KEY=… node scripts/build-title-shards.mjs [--project=ref] [--letters=абв]
//
// The key is read from the environment and never written anywhere.

const args = new Map(process.argv.slice(2)
  .filter((a) => a.startsWith("--"))
  .map((a) => a.replace(/^--/, "").split("=")));

const REF = args.get("project") || "xoathqkggcuyoyutxwri";
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const BUCKET = "index";
// Must match TITLES_SHARD_VERSION in app.js and SHARD_VERSION in the function.
const SHARD_VERSION = 2;
const BASE = `https://${REF}.supabase.co`;
const HEADERS = { apikey: KEY, Authorization: `Bearer ${KEY}` };

if (!KEY) {
  console.error("SUPABASE_SERVICE_ROLE_KEY is required");
  process.exit(1);
}

// A letter names its object by codepoint, so the path is plain ASCII whatever
// the alphabet. The index holds 86 distinct initials — Cyrillic, Latin, CJK.
const shardPath = (letter) => `v${SHARD_VERSION}/${letter.codePointAt(0).toString(16)}.json`;
const fold = (letter) => letter.toLowerCase().replace(/ё/, "е");

async function rows(letter) {
  const filter =
    `or=(initial.eq.${encodeURIComponent(letter)},origin_initial.eq.${encodeURIComponent(letter)})`;
  const out = [];
  for (let from = 0; from < 20000; from += 1000) {
    const response = await fetch(
      `${BASE}/rest/v1/titles?select=name,origin_name,year,slug,is_series,embed_id,kp&${filter}` +
      `&order=year.desc.nullslast,name.asc`,
      { headers: { ...HEADERS, Range: `${from}-${from + 999}` } },
    );
    if (!response.ok) throw new Error(`rest ${response.status}`);
    const page = await response.json();
    // Positional, and the order is the client's contract:
    // [name, year, slug, isSeries, embedId, kp, originName]
    out.push(...page.map((r) => [
      r.name, r.year, r.slug, r.is_series ? 1 : 0, r.embed_id, r.kp ?? "", r.origin_name ?? "",
    ]));
    if (page.length < 1000) break;
  }
  return out;
}

async function upload(letter, body) {
  const response = await fetch(`${BASE}/storage/v1/object/${BUCKET}/${shardPath(letter)}`, {
    method: "POST",
    headers: {
      ...HEADERS,
      "Content-Type": "application/json",
      // A day at the CDN. The browser keeps its own copy for a week, and a shape
      // change moves to a new prefix, so staleness cannot outlive either.
      "Cache-Control": "public, max-age=86400",
      "x-upsert": "true",
    },
    body,
  });
  if (!response.ok) throw new Error(`storage ${response.status} ${await response.text()}`);
}

const letters = args.has("letters")
  ? [...args.get("letters")].map(fold)
  : await (async () => {
    // The `shard_letters` view, not `titles`: PostgREST caps a plain select at
    // 1000 rows, so asking the table for its initials answers with the letters
    // of the first thousand titles — 23 of 86 — and the rest are never built.
    const response = await fetch(`${BASE}/rest/v1/shard_letters?select=letter`, { headers: HEADERS });
    if (!response.ok) throw new Error(`rest ${response.status}`);
    return (await response.json()).map((r) => r.letter).sort();
  })();

console.log(`${letters.length} letters -> ${BASE}/storage/v1/object/public/${BUCKET}/v${SHARD_VERSION}/`);
let bytes = 0;
let biggest = { letter: "", kb: 0 };
for (const letter of letters) {
  const body = JSON.stringify(await rows(letter));
  await upload(letter, body);
  bytes += body.length;
  const kb = Math.round(body.length / 1024);
  if (kb > biggest.kb) biggest = { letter, kb };
  process.stdout.write(`  ${letter} ${kb}KB\n`);
  // Clear the queue entry: a letter just built is not dirty, whoever queued it.
  await fetch(`${BASE}/rest/v1/shard_dirty?letter=eq.${encodeURIComponent(letter)}`,
    { method: "DELETE", headers: { ...HEADERS, Prefer: "return=minimal" } }).catch(() => {});
}
console.log(`done: ${Math.round(bytes / 1024)}KB total, biggest ${biggest.letter} ${biggest.kb}KB`);
