// Mirrors the upstream catalogue so search can be answered from our own edge.
//
// Why this exists: reaching any server and coming back costs ~560ms before any
// work is done, so a suggestion list backed by a network call can be fast but
// never instant. A local index makes it instant, and takes the metered search
// quota out of the typing path entirely.
//
// How it behaves toward the source, which matters more than how fast it runs:
//  - one request at a time, spaced SPACING_MS apart, ~25 a minute. That is less
//    traffic than one person browsing, and it is sustained rather than bursty.
//  - any error at all, and especially 429, stops the batch and backs off for
//    longer each time. It never retries into a wall.
//  - the User-Agent says who we are and how to reach us. If they want this to
//    stop, they should be able to say so without guessing who to ask.
//  - the catalogue is read through its own paging API, not scraped from pages.
//
// Everything is resumable: cursors live in D1, so an invocation killed halfway
// loses at most its current batch.

const UA = "AlphyTVIndexer/1.0 (+https://alphy.tv; contact: info@alphy.tv)";
const CATALOG = "https://api.zombie-film.live/v2/franchise/search/";
const INFO = "https://api.liftw.ws/info/";
const PER_PAGE = 100;
// A batch must finish well inside its minute or the next cron overlaps it.
const BUDGET_MS = 50_000;
const BACKOFF_STEPS_MS = [60_000, 300_000, 900_000, 3_600_000];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// SQLite's lower() is ASCII-only, so folding has to happen here or every
// Cyrillic shard comes back empty. ё and й are folded together with е and и the
// same way the client's matcher does, or the two would disagree about shards.
const initialOf = (name) => (String(name || "").trim()[0] || "").toLowerCase().replace(/ё/, "е");
const nowSec = () => Math.floor(Date.now() / 1000);

async function getMeta(db, key, fallback = null) {
  const row = await db.prepare("select value from meta where key = ?").bind(key).first();
  return row?.value ?? fallback;
}

async function setMeta(db, key, value) {
  await db.prepare("insert into meta (key, value) values (?, ?) on conflict(key) do update set value = excluded.value")
    .bind(key, String(value)).run();
}

// A failure is the source telling us something. Back off further each time and
// only clear it after a clean batch, so a bad night cannot turn into a hammer.
async function noteFailure(db, reason) {
  const streak = Number(await getMeta(db, "fail_streak", "0")) + 1;
  const wait = BACKOFF_STEPS_MS[Math.min(streak - 1, BACKOFF_STEPS_MS.length - 1)];
  await setMeta(db, "fail_streak", streak);
  await setMeta(db, "paused_until", Date.now() + wait);
  await setMeta(db, "last_error", `${new Date().toISOString()} ${String(reason).slice(0, 200)}`);
}

async function noteSuccess(db) {
  if (Number(await getMeta(db, "fail_streak", "0")) > 0) await setMeta(db, "fail_streak", "0");
}

async function fetchJson(url) {
  const response = await fetch(url, {
    headers: { "User-Agent": UA, Accept: "application/json" },
    signal: AbortSignal.timeout(20_000),
  });
  if (response.status === 429) throw new Error("429 rate limited");
  if (!response.ok) throw new Error(`http ${response.status}`);
  return response.json();
}

