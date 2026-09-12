#!/usr/bin/env node
// Keeps the title index in step with the source, from a scheduled GitHub job.
//
// The Cloudflare crawler read the catalogue once and then stopped for good —
// `catalog_done_at` is never cleared — so every title listed since was missing
// from search (the source had 81,953, the index 81,702). It also runs on a plan
// that kills an invocation after 10 ms of CPU. This job runs hourly instead:
//
//  - the first pages of the listing, which is newest first (by year, then
//    release), until three pages in a row bring nothing new — a new release is
//    in search within the hour;
//  - every four hours, the whole listing, including episode revision markers;
//  - then the titles still missing their player or Kinopoisk id, newest first.
//
// How it treats the source is unchanged from the crawler it replaces: one
// request at a time, two seconds apart, a User-Agent that says who we are, and
// any 429 ends the run rather than retrying into it. Only new or changed rows
// are written (titles_upsert_catalog), so a daily full read costs the database
// nothing for a title that did not change.
//
//   PUBLISH_TOKEN=… node scripts/sync-titles.mjs [--full] [--fill 300] [--budget-min 45]
import { pathToFileURL } from "node:url";

export const UA = "AlphyTVIndexer/1.0 (+https://alphy.tv; contact: info@alphy.tv)";
const CATALOG = "https://api.zombie-film.live/v2/franchise/search/";
const VIEW = "https://api.zombie-film.live/v2/franchise/view/";
const TITLES_URL = process.env.TITLES_URL || "https://xoathqkggcuyoyutxwri.supabase.co/functions/v1/titles";
export const SPACING_MS = 2000;
const PER_PAGE = 100;
const HEAD_MIN_PAGES = 3;
const HEAD_QUIET_PAGES = 3;
const HEAD_MAX_PAGES = 40;
const FILL_BATCH = 25;
const SOFT_STREAK_LIMIT = 5;

export class SoftError extends Error {}

