// Serves the mirrored catalogue as one shard per first letter.
//
// It lives here rather than on the Cloudflare Worker that builds it because
// Workers are throttled from Russia, which is the audience. The crawler stays on
// Cloudflare — it only ever talks to the source, never to a viewer.
//
// A shard is downloaded once and then matched in the browser, so the only
// latency that matters is this one fetch; everything after it is local.
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};
const REST = `${Deno.env.get("SUPABASE_URL")}/rest/v1/titles`;
const KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const HEADERS = { apikey: KEY, Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" };
// The crawler proves itself with this rather than the service key, which must
// never leave Supabase.
const PUSH_TOKEN = Deno.env.get("PUSH_TOKEN") ?? "";
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const json = (body: unknown, status = 200, cache = "no-store") =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json; charset=utf-8", "Cache-Control": cache },
  });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const url = new URL(req.url);

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
    return json({ ok: true, rows: rows.length });
  }

  // Turn a slug into something playable. The client cannot do this itself:
  // api.zombie-film.live does not resolve from Russia at all, and the index
  // carries a slug precisely so a suggestion is openable before the background
  // backfill has reached it. One call returns the player id and the Kinopoisk
  // id, which is what opening any title costs anyway.
  if (url.pathname.endsWith("/resolve")) {
    const slug = (url.searchParams.get("slug") ?? "").trim();
    if (!/^[a-z0-9-]{1,120}$/i.test(slug)) return json({ error: "bad slug" }, 400);
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
      await fetch(`${REST}?slug=eq.${encodeURIComponent(slug)}`, {
        method: "PATCH", headers: { ...HEADERS, Prefer: "return=minimal" },
        body: JSON.stringify({
          embed_id: embed, kp, origin_name: view.originName ?? null, is_series: isSeries,
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
  const shardFilter = `or=(initial.eq.${encodeURIComponent(folded)},origin_initial.eq.${encodeURIComponent(folded)})`;

  const rows: unknown[] = [];
  // PostgREST caps a page; a busy letter runs to several thousand titles.
  for (let from = 0; from < 20000; from += 1000) {
    const response = await fetch(
      `${REST}?select=name,origin_name,year,slug,is_series,embed_id,kp&${shardFilter}&order=year.desc.nullslast,name.asc`,
      { headers: { ...HEADERS, Range: `${from}-${from + 999}` } },
    );
    if (!response.ok) return json({ error: "upstream" }, 502);
    const page = await response.json();
    // Positional, and the order is the client's contract:
    // [name, year, slug, isSeries, embedId, kp, originName]
    rows.push(...page.map((r: Record<string, unknown>) => [
      r.name, r.year, r.slug, r.is_series ? 1 : 0, r.embed_id, r.kp ?? "", r.origin_name ?? "",
    ]));
    if (page.length < 1000) break;
  }
  // A day: the catalogue gains a handful of titles a day and the client keeps
  // its own copy anyway.
  return json(rows, 200, "public, max-age=86400");
});
