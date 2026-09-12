#!/usr/bin/env node
// Bounded warming of the real external recommendation graph. No local ranking.
import { readFile } from "node:fs/promises";
import { hostFor, replicaFor, objectPath } from "../supabase/functions/kp/index.ts";
const token = process.env.KP_BROKER_TOKEN;
if (!token) throw new Error("KP_BROKER_TOKEN required");
const catalog = JSON.parse(await readFile(process.argv[2] || "curated-fallback.json", "utf8"));
const seeds = [...new Set(catalog.lists.flatMap((list) => list.items || []).map((item) => String(item.target?.kpId || item.kpId || "")).filter((id) => /^[1-9]\d*$/.test(id)))];
const maxFills = Math.max(1, Math.min(500, Number(process.env.KP_PREWARM_MAX || 120)));
let fills = 0;
const deadline = Date.now() + 15 * 60e3;
async function get(kind, id) {
  if (Date.now() >= deadline) throw new Error("prewarm time budget reached; remaining objects wait for next run");
  for (const host of [hostFor(id), replicaFor(id)]) {
    try {
      const r = await fetch(`https://${host}.supabase.co/storage/v1/object/public/kp/${objectPath(kind, id)}`, { signal: AbortSignal.timeout(5000) });
      if (r.ok) {
        const object = await r.json();
        if (object.kind === kind && String(object.id) === id && Date.parse(object.freshUntil) > Date.now()) return object.data;
      }
    } catch { /* replica */ }
  }
  if (fills >= maxFills) return null;
  fills += 1;
  const r = await fetch(`https://xoathqkggcuyoyutxwri.supabase.co/functions/v1/kp?kind=${kind}&id=${id}`, {
    headers: { "x-kp-token": token }, signal: AbortSignal.timeout(20000),
  });
  const body = await r.json();
  if (body.error === "budget_exhausted" || body.error === "keys_refused") throw new Error("shared quota exhausted; stop prewarming");
  if (!r.ok) throw new Error(`prewarm failed: ${r.status} ${body.error || ""}`);
  return body.data || null;
}
const candidates = new Set();
for (const id of seeds) {
  for (const kind of ["film", "staff", "similars"]) {
    const value = await get(kind, id);
    if (kind === "similars") for (const item of value?.items || []) {
      const next = String(item.filmId || item.kinopoiskId || "");
      if (/^[1-9]\d*$/.test(next)) candidates.add(next);
    }
  }
}
for (const id of candidates) await get("film", id);
console.log(`prewarm: ${seeds.length} seeds, ${candidates.size} external candidates, ${fills}/${maxFills} fills`);