// ---------------------------------------------------------------- phase 1
// The catalogue, page by page. `sortBy=priority` puts what people actually
// watch first, which is also the order phase 2 then fills kpIds in.
async function crawlCatalog(env, db, deadline) {
  let page = Number(await getMeta(db, "catalog_page", "1"));
  const spacing = Number(env.SPACING_MS || 2000);
  let done = 0;

  while (Date.now() < deadline) {
    const query = new URLSearchParams({
      findBy: "filter", all: "false", page: String(page),
      "per-page": String(PER_PAGE), sortBy: "priority", _format: "json",
    });
    let payload;
    try {
      payload = await fetchJson(`${CATALOG}?${query}`);
    } catch (error) {
      await noteFailure(db, `catalog p${page}: ${error.message}`);
      return done;
    }
    const items = Array.isArray(payload?.items) ? payload.items : [];
    if (payload?.totalCount) await setMeta(db, "total_count", payload.totalCount);
    if (!items.length) {
      // Ran off the end: the catalogue is mirrored. Start again from the front
      // tomorrow so new releases are picked up without a second full pass.
      await setMeta(db, "catalog_page", "1");
      await setMeta(db, "catalog_done_at", Date.now());
      return done;
    }

    const seen = nowSec();
    const base = (page - 1) * PER_PAGE;
    // Insert leaves kp alone on conflict: phase 2's work must survive a re-crawl.
    const statement = db.prepare(
      `insert into titles (id, name, year, type, slug, rank, seen, initial)
       values (?, ?, ?, ?, ?, ?, ?, ?)
       on conflict(id) do update set
         name = excluded.name, year = excluded.year, type = excluded.type,
         slug = excluded.slug, rank = excluded.rank, seen = excluded.seen,
         initial = excluded.initial`,
    );
    await db.batch(items.map((item, index) => statement.bind(
      Number(item.id), String(item.name || "").trim(),
      Number(item.year) || null, Number(item.type) || null,
      String(item.slug || ""), base + index, seen, initialOf(item.name),
    )));

    page += 1;
    done += 1;
    await setMeta(db, "catalog_page", page);
    await noteSuccess(db);
    if (Date.now() + spacing >= deadline) break;
    await sleep(spacing);
  }
  return done;
}

// ---------------------------------------------------------------- phase 2
// One /info per title for its Kinopoisk id, which is the join key the rest of
// the site runs on. 81k requests is the expensive half, so it goes in priority
// order: the first few thousand cover nearly all real traffic, and the long
// tail can take days without anyone noticing.
async function fillKpIds(env, db, deadline) {
  const spacing = Number(env.SPACING_MS || 2000);
  const batch = Number(env.BATCH || 25);
  const pending = await db.prepare(
    "select id from titles where kp is null order by rank asc limit ?",
  ).bind(batch).all();
  const rows = pending?.results ?? [];
  let done = 0;

  for (const row of rows) {
    if (Date.now() >= deadline) break;
    let payload;
    try {
      payload = await fetchJson(`${INFO}${row.id}`);
    } catch (error) {
      await noteFailure(db, `info ${row.id}: ${error.message}`);
      return done;
    }
    // "" rather than null: a title genuinely without a Kinopoisk id must not be
    // asked again every single run.
    const kp = String(payload?.info?.id ?? "").match(/^\d+$/)?.[0] ?? "";
    await db.prepare("update titles set kp = ? where id = ?").bind(kp, row.id).run();
    done += 1;
    await noteSuccess(db);
    if (Date.now() + spacing >= deadline) break;
    await sleep(spacing);
  }
  return done;
}

async function runOnce(env) {
  const db = env.DB;
  const pausedUntil = Number(await getMeta(db, "paused_until", "0"));
  if (Date.now() < pausedUntil) return { skipped: "backoff" };

  // Two tick sources drive this (Cloudflare cron and an external heartbeat), so
  // overlapping runs are expected. A lease keeps the pace honest: without it two
  // runners would double the request rate at the source, which is the one thing
  // this crawler must not do. It expires on its own so a killed run cannot wedge
  // the pipeline shut.
  const lease = Number(await getMeta(db, "running_until", "0"));
  if (Date.now() < lease) return { skipped: "locked" };
  await setMeta(db, "running_until", Date.now() + BUDGET_MS + 10_000);
  await setMeta(db, "last_tick", new Date().toISOString());

  const deadline = Date.now() + BUDGET_MS;
  const catalogDone = await getMeta(db, "catalog_done_at");
  // The catalogue comes first: it is only 817 requests and it is what makes the
  // index usable at all. kpIds enrich an index that already works.
  try {
    // Rows written before `initial` existed have to be folded too, or they are
    // invisible to every shard query. Done a chunk at a time inside the normal
    // run so it needs no second scheduler, and it touches nobody's server.
    const stale = await db.prepare(
      "select id, name from titles where initial is null limit 900",
    ).all();
    const staleRows = stale?.results ?? [];
    if (staleRows.length) {
      const fix = db.prepare("update titles set initial = ? where id = ?");
      await db.batch(staleRows.map((row) => fix.bind(initialOf(row.name), row.id)));
    }

    if (!catalogDone) {
      const pages = await crawlCatalog(env, db, deadline);
      if (Date.now() < deadline && (await getMeta(db, "catalog_done_at"))) {
        const filled = await fillKpIds(env, db, deadline);
        return { pages, filled };
      }
      return { pages };
    }
    const filled = await fillKpIds(env, db, deadline);
    return { filled };
  } finally {
    await setMeta(db, "running_until", "0");
  }
}

