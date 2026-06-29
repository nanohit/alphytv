// One-time migration: replace curated-list posters whose host is blocked in RU
// (newdeaf's static.cdnlbox.club) with the correct Kinopoisk poster
// (avatars.mds.yandex.net), matched by EXACT title through the resolver.
//
// The number in a zen:/kp: item key is a ZONA id, not a Kinopoisk id, so the
// poster must be matched by title — never derived from the key. Years stored in
// the catalog are unreliable, so the search uses title only.
//
// Usage:
//   node scripts/fix-posters.mjs                       # dry run: report + fixed-catalog.json
//   node scripts/fix-posters.mjs --apply               # write live blob (after a backup)
//   node scripts/fix-posters.mjs --restore <backup>    # roll back to a saved backup
//
// Writes use BLOB_READ_WRITE_TOKEN (loaded from .env.local), same as the server.

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { writeCatalog } from "../api/_catalog-store.js";

// Load .env.local so BLOB_READ_WRITE_TOKEN is available to writeCatalog.
(function loadEnv() {
  try {
    for (const line of readFileSync(new URL("../.env.local", import.meta.url), "utf8").split("\n")) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/i);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  } catch { /* no .env.local */ }
})();

const RESOLVER_BASE = process.env.RESOLVER_BASE || "https://alphytv.alphy.deno.net";
const BLOB_URL = process.env.BLOB_URL ||
  "https://nvpuetq65dds3gtx.public.blob.vercel-storage.com/catalog/curated.json";
const OUT = new URL("./fixed-catalog.json", import.meta.url);
const BACKUP_DIR = new URL("../docs/catalog-backups/", import.meta.url);

const norm = (s) => String(s || "").toLowerCase().replace(/[^a-zа-яё0-9]+/gi, "");
const host = (u) => { try { return new URL(u).hostname.toLowerCase(); } catch { return ""; } };
const isYandex = (u) => /(^|\.)yandex\.net$/.test(host(u));
const needsFix = (u) => !u || !isYandex(u);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fetchLive = async () => (await fetch(`${BLOB_URL}?t=${Date.now()}`, { cache: "no-store" })).json();

