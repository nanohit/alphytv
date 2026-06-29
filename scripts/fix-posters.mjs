// One-time migration: replace curated-list posters whose host is blocked in RU
// (newdeaf's static.cdnlbox.club) with the correct Kinopoisk poster
// (avatars.mds.yandex.net), matched by title+year through the resolver.
//
// The number in a zen:/kp: item key is a ZONA id, not a Kinopoisk id, so the
// poster must be matched by title — never derived from the key.
//
// Usage:
//   node scripts/fix-posters.mjs              # dry run: report + writes fixed JSON
//   node scripts/fix-posters.mjs --apply      # PUTs to the admin API (needs creds)
//
// Env (only for --apply):
//   ALPHY_ADMIN_USER, ALPHY_ADMIN_PASSWORD
//   ADMIN_BASE     (default https://alphy.tv)
//   RESOLVER_BASE  (default https://alphytv.alphy.deno.net)
//   BLOB_URL       (default the public curated blob)

const APPLY = process.argv.includes("--apply");
const RESOLVER_BASE = process.env.RESOLVER_BASE || "https://alphytv.alphy.deno.net";
const ADMIN_BASE = process.env.ADMIN_BASE || "https://alphy.tv";
const BLOB_URL = process.env.BLOB_URL ||
  "https://nvpuetq65dds3gtx.public.blob.vercel-storage.com/catalog/curated.json";
const OUT = new URL("./fixed-catalog.json", import.meta.url);

const norm = (s) => String(s || "").toLowerCase().replace(/[^a-zа-яё0-9]+/gi, "");
const host = (u) => { try { return new URL(u).hostname.toLowerCase(); } catch { return ""; } };
const isYandex = (u) => /(^|\.)yandex\.net$/.test(host(u));
const needsFix = (u) => !u || !isYandex(u); // anything not already a Yandex/Kinopoisk poster

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function resolvePoster(title, year) {
  // Search by title only — the stored years in the curated data are unreliable
  // (e.g. "Солтберн" saved as 2006, really 2023), so feeding the year filters out
  // correct films. Title is the signal; year is only a soft tiebreak among films
  // that share an exact title.
  const url = `${RESOLVER_BASE}/search?q=${encodeURIComponent(title)}&limit=8`;
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`resolver ${res.status}`);
  const data = await res.json();
  const results = (Array.isArray(data?.results) ? data.results : []).filter((r) => r.poster);

  const wantTitle = norm(title);
  const wantYear = parseInt(year, 10);
  let best = null;
  results.forEach((r, idx) => {
    const titles = [r.name, r.alternativeName, r.enName].map(norm).filter(Boolean);
    const exactTitle = titles.includes(wantTitle);
    const titleHit = exactTitle || titles.some((t) => t && (t.includes(wantTitle) || wantTitle.includes(t)));
    if (!titleHit) return;
    const ry = parseInt(r.year, 10);
    const yearHit = Number.isFinite(wantYear) && Number.isFinite(ry) && Math.abs(ry - wantYear) <= 1;
    // exact title dominates; relevance order (idx) and a matching year break ties.
    const score = (exactTitle ? 100 : 40) + (yearHit ? 5 : 0) - idx;
    if (!best || score > best.score) {
      best = { score, exactTitle, titleHit, yearHit, poster: r.poster, name: r.name, year: r.year };
    }
  });
  if (!best) return { poster: "", confidence: "none" };
  const confidence = best.exactTitle ? "high" : best.titleHit ? "low" : "none";
  return { ...best, confidence };
}

async function main() {
  const live = await (await fetch(BLOB_URL, { cache: "no-store" })).json();
  const lists = Array.isArray(live?.lists) ? live.lists : [];
  const baseRevision = Number(live?.revision);
  let total = 0, fixed = 0, kept = 0, low = 0, failed = 0;
  const report = [];

  for (const list of lists) {
    for (const item of Array.isArray(list?.items) ? list.items : []) {
      total += 1;
      if (!needsFix(item.poster)) continue; // already a Yandex poster
      let m;
      try { m = await resolvePoster(item.title, item.year); }
      catch (e) { m = { poster: "", confidence: "error", err: e.message }; }
      await sleep(120); // be gentle on the resolver / poiskkino quota

      // Only an exact title match is auto-applied; ambiguous substring matches
      // (e.g. "Мортал Комбат" -> "Мортал Комбат 2") are left alone so the
      // migration can never bake in a wrong cover. Those are flagged for review.
      const accept = m.poster && m.confidence === "high";
      if (accept) {
        item.poster = m.poster;
        item.backdrop = "";
        fixed += 1;
      } else if (m.confidence === "low") {
        low += 1; kept += 1;
      } else {
        failed += 1; kept += 1;
      }
      report.push({
        list: list.title, title: item.title, year: item.year,
        confidence: m.confidence, matched: m.name ? `${m.name} (${m.year})` : "—",
        action: accept ? "FIXED" : "KEPT",
      });
    }
  }

  console.log(`\nItems: ${total} | fixed: ${fixed} | kept(low/none/err): ${kept} (low ${low}, fail ${failed})`);
  console.log("\nFull mapping (your title -> matched Kinopoisk title) — eyeball franchises:");
  for (const r of report) {
    console.log(`  [${r.action} ${r.confidence}] "${r.title}" (${r.year}) -> ${r.matched}`);
  }

  const fixedCatalog = { lists };
  const { writeFileSync } = await import("node:fs");
  writeFileSync(OUT, JSON.stringify(fixedCatalog, null, 2));
  console.log(`\nFixed catalog written to ${OUT.pathname}`);

  if (!APPLY) {
    console.log("\nDry run only. Review above, then re-run with --apply (and ALPHY_ADMIN_USER/PASSWORD set).");
    return;
  }
  const user = process.env.ALPHY_ADMIN_USER, pass = process.env.ALPHY_ADMIN_PASSWORD;
  if (!user || !pass) { console.error("Set ALPHY_ADMIN_USER and ALPHY_ADMIN_PASSWORD to --apply."); process.exit(1); }
  const auth = "Basic " + Buffer.from(`${user}:${pass}`).toString("base64");
  const res = await fetch(`${ADMIN_BASE}/api/admin/catalog`, {
    method: "PUT",
    headers: { "content-type": "application/json", authorization: auth },
    body: JSON.stringify({ catalog: fixedCatalog, baseRevision }),
  });
  const body = await res.text();
  if (!res.ok) { console.error(`PUT failed ${res.status}: ${body.slice(0, 300)}`); process.exit(1); }
  console.log(`\nApplied. ${body.slice(0, 200)}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
