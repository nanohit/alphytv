// LiftW search/metadata relay.
//
// api.liftw.ws was blocked in Russia, and it sends no CORS header at all, so a
// browser cannot read it directly whether or not it is reachable. This relay is
// the only way that data reaches the page. It is deployed to the same rotating
// Supabase projects as the Letterboxd lookup: spreading the workaround across
// several hostnames is the point, since concentrating it on one would recreate
// the single blockable name we are working around.
//
// Playback does NOT come through here. The embed is read straight from
// lift3.ws (which serves `Access-Control-Allow-Origin: *`) and the video comes
// straight from the CDN, so no video ever crosses this function.
//
// This is deliberately NOT a general proxy: only two upstream shapes are
// reachable, and both are rebuilt from validated parts rather than forwarded.
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
};
const UPSTREAM = "https://api.liftw.ws";
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const TIMEOUT_MS = 9000;
// A title's metadata barely moves; a search result set moves a little more.
const CACHE_INFO = "public, max-age=21600";
const CACHE_SEARCH = "public, max-age=3600";

const json = (body: unknown, status = 200, cache = "no-store") =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json", "Cache-Control": cache },
  });

async function upstream(path: string) {
  const response = await fetch(`${UPSTREAM}${path}`, {
    headers: { "User-Agent": UA, Accept: "application/json" },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!response.ok) return { status: response.status, body: null };
  const text = await response.text();
  try {
    return { status: 200, body: JSON.parse(text) };
  } catch {
    // Upstream answering with something that is not JSON is an upstream fault,
    // not a client one, and must not be passed off as a valid empty result.
    return { status: 502, body: null };
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const url = new URL(req.url);
  const mode = url.searchParams.get("mode");

  if (mode === "info") {
    const id = (url.searchParams.get("id") ?? "").trim();
    // LiftW ids are numeric. Anything else is rejected here rather than being
    // handed to the upstream host, which is what keeps this from being a proxy.
    if (!/^\d{1,12}$/.test(id)) return json({ error: "bad id" }, 400);
    const { status, body } = await upstream(`/info/${id}`);
    if (status !== 200) return json({ error: "upstream", status }, status === 404 ? 404 : 502);
    return json(body, 200, CACHE_INFO);
  }

  if (mode === "search") {
    const q = (url.searchParams.get("q") ?? "").trim();
    if (!q || q.length > 120) return json({ error: "bad query" }, 400);
    const { status, body } = await upstream(`/search?q=${encodeURIComponent(q)}`);
    if (status !== 200) return json({ error: "upstream", status }, 502);
    return json(body, 200, CACHE_SEARCH);
  }

  return json({ error: "bad mode" }, 400);
});
