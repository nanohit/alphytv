// Builds the mirrored catalogue into one static shard per first letter, and
// serves a shard directly as a fallback.
//
// It lives here rather than on the Cloudflare Worker that builds the index
// because Workers are throttled from Russia, which is the audience. The crawler
// stays on Cloudflare — it only ever talks to the source, never to a viewer.
//
// Viewers do NOT normally reach this function at all. Cloudflare sits in front
// of Supabase Functions with `cf-cache-status: DYNAMIC` — it never caches a
// function response, whatever Cache-Control says — so every shard request used
// to re-run this code and re-read Postgres: 1.7-2.3s and up to ten PostgREST
// pages for one letter, per viewer, forever. Storage objects ARE cached by that
// same CDN (measured: MISS then HIT, 0.13s), so the shards are written there and
// the browser reads them directly. This function is then only the builder, plus
// the fallback for a letter whose object does not exist yet.
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};
const REST = `${Deno.env.get("SUPABASE_URL")}/rest/v1/titles`;
const DIRTY = `${Deno.env.get("SUPABASE_URL")}/rest/v1/shard_dirty`;
const KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const HEADERS = { apikey: KEY, Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" };
// The crawler proves itself with this rather than the service key, which must
// never leave Supabase.
const PUSH_TOKEN = Deno.env.get("PUSH_TOKEN") ?? "";
const STORAGE = `${Deno.env.get("SUPABASE_URL")}/storage/v1/object`;
const BUCKET = "index";
// Bumped with the client's TITLES_SHARD_VERSION: a shape change writes to a new
// prefix instead of overwriting objects that viewers have already cached.
const SHARD_VERSION = 2;
// A letter names its object by codepoint, so a path is plain ASCII whatever the
// alphabet — the index holds 97 distinct initials, Cyrillic and Latin and CJK.
const shardPath = (letter: string) =>
  `v${SHARD_VERSION}/${letter.codePointAt(0)!.toString(16)}.json`;
const fold = (letter: string) => letter.toLowerCase().replace(/ё/, "е");
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

// Positional, and the order is the client's contract:
// [name, year, slug, isSeries, embedId, kp, originName]
async function shardRows(folded: string) {
  const filter =
    `or=(initial.eq.${encodeURIComponent(folded)},origin_initial.eq.${encodeURIComponent(folded)})`;
  const rows: unknown[] = [];
  // PostgREST caps a page; the busiest letter runs to nine thousand titles.
  for (let from = 0; from < 20000; from += 1000) {
    const response = await fetch(
      `${REST}?select=name,origin_name,year,slug,is_series,embed_id,kp&${filter}` +
      `&order=year.desc.nullslast,name.asc`,
      { headers: { ...HEADERS, Range: `${from}-${from + 999}` } },
    );
    if (!response.ok) throw new Error(`upstream ${response.status}`);
    const page = await response.json();
    rows.push(...page.map((r: Record<string, unknown>) => [
      r.name, r.year, r.slug, r.is_series ? 1 : 0, r.embed_id, r.kp ?? "", r.origin_name ?? "",
    ]));
    if (page.length < 1000) break;
  }
  return rows;
}

const json = (body: unknown, status = 200, cache = "no-store") =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json; charset=utf-8", "Cache-Control": cache },
  });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const url = new URL(req.url);

  // Rebuild shards into Storage. Bounded per call — an edge function has a
  // budget and the busiest letter is ten PostgREST pages — so the crawler simply
  // calls it again on its next tick until `remaining` reaches zero.
  if (url.pathname.endsWith("/build")) {
    if (!PUSH_TOKEN || req.headers.get("x-push-token") !== PUSH_TOKEN) {
      return json({ error: "forbidden" }, 403);
    }
    const max = Math.min(Number(url.searchParams.get("max")) || 6, 20);
    const only = (url.searchParams.get("letters") ?? "").trim();
    // An explicit list is for a full rebuild after a shape change; normally the
    // queue decides, so only letters whose rows actually moved are rewritten.
    const letters = only
      ? [...only].map(fold).filter((l, i, a) => a.indexOf(l) === i).slice(0, max)
      : (await (await fetch(
          `${DIRTY}?select=letter&order=marked_at.asc&limit=${max}`, { headers: HEADERS },
        )).json()).map((r: { letter: string }) => r.letter);

    const built: string[] = [];
    const failed: string[] = [];
    for (const letter of letters) {
      try {
        const body = JSON.stringify(await shardRows(letter));
        const upload = await fetch(`${STORAGE}/${BUCKET}/${shardPath(letter)}`, {
          method: "POST",
          headers: {
            apikey: KEY, Authorization: `Bearer ${KEY}`,
            "Content-Type": "application/json",
            // A day at the CDN. The client keeps its own copy for a week and a
            // shape change moves to a new prefix, so staleness cannot outlive it.
            "Cache-Control": "public, max-age=86400",
            "x-upsert": "true",
          },
          body,
        });
        if (!upload.ok) throw new Error(`storage ${upload.status}`);
        built.push(letter);
        // Cleared only after the object is written, so a failed build is simply
        // retried on the next tick rather than silently dropping a letter.
        await fetch(`${DIRTY}?letter=eq.${encodeURIComponent(letter)}`, {
          method: "DELETE", headers: { ...HEADERS, Prefer: "return=minimal" },
        });
      } catch (error) {
        failed.push(`${letter}: ${String(error).slice(0, 80)}`);
      }
    }
    const left = await fetch(`${DIRTY}?select=letter`, {
      headers: { ...HEADERS, Prefer: "count=exact", Range: "0-0" },
    });
    return json({
      built, failed,
      remaining: Number(left.headers.get("content-range")?.split("/")[1] ?? 0),
    });
  }

  // Ingest, from the Cloudflare crawler only.
  if (req.method === "POST") {
    if (!PUSH_TOKEN || req.headers.get("x-push-token") !== PUSH_TOKEN) {
      return json({ error: "forbidden" }, 403);
    }
    const rows = await req.json();
    if (!Array.isArray(rows) || rows.length > 1000) return json({ error: "bad batch" }, 400);
    const response = await fetch(`${REST}?on_conflict=id`, {
      method: "POST",
      headers: { ...HEADERS, Prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify(rows),
    });
    if (!response.ok) return json({ error: await response.text() }, 502);
    // Which shards this batch invalidated. Both initials, because a row appears
    // in the shard for its Russian name and in the one for its original title.
    const touched = new Set<string>();
    for (const row of rows as Record<string, string>[]) {
      for (const name of [row.name, row.origin_name]) {
        const first = String(name ?? "").replace(/[^\p{L}\p{N}]+/gu, "").trim()[0];
        if (first) touched.add(fold(first));
      }
    }
    if (touched.size) {
      await fetch(`${DIRTY}?on_conflict=letter`, {
        method: "POST",
        headers: { ...HEADERS, Prefer: "resolution=ignore-duplicates,return=minimal" },
        body: JSON.stringify([...touched].map((letter) => ({ letter }))),
      }).catch(() => {});
    }
    return json({ ok: true, rows: rows.length, dirty: touched.size });
  }

  // Turn a slug into something playable. The client cannot do this itself:
  // api.zombie-film.live does not resolve from Russia at all, and the index
  // carries a slug precisely so a suggestion is openable before the background
  // backfill has reached it. One call returns the player id and the Kinopoisk
  // id, which is what opening any title costs anyway.
  if (url.pathname.endsWith("/resolve")) {
    const slug = (url.searchParams.get("slug") ?? "").trim();
    if (!/^[a-z0-9-]{1,120}$/i.test(slug)) return json({ error: "bad slug" }, 400);
    // The slug has to be one we already hold, and this is not a formality: the
    // shape of it was the only gate, so any string of letters and dashes drove
    // an unauthenticated, unthrottled request at api.zombie-film.live from our
    // address. This function sat next to a crawler built entirely around not
    // doing that. Now an unknown slug costs the source nothing.
    //
    // It also gives us the row id, so the write below is by primary key. Asking
    // PostgREST to filter on slug instead was a sequential scan of all 81,702
    // rows — 1035ms measured — on the write half of every single resolve.
    const known = await fetch(`${REST}?select=id&slug=eq.${encodeURIComponent(slug)}&limit=1`,
      { headers: HEADERS });
    if (!known.ok) return json({ error: "index unavailable" }, 502);
    const id = (await known.json())[0]?.id;
    if (!id) return json({ error: "unknown slug" }, 404);
    const ask = async (season: string) => {
      const query = new URLSearchParams({ slug, findBy: "init", all: "false", season, _format: "json" });
      const upstream = await fetch(
        `https://api.zombie-film.live/v2/franchise/view/?${query}`,
        { headers: { "User-Agent": UA, Accept: "application/json" }, signal: AbortSignal.timeout(15_000) },
      );
      if (!upstream.ok) return null;
      return (await upstream.json())?.view ?? null;
    };
    try {
      let view = await ask("");
      if (!view) return json({ error: "upstream" }, 502);
      // A series answers with video:null until a season is named — the episodes
      // hold the player, not the title. Without this retry every series in the
      // index looked like a title with no player and simply refused to open.
      if (!view.video) view = (await ask("1")) ?? view;
      const embed = Number(String(view.video?.embedUrl || "").match(/\/(\d+)/)?.[1]) || null;
      const raw = String(view.kpId ?? "");
      const kp = /^\d+$/.test(raw) && raw !== "0" ? raw : "";
      if (!embed) return json({ error: "no player for this title" }, 404);
      // Write it back so the next viewer gets it from the index for free. The
      // series flag has to go with it: the crawler only set it on rows it
      // reached, so without this a title stays marked as a film forever even
      // after we have just proved otherwise by resolving its season.
      const isSeries = !!view.season || !!view.seasonLast;
      await fetch(`${REST}?id=eq.${id}`, {
        method: "PATCH", headers: { ...HEADERS, Prefer: "return=minimal" },
        body: JSON.stringify({
          embed_id: embed, kp,
          // "" rather than null, matching the crawler: null means "never asked",
          // so writing it for a Russian film with no original title put the row
          // straight back into the crawler's pending set — every time, forever.
          origin_name: String(view.originName ?? ""),
          is_series: isSeries,
        }),
      }).catch(() => {});
      return json({
        slug, embed_id: embed, kp,
        name: view.name ?? "", origin_name: view.originName ?? "", is_series: isSeries,
      }, 200, "public, max-age=3600");
    } catch (error) {
      return json({ error: String(error).slice(0, 120) }, 502);
    }
  }

  if (url.pathname.endsWith("/count")) {
    const r = await fetch(`${REST}?select=id`, { headers: { ...HEADERS, Prefer: "count=exact", Range: "0-0" } });
    return json({ rows: Number(r.headers.get("content-range")?.split("/")[1] ?? 0) });
  }

  // A shard. One letter in, every title starting with it out — by its Russian
  // name OR by its original one, so "Good Will…" and "Умница Уилл…" reach the
  // same row. Routing on the Russian initial alone made an English query load a
  // shard the title could not possibly be in, which is why Latin search found
  // nothing at all rather than merely finding less.
  const letter = (url.searchParams.get("i") ?? "").trim();
  if ([...letter].length !== 1) return json({ error: "one letter expected" }, 400);
  const folded = letter.toLowerCase().replace(/ё/, "е");
  // Only reached for a letter whose Storage object is missing — a brand new
  // initial, or the moment right after a version bump. Serve it, and write the
  // object on the way out so the miss happens once for that letter rather than
  // once per viewer: every reader after this one gets the CDN copy and the
  // database stays out of the read path.
  try {
    const rows = await shardRows(folded);
    // Only a letter that actually has titles earns an object. Otherwise any
    // single character anyone asks for would create one.
    if (rows.length) {
      await fetch(`${STORAGE}/${BUCKET}/${shardPath(folded)}`, {
        method: "POST",
        headers: {
          apikey: KEY, Authorization: `Bearer ${KEY}`,
          "Content-Type": "application/json",
          "Cache-Control": "public, max-age=86400",
          "x-upsert": "true",
        },
        body: JSON.stringify(rows),
      }).catch(() => { /* serving the reader matters more than the cache */ });
    }
    return json(rows, 200, "public, max-age=86400");
  } catch {
    return json({ error: "upstream" }, 502);
  }
});