// Resolve a Kinopoisk id to its final, RU-reachable Yandex poster URL by following
// st.kp's redirect to avatars.mds.yandex.net (the same host the working posters
// use). The resolver sometimes answers from the kinopoiskapiunofficial.tech
// fallback whose URLs are an extra redirect hop through a flaky third party — we
// only want the kpId from it, never that host.
async function yandexPoster(kpId) {
  if (!/^\d+$/.test(String(kpId))) return "";
  try {
    const res = await fetch(`https://st.kp.yandex.net/images/film_iphone/iphone360_${kpId}.jpg`, { redirect: "follow" });
    if (res.ok && /^image\//.test(res.headers.get("content-type") || "")) return res.url;
  } catch { /* ignore */ }
  return "";
}

async function resolvePoster(title) {
  const res = await fetch(`${RESOLVER_BASE}/search?q=${encodeURIComponent(title)}&limit=8`,
    { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`resolver ${res.status}`);
  const results = ((await res.json())?.results || []).filter((r) => r.poster);
  const want = norm(title);
  let best = null;
  results.forEach((r, idx) => {
    const titles = [r.name, r.alternativeName, r.enName].map(norm).filter(Boolean);
    const exact = titles.includes(want);
    const hit = exact || titles.some((t) => t && (t.includes(want) || want.includes(t)));
    if (!hit) return;
    const score = (exact ? 100 : 40) - idx;
    if (!best || score > best.score) best = { score, exact, kpId: r.kpId, poster: r.poster, name: r.name, year: r.year };
  });
  if (!best) return { poster: "", confidence: "none" };
  // Always store a direct Yandex poster, never the resolver's source-dependent URL.
  const poster = (await yandexPoster(best.kpId)) || (isYandex(best.poster) ? best.poster : "");
  return { ...best, poster, confidence: poster ? (best.exact ? "high" : "low") : "none" };
}

// Convert posters already written as kinopoiskapiunofficial.tech (or st.kp) URLs —
// which carry the real kpId — to direct avatars.mds.yandex.net URLs.
async function normalize({ apply }) {
  const live = await fetchLive();
  const baseRevision = Number(live?.revision);
  const original = JSON.stringify(live, null, 2);
  const lists = Array.isArray(live?.lists) ? live.lists : [];
  let changed = 0;
  for (const list of lists) {
    for (const item of Array.isArray(list?.items) ? list.items : []) {
      if (isYandex(item.poster)) continue;
      const m = String(item.poster || "").match(/\/(?:kp\/|iphone360_|film_big\/)(\d+)\.jpg/i);
      if (!m) continue;
      const avatars = await yandexPoster(m[1]);
      await sleep(60);
      if (avatars) { item.poster = avatars; item.backdrop = ""; changed += 1; }
    }
  }
  console.log(`Normalized ${changed} posters to avatars.mds.yandex.net (rev ${baseRevision})`);
  if (!apply) { console.log("Dry run. Re-run with --apply."); return; }
  mkdirSync(BACKUP_DIR, { recursive: true });
  const backupFile = new URL(`curated-pre-normalize-${new Date().toISOString().slice(0, 10)}-r${baseRevision}.json`, BACKUP_DIR);
  writeFileSync(backupFile, `${original}\n`);
  console.log(`Backup: ${backupFile.pathname}`);
  const result = await writeCatalog({ lists }, baseRevision);
  console.log(`Applied. New revision: ${result.catalog.revision}`);
}

async function migrate({ apply }) {
  const live = await fetchLive();
  const baseRevision = Number(live?.revision);
  const original = JSON.stringify(live, null, 2); // pre-mutation snapshot for the backup
  const lists = Array.isArray(live?.lists) ? live.lists : [];
  let total = 0, fixed = 0, kept = 0;
  const report = [];

  for (const list of lists) {
    for (const item of Array.isArray(list?.items) ? list.items : []) {
      total += 1;
      if (!needsFix(item.poster)) continue;
      let m;
      try { m = await resolvePoster(item.title); }
      catch (e) { m = { poster: "", confidence: "error", err: e.message }; }
      await sleep(120);
      const accept = m.poster && m.confidence === "high";
      if (accept) { item.poster = m.poster; item.backdrop = ""; fixed += 1; }
      else kept += 1;
      report.push({
        title: item.title, year: item.year, confidence: m.confidence,
        matched: m.name ? `${m.name} (${m.year})` : "—", action: accept ? "FIXED" : "KEPT",
      });
    }
  }

  console.log(`\nItems: ${total} | fixed: ${fixed} | kept: ${kept} (rev ${baseRevision})`);
  console.log("\nMapping (your title -> matched Kinopoisk title):");
  for (const r of report) console.log(`  [${r.action} ${r.confidence}] "${r.title}" (${r.year}) -> ${r.matched}`);

  writeFileSync(OUT, JSON.stringify({ lists }, null, 2));
  console.log(`\nFixed catalog written to ${OUT.pathname}`);

  if (!apply) {
    console.log("\nDry run only. Re-run with --apply to write the live blob.");
    return;
  }
  // Back up the pre-migration live catalog so it can be restored.
  mkdirSync(BACKUP_DIR, { recursive: true });
  const stamp = new Date().toISOString().slice(0, 10);
  const backupFile = new URL(`curated-pre-poster-${stamp}-r${baseRevision}.json`, BACKUP_DIR);
  writeFileSync(backupFile, `${original}\n`);
  console.log(`Backup: ${backupFile.pathname}`);

  const result = await writeCatalog({ lists }, baseRevision);
  console.log(`Applied. New revision: ${result.catalog.revision}`);
}

async function restore(file) {
  if (!file) { console.error("Usage: --restore <backup.json>"); process.exit(1); }
  const saved = JSON.parse(readFileSync(file, "utf8"));
  const live = await fetchLive();
  const result = await writeCatalog({ lists: saved.lists }, Number(live?.revision));
  console.log(`Restored "${file}" -> live revision ${result.catalog.revision}`);
}

const args = process.argv.slice(2);
const ri = args.indexOf("--restore");
const fail = (e) => { console.error(e); process.exit(1); };
if (ri !== -1) restore(args[ri + 1]).catch(fail);
else if (args.includes("--normalize")) normalize({ apply: args.includes("--apply") }).catch(fail);
else migrate({ apply: args.includes("--apply") }).catch(fail);