export const net = {
  token: process.env.PUBLISH_TOKEN || "",
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  async source(url, { soft = false } = {}) {
    const response = await fetch(url, {
      headers: { "User-Agent": UA, Accept: "application/json" },
      signal: AbortSignal.timeout(20_000),
    });
    // 429 is always about us, never about the row: the run ends here.
    if (response.status === 429) throw new Error("429 rate limited");
    if (!response.ok) {
      if (soft) throw new SoftError(`http ${response.status}`);
      throw new Error(`http ${response.status}`);
    }
    return response.json();
  },
  async titles(route, body) {
    const response = await fetch(`${TITLES_URL}${route}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { "x-publish-token": net.token, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
    });
    if (!response.ok) throw new Error(`titles ${route} ${response.status} ${(await response.text()).slice(0, 200)}`);
    return response.json();
  },
};

export function catalogRow(item) {
  return {
    id: Number(item?.id),
    name: String(item?.name || "").trim(),
    year: Number(item?.year) || null,
    type: Number(item?.type) || null,
    slug: String(item?.slug || ""),
    rate_kp: Number(item?.rate?.kinopoisk) || null,
    // Compact source revision; no additional fields are exposed in the UI.
    source_revision: JSON.stringify([item?.seasonLast?.season ?? null, item?.episodeLast?.episode ?? null,
      item?.finished ?? null, item?.quality ?? null, item?.status ?? null]),
  };
}

export async function syncCatalog({ full = false, deadline = Infinity } = {}) {
  const stats = { pages: 0, inserted: 0, updated: 0, total: 0, reachedEnd: false };
  let lastFirst = "";
  let quiet = 0;
  for (let page = 1; net.now() < deadline; page += 1) {
    if (page > 1) await net.sleep(SPACING_MS);
    const query = new URLSearchParams({
      findBy: "filter", all: "false", page: String(page), "per-page": String(PER_PAGE), _format: "json",
    });
    const payload = await net.source(`${CATALOG}?${query}`);
    const items = Array.isArray(payload?.items) ? payload.items : [];
    const total = Number(payload?.totalCount) || 0;
    if (total) stats.total = total;
    // The end does not look like an empty page: the API serves the last page
    // again for any page past it, forever.
    const first = String(items[0]?.id ?? "");
    if (!items.length || first === lastFirst || (total && (page - 1) * PER_PAGE >= total)) {
      stats.reachedEnd = true;
      break;
    }
    lastFirst = first;
    const rows = items.map(catalogRow).filter((row) => Number.isInteger(row.id) && row.id > 0 && row.name);
    const result = await net.titles("/catalog", rows);
    stats.pages += 1;
    stats.inserted += Number(result?.inserted) || 0;
    stats.updated += Number(result?.updated) || 0;
    if (full) continue;
    quiet = (Number(result?.inserted) || 0) + (Number(result?.updated) || 0) ? 0 : quiet + 1;
    if ((page >= HEAD_MIN_PAGES && quiet >= HEAD_QUIET_PAGES) || page >= HEAD_MAX_PAGES) break;
  }
  return stats;
}

async function titleView(slug) {
  const ask = (season) => net.source(`${VIEW}?${new URLSearchParams({
    slug, findBy: "init", all: "false", season, _format: "json",
  })}`, { soft: true });
  let payload = await ask("");
  // A series answers video:null until a season is named.
  if (!payload?.view?.video) {
    await net.sleep(SPACING_MS);
    payload = (await ask("1")) ?? payload;
  }
  if (!payload?.view || typeof payload.view !== "object" || !Object.keys(payload.view).length) throw new SoftError("empty title view");
  return payload.view;
}

export function fillRow(id, view) {
  // "" rather than null records a confirmed absence; the due queue retries it.
  const raw = String(view?.kpId ?? "");
  const kp = /^\d+$/.test(raw) && raw !== "0" ? raw : "";
  const embed = Number(String(view?.video?.embedUrl || "").match(/\/(\d+)/)?.[1]) || null;
  return {
    id,
    kp,
    embed_id: embed,
    origin_name: String(view?.originName || ""),
    is_series: !!(view?.season || view?.seasonLast),
  };
}

export async function fullScanDue() {
  const state = await net.titles("/sync-state");
  const last = Date.parse(state?.last_full_at);
  return !Number.isFinite(last) || net.now() - last >= 4 * 3600e3;
}

export async function fillPending({ limit = 300, deadline = Infinity } = {}) {
  const { rows } = await net.titles(`/pending?limit=${limit}`);
  const stats = { asked: 0, filled: 0, failed: 0, stoppedBy: "" };
  let batch = [];
  let softStreak = 0;
  const flush = async () => {
    if (!batch.length) return;
    await net.titles("/fill", batch);
    batch = [];
  };
  try {
    for (const row of rows || []) {
      if (net.now() >= deadline) {
        stats.stoppedBy = "budget";
        break;
      }
      if (stats.asked > 0) await net.sleep(SPACING_MS);
      stats.asked += 1;
      try {
        batch.push(fillRow(row.id, await titleView(row.slug)));
        stats.filled += 1;
        softStreak = 0;
      } catch (error) {
        if (!(error instanceof SoftError)) {
          stats.stoppedBy = error.message;
          break;
        }
        batch.push({ id: row.id, failed: true });
        stats.failed += 1;
        // Scattered bad rows are normal; a run of them means the source is unhappy.
        if (++softStreak >= SOFT_STREAK_LIMIT) {
          stats.stoppedBy = "five failures in a row";
          break;
        }
      }
      if (batch.length >= FILL_BATCH) await flush();
    }
  } finally {
    await flush();
  }
  return stats;
}

export async function buildFallback({ deadline = Infinity, maxCalls = 25 } = {}) {
  let built = 0;
  for (let i = 0; i < maxCalls && net.now() < deadline; i += 1) {
    const result = await net.titles("/build?max=6", {});
    built += result.built?.length || 0;
    if (result.failed?.length) throw new Error(`fallback build failed: ${result.failed.join(",")}`);
    if (!result.remaining || !result.built?.length) return { built, remaining: result.remaining || 0 };
  }
  throw new Error("fallback build did not drain before budget");
}

function argument(name, fallback) {
  const at = process.argv.indexOf(`--${name}`);
  return at >= 0 ? process.argv[at + 1] : fallback;
}

async function main() {
  if (!net.token) throw new Error("PUBLISH_TOKEN is required");
  const full = process.argv.includes("--full") || (process.argv.includes("--auto") && await fullScanDue());
  const deadline = net.now() + Number(argument("budget-min", "45")) * 60e3;
  const catalog = await syncCatalog({ full, deadline });
  if (full && catalog.reachedEnd) await net.titles("/sync-state", {});
  console.log(`catalogue: ${catalog.pages} pages, ${catalog.inserted} new, ${catalog.updated} changed` +
    ` (source lists ${catalog.total}${full ? `, full read ${catalog.reachedEnd ? "complete" : "cut short"}` : ""})`);
  const fill = await fillPending({ limit: Number(argument("fill", "300")), deadline });
  console.log(`fill: ${fill.filled} resolved, ${fill.failed} failed of ${fill.asked} asked` +
    (fill.stoppedBy ? `; stopped: ${fill.stoppedBy}` : ""));
  // Separate budget so a full catalogue read cannot starve the fallback build.
  console.log("fallback:", await buildFallback({ deadline: net.now() + 5 * 60e3 }));
  if (full && !catalog.reachedEnd) throw new Error("full source scan incomplete");
  if (fill.stoppedBy && fill.stoppedBy !== "budget") throw new Error(`fill stopped: ${fill.stoppedBy}`);
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