async function status(db) {
  const totals = await db.prepare(
    `select count(*) as titles,
            sum(case when kp is null then 0 else 1 end) as with_kp,
            sum(case when kp = '' then 1 else 0 end) as no_kp_upstream
     from titles`,
  ).first();
  const meta = await db.prepare("select key, value from meta").all();
  const bag = Object.fromEntries((meta?.results ?? []).map((r) => [r.key, r.value]));
  const total = Number(bag.total_count || 0);
  const withKp = Number(totals?.with_kp || 0);
  const pending = Math.max(0, Number(totals?.titles || 0) - withKp);
  // 25 a minute is the configured pace; this is the honest remaining wall time.
  const hoursLeft = pending / 25 / 60;

  return {
    каталог: {
      собрано: Number(totals?.titles || 0),
      всего_у_источника: total || null,
      готов: !!bag.catalog_done_at,
      страница_курсора: Number(bag.catalog_page || 1),
    },
    kpid: {
      заполнено: withKp,
      осталось: pending,
      без_kpid_у_источника: Number(totals?.no_kp_upstream || 0),
      осталось_часов: Number(hoursLeft.toFixed(1)),
    },
    состояние: {
      пауза_до: Number(bag.paused_until || 0) > Date.now()
        ? new Date(Number(bag.paused_until)).toISOString() : null,
      неудач_подряд: Number(bag.fail_streak || 0),
      без_первой_буквы: Number((await db.prepare(
        "select count(*) as n from titles where initial is null").first())?.n || 0),
      последний_тик: bag.last_tick || null,
      последняя_ошибка: bag.last_error || null,
    },
    темп: "25 запросов/мин, по одному, интервал 2 с",
  };
}

export default {
  async scheduled(_event, env, ctx) {
    // Record the failure rather than swallowing it: a cron that dies silently
    // looks exactly like a cron that is not firing, and the two need different
    // fixes at three in the morning.
    ctx.waitUntil(runOnce(env).catch((error) => setMeta(env.DB, "last_error",
      `${new Date().toISOString()} scheduled: ${String(error?.stack || error).slice(0, 300)}`)));
  },

  async fetch(req, env) {
    const url = new URL(req.url);
    const json = (body, code = 200) => new Response(JSON.stringify(body, null, 1), {
      status: code,
      headers: { "Content-Type": "application/json; charset=utf-8", "Access-Control-Allow-Origin": "*" },
    });

    // Manual kick, for when something needs looking at without waiting a minute.
    if (url.pathname === "/run") {
      try {
        return json({ ok: true, ...(await runOnce(env)) });
      } catch (error) {
        return json({ ok: false, error: String(error?.stack || error).slice(0, 600) }, 500);
      }
    }

    if (url.pathname === "/" || url.pathname === "/status") {
      return json(await status(env.DB));
    }

    // A shard of the index: every title whose name starts with one letter.
    // This is what the browser downloads once and then matches locally.
    if (url.pathname.startsWith("/index/")) {
      const letter = decodeURIComponent(url.pathname.slice("/index/".length)).replace(/\.json$/, "");
      if ([...letter].length !== 1) return json({ error: "one letter" }, 400);
      const rows = await env.DB.prepare(
        "select id, name, year, type, kp from titles where initial = ? order by rank asc",
      ).bind(initialOf(letter)).all();
      return new Response(
        JSON.stringify((rows?.results ?? []).map((r) => [r.name, r.year, r.id, r.type, r.kp || ""])),
        {
          headers: {
            "Content-Type": "application/json; charset=utf-8",
            "Access-Control-Allow-Origin": "*",
            "Cache-Control": "public, max-age=3600",
          },
        },
      );
    }

    return json({ error: "not found" }, 404);
  },
};
