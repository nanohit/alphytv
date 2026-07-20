import { clientPool, readKeyPool } from "./_key-pool-store.js";

function send(res, body, status = 200) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Access-Control-Allow-Origin", "*");
  // Keys in this view are intentionally public. CDN caching keeps this control
  // request off both Deno and the Vercel function hot path for normal browsing.
  res.setHeader("Cache-Control", "public, max-age=300, s-maxage=300, stale-while-revalidate=3600");
  res.end(JSON.stringify(body));
}

export default async function handler(req, res) {
  if (req.method === "OPTIONS") {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
    res.statusCode = 204;
    res.end();
    return;
  }
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET, OPTIONS");
    send(res, { ok: false, error: "method_not_allowed" }, 405);
    return;
  }
  try {
    const { pool, exists } = await readKeyPool();
    if (!exists) {
      send(res, { ok: true, pool: { schema: 1, revision: 0, updatedAt: null, keys: [] } });
      return;
    }
    send(res, { ok: true, pool: clientPool(pool) });
  } catch (error) {
    console.error("[client-key-pool]", error?.message || String(error));
    send(res, { ok: false, error: "client_key_pool_failed" }, 503);
  }
}
