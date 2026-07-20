(() => {
  "use strict";

  // =====================================================================
  // «Для вас» — personalized recommendations, fully client-side.
  //
  // Engine: kinopoiskapiunofficial.tech /films/{id}/similars called straight
  // from the browser (the API sends Access-Control-Allow-Origin: * and its
  // preflight allows X-API-KEY). Seeds come from alphy.history/alphy.bookmarks
  // in localStorage; blending, scoring and filtering all happen locally, so
  // the only thing that ever leaves the device is "what is similar to film N".
  //
  // The key pool below is DEDICATED to recommendations — never add the
  // resolver's search keys here, budgets must stay independent.
  //
  // Modes (admin-controlled via the curated catalog envelope, see catalog.js):
  //   on     — full pipeline, budgeted network fetches allowed
  //   frozen — render from localStorage caches only, zero network
  //   off    — feature disabled for everyone, no computation at all
  // =====================================================================

  const API_BASE = "https://kinopoiskapiunofficial.tech";
  // Free accounts, ~500 calls/day each. They get DEACTIVATED in batches (a 403
  // "User <mail> is inactive or deleted"), so apiGet treats 403 as a rotate
  // condition and the pool is sized for attrition rather than for throughput.
  const API_KEYS = [
    "19a609a9-5189-48b0-b63f-9c47e497b1a9",
    "da5f42e9-abf3-453b-b9f5-19a4bf1b976c",
    "b9c5caf4-7081-49ac-9e9e-cca2bc86a6fc",
    "8767da3b-0432-4fa8-871f-4f029fb6643d",
  ];

  const SIM_PREFIX = "alphy.foryou.sim.";
  const META_PREFIX = "alphy.foryou.meta.";
  const LOOKUP_PREFIX = "alphy.foryou.lookup.";
  const QUOTA_PREFIX = "alphy.foryou.quota.";
  const LAST_KEY = "alphy.foryou.last.v1";
  const KEY_CURSOR_KEY = "alphy.foryou.keycursor";
  const HIDDEN_KEY = "alphy.foryou.hidden.v1";
  const HIDDEN_CAP = 400;

  const SIM_TTL = 30 * 24 * 3600e3;
  const META_TTL = 30 * 24 * 3600e3;
  const LOOKUP_TTL = 30 * 24 * 3600e3;
  const NEGATIVE_TTL = 6 * 3600e3;

  const MAX_SEEDS = 12;
  const MAX_SIM_FETCH_PER_RUN = 10;
  const MAX_META_FETCH_PER_RUN = 8;
  const MAX_LOOKUP_PER_RUN = 5;
  // The pool is ~500 calls/day per key of real capacity. The cap is the safety
  // rail, not the target: the pipeline is cache-first, so a normal day spends a
  // handful. It now also covers «Похожее» (≤1 call per newly opened title) and
  // watch-page credits backfill, which is exactly why it is no longer 60 — a few
  // evenings of browsing new titles must not silently switch the row off.
  const DAILY_FETCH_CAP = 220;
  const FETCH_CONCURRENCY = 3;
  const ROW_SIZE = 18;
  const MIN_ROW = 6;
  const MAX_PER_SEED = 5;
  const RECOMPUTE_MIN_MS = 60e3;

  // «Похожее» (under the player)
  const SIMILAR_ROW_SIZE = 14;
  const SIMILAR_MIN_ROW = 4;
  // How hard the viewer's taste is allowed to re-order the title's own similars.
  // The row must stay recognisably about the title being watched, so affinity
  // re-ranks within that list instead of replacing it.
  const SIMILAR_TASTE_WEIGHT = 1.1;

  const state = {
    mode: null,          // null until catalog.js delivers the envelope flag
    items: [],
    computing: false,
    queued: false,
    lastFingerprint: "",
    lastComputeAt: 0,
  };

  function log(...args) {
    try {
      if (localStorage.getItem("alphy.debug")) console.log("[foryou]", ...args);
    } catch { /* ignore */ }
  }

  // `mode` arrives from catalog.js once the curated envelope is loaded. The watch
  // page can ask for recommendations before that lands (deep link straight into a
  // player), so callers wait briefly instead of silently getting an empty row.
  // Timing out means the catalog is unreachable — stay off rather than guess.
  let resolveModeReady;
  const modeReady = new Promise((resolve) => { resolveModeReady = resolve; });

  function whenModeReady(timeoutMs = 4000) {
    if (state.mode) return Promise.resolve(state.mode);
    return Promise.race([
      modeReady,
      new Promise((resolve) => setTimeout(() => resolve(state.mode), timeoutMs)),
    ]);
  }

  // --- localStorage helpers (own namespaces, TTL envelopes like app.js) ---

  function lsGet(key) {
    try {
      const raw = localStorage.getItem(key);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (parsed?.exp && Date.now() > parsed.exp) {
        localStorage.removeItem(key);
        return null;
      }
      return parsed?.v ?? null;
    } catch {
      return null;
    }
  }

  function lsSet(key, value, ttlMs) {
    const payload = JSON.stringify({ v: value, exp: ttlMs ? Date.now() + ttlMs : 0 });
    try {
      localStorage.setItem(key, payload);
    } catch {
      evictOwnCaches();
      try { localStorage.setItem(key, payload); } catch { /* give up */ }
    }
  }

  // On quota pressure drop our own cache entries, oldest expiry first — never
  // touch the app's history/bookmarks/meta storage.
  function evictOwnCaches() {
    const own = [];
    try {
      for (let i = 0; i < localStorage.length; i += 1) {
        const key = localStorage.key(i) || "";
        if (key.startsWith(SIM_PREFIX) || key.startsWith(META_PREFIX) || key.startsWith(LOOKUP_PREFIX)) {
          let exp = 0;
          try { exp = JSON.parse(localStorage.getItem(key) || "{}").exp || 0; } catch { /* oldest */ }
          own.push({ key, exp });
        }
      }
      own.sort((a, b) => a.exp - b.exp);
      own.slice(0, Math.max(8, Math.ceil(own.length / 3))).forEach((entry) => {
        localStorage.removeItem(entry.key);
      });
    } catch { /* ignore */ }
  }

  function loadStore(key) {
    try {
      const value = JSON.parse(localStorage.getItem(key) || "[]");
      return Array.isArray(value) ? value : [];
    } catch {
      return [];
    }
  }

  // --- dismissed recommendations -----------------------------------------
  // A hidden title is only removed from the row and never suggested again.
  // It is NOT a negative taste signal: hiding one gross body horror must not
  // stop the engine from recommending body horror — the seeds stay untouched.

  function hiddenIds() {
    return new Set(loadStore(HIDDEN_KEY).map((entry) => String(entry?.id ?? entry)));
  }

  function hide(kpId) {
    const id = String(kpId || "");
    if (!/^\d+$/.test(id)) return;
    const list = loadStore(HIDDEN_KEY);
    if (!list.some((entry) => String(entry?.id ?? entry) === id)) list.push({ id, at: Date.now() });
    try { localStorage.setItem(HIDDEN_KEY, JSON.stringify(list.slice(-HIDDEN_CAP))); } catch { /* ignore */ }
    state.items = state.items.filter((item) => String(item?.target?.kpId || "") !== id);
    try { localStorage.setItem(LAST_KEY, JSON.stringify({ items: state.items, at: Date.now() })); } catch { /* ignore */ }
    window.dispatchEvent(new CustomEvent("alphy:foryou"));
    // Backfill the freed slot: similars are cached, so this is (near) zero-network.
    compute();
  }

  // --- daily fetch budget ------------------------------------------------

  function quotaKey() {
    return `${QUOTA_PREFIX}${new Date().toISOString().slice(0, 10)}`;
  }

  function fetchesToday() {
    try { return Number(localStorage.getItem(quotaKey())) || 0; } catch { return 0; }
  }

  function countFetch() {
    try {
      const key = quotaKey();
      localStorage.setItem(key, String(fetchesToday() + 1));
      // Opportunistically drop yesterday's counters.
      for (let i = localStorage.length - 1; i >= 0; i -= 1) {
        const other = localStorage.key(i) || "";
        if (other.startsWith(QUOTA_PREFIX) && other !== key) localStorage.removeItem(other);
      }
    } catch { /* ignore */ }
  }

  function budgetLeft() {
    return DAILY_FETCH_CAP - fetchesToday();
  }

  // --- API access with key rotation ---------------------------------------

  function keyCursor() {
    try { return Number(localStorage.getItem(KEY_CURSOR_KEY)) || 0; } catch { return 0; }
  }

  function setKeyCursor(index) {
    try { localStorage.setItem(KEY_CURSOR_KEY, String(index)); } catch { /* ignore */ }
  }

  async function apiGet(path) {
    if (budgetLeft() <= 0) {
      const error = new Error("foryou daily budget exhausted");
      error.code = "budget";
      throw error;
    }
    const start = keyCursor();
    let lastError = null;
    for (let i = 0; i < API_KEYS.length; i += 1) {
      const index = (start + i) % API_KEYS.length;
      let response;
      try {
        response = await fetch(`${API_BASE}${path}`, {
          headers: { "X-API-KEY": API_KEYS[index], Accept: "application/json" },
          referrerPolicy: "no-referrer",
        });
      } catch (error) {
        lastError = error;
        continue;
      }
      countFetch();
      // 403 is how kinopoiskapiunofficial reports a DEACTIVATED account
      // ("User <mail> is inactive or deleted") — not a malformed request. It was
      // missing here, so one dead key threw instead of rotating and took the
      // whole feature down while the other keys were fine. These are free
      // accounts; they do get purged, so rotation has to cover it.
      if ([401, 402, 403, 429].includes(response.status)) {
        lastError = new Error(`foryou key ${index} rejected: ${response.status}`);
        continue; // rotate to the next key
      }
      if (response.status === 404) return null;
      if (!response.ok) throw new Error(`foryou API ${response.status}`);
      setKeyCursor(index);
      return response.json();
    }
    throw lastError || new Error("foryou: all keys exhausted");
  }

  // --- seeds ---------------------------------------------------------------

  function normTitle(value) {
    return String(value || "")
      .toLocaleLowerCase("ru-RU")
      .replace(/[ёе]/g, "е")
      .replace(/[^a-zа-я0-9]+/gi, " ")
      .trim();
  }

  function recencyWeight(timestamp, halfLifeDays) {
    if (!timestamp) return 0.3;
    const ageDays = Math.max(0, (Date.now() - timestamp) / 86400e3);
    return Math.max(0.15, Math.pow(0.5, ageDays / halfLifeDays));
  }

  function engagementWeight(entry) {
    const progress = Number(entry.progress) || 0;
    if (progress >= 0.85) return 1;
    if (progress >= 0.4) return 0.85;
    if (progress >= 0.08) return 0.6;
    return 0.4;
  }

  function entryKpId(entry) {
    if (/^\d+$/.test(String(entry?.kpId || ""))) return String(entry.kpId);
    const target = entry?.target;
    if ((target?.kind === "kp" || target?.kind === "clps") && /^\d+$/.test(String(target?.kpId || ""))) {
      return String(target.kpId);
    }
    return "";
  }

  // Builds weighted seeds plus the exclusion sets (everything the user already
  // watched or bookmarked must never be recommended back).
  function buildSeeds() {
    const history = loadStore("alphy.history");
    const bookmarks = loadStore("alphy.bookmarks");
    const bookmarkKeys = new Set(bookmarks.map((b) => b.key));

    const excludeKp = new Set();
    const excludeTitles = new Set();
    const byKp = new Map();
    const unresolved = [];

    const consider = (entry, weight) => {
      const title = normTitle(entry.title);
      if (title) excludeTitles.add(title);
      const kpId = entryKpId(entry);
      if (!kpId) {
        if (entry.title) unresolved.push({ entry, weight });
        return;
      }
      excludeKp.add(kpId);
      const existing = byKp.get(kpId);
      if (!existing || existing.weight < weight) {
        byKp.set(kpId, { kpId, weight, title: entry.title || "" });
      }
    };

    for (const entry of history) {
      let weight = recencyWeight(entry.updatedAt, 45) * engagementWeight(entry);
      if (bookmarkKeys.has(entry.key)) weight *= 1.15;
      consider(entry, weight);
    }
    const historyKeys = new Set(history.map((h) => h.key));
    for (const entry of bookmarks) {
      if (historyKeys.has(entry.key)) continue;
      consider(entry, 0.5 * recencyWeight(entry.addedAt, 90));
    }

    const seeds = [...byKp.values()].sort((a, b) => b.weight - a.weight).slice(0, MAX_SEEDS);
    unresolved.sort((a, b) => b.weight - a.weight);
    return { seeds, unresolved, excludeKp, excludeTitles };
  }

  // --- kpId backfill for zen/nd history entries ----------------------------
  // Curated (zen) and newdeaf plays store no kpId. Resolve it once by title
  // through the SAME dedicated key pool, verify by normalized title + year,
  // then write it back into the stored entry so it never costs again.

  async function lookupKpId(title, year) {
    const cacheKey = `${LOOKUP_PREFIX}${normTitle(title)}|${year || ""}`;
    const cached = lsGet(cacheKey);
    if (cached != null) return cached || "";
    let found = "";
    try {
      const data = await apiGet(`/api/v2.1/films/search-by-keyword?keyword=${encodeURIComponent(title)}&page=1`);
      const films = Array.isArray(data?.films) ? data.films : [];
      const wanted = normTitle(title);
      const wantedYear = Number(String(year || "").slice(0, 4)) || 0;
      for (const film of films) {
        const names = [film.nameRu, film.nameEn].map(normTitle).filter(Boolean);
        if (!names.includes(wanted)) continue;
        const filmYear = Number(String(film.year || "").match(/\d{4}/)?.[0]) || 0;
        if (wantedYear && filmYear && Math.abs(wantedYear - filmYear) > 1) continue;
        const kpId = String(film.filmId || film.kinopoiskId || "");
        if (/^\d+$/.test(kpId)) { found = kpId; break; }
      }
    } catch (error) {
      if (error.code === "budget") throw error;
      log("lookup failed", title, error.message);
      lsSet(cacheKey, "", NEGATIVE_TTL);
      return "";
    }
    lsSet(cacheKey, found, found ? LOOKUP_TTL : NEGATIVE_TTL);
    return found;
  }

  function persistKpId(entryKey, kpId) {
    for (const storeKey of ["alphy.history", "alphy.bookmarks"]) {
      try {
        const list = loadStore(storeKey);
        const entry = list.find((item) => item.key === entryKey);
        if (entry && !entry.kpId) {
          entry.kpId = kpId;
          localStorage.setItem(storeKey, JSON.stringify(list));
        }
      } catch { /* ignore */ }
    }
  }

  // --- similars + candidate meta -------------------------------------------

  async function fetchSimilars(kpId) {
    const cached = lsGet(`${SIM_PREFIX}${kpId}`);
    if (cached) return cached;
    let items = [];
    try {
      const data = await apiGet(`/api/v2.2/films/${encodeURIComponent(kpId)}/similars`);
      items = (Array.isArray(data?.items) ? data.items : [])
        .filter((item) => /^\d+$/.test(String(item?.filmId || "")))
        .slice(0, 24)
        .map((item) => ({
          id: String(item.filmId),
          ru: item.nameRu || item.nameOriginal || item.nameEn || "",
          orig: item.nameOriginal || item.nameEn || "",
          poster: item.posterUrl || item.posterUrlPreview || "",
        }));
    } catch (error) {
      if (error.code === "budget") throw error;
      log("similars failed", kpId, error.message);
      lsSet(`${SIM_PREFIX}${kpId}`, [], NEGATIVE_TTL);
      return [];
    }
    // Films with no similars are cached too — a stable, cheap negative.
    lsSet(`${SIM_PREFIX}${kpId}`, items, items.length ? SIM_TTL : SIM_TTL / 2);
    return items;
  }

  function appMetaFor(kpId) {
    // The app's own meta cache (populated by search/watch flows) is free —
    // use it even when expired, display data does not go stale in a week.
    try {
      const raw = localStorage.getItem(`alphy.cache.meta:${kpId}`);
      if (!raw) return null;
      return JSON.parse(raw)?.v || null;
    } catch {
      return null;
    }
  }

  function normalizeFilmMeta(film) {
    const year = Number(String(film?.year ?? "").match(/\d{4}/)?.[0]) || null;
    const rating = {};
    if (Number.isFinite(Number(film?.ratingKinopoisk))) rating.kp = Number(film.ratingKinopoisk);
    if (Number.isFinite(Number(film?.ratingImdb))) rating.imdb = Number(film.ratingImdb);
    return {
      year: year ? String(year) : "",
      isSeries: !!film?.serial || /SERIES|TV_SHOW|MINI/i.test(String(film?.type || "")),
      movieLength: typeof film?.filmLength === "number" ? film.filmLength : null,
      rating,
      poster: film?.posterUrl || film?.posterUrlPreview || "",
    };
  }

  async function fetchMeta(kpId) {
    const own = lsGet(`${META_PREFIX}${kpId}`);
    if (own) return own;
    try {
      const film = await apiGet(`/api/v2.2/films/${encodeURIComponent(kpId)}`);
      if (!film) return null;
      const meta = normalizeFilmMeta(film);
      lsSet(`${META_PREFIX}${kpId}`, meta, META_TTL);
      return meta;
    } catch (error) {
      if (error.code === "budget") throw error;
      log("meta failed", kpId, error.message);
      return null;
    }
  }

  async function promisePool(jobs, size) {
    const queue = [...jobs];
    const workers = Array.from({ length: Math.min(size, queue.length) }, async () => {
      while (queue.length) {
        const job = queue.shift();
        await job();
      }
    });
    await Promise.all(workers);
  }

  // --- scoring ---------------------------------------------------------------
  // Every seed "votes" for its similars. A vote is worth
  //   seedWeight × 1/(1 + rank×0.12)
  // and candidates named by several seeds get a superlinear intersection boost —
  // that is what turns 10 individual lists into taste-of-the-whole-history.
  function scoreCandidates(seedSimilars, excludeKp, excludeTitles) {
    const candidates = new Map();
    for (const { seed, similars } of seedSimilars) {
      similars.forEach((candidate, index) => {
        if (excludeKp.has(candidate.id)) return;
        if (excludeTitles.has(normTitle(candidate.ru))) return;
        const contribution = seed.weight / (1 + index * 0.12);
        let entry = candidates.get(candidate.id);
        if (!entry) {
          entry = { ...candidate, score: 0, hits: 0, primarySeed: seed.kpId, primaryContribution: 0 };
          candidates.set(candidate.id, entry);
        }
        entry.score += contribution;
        entry.hits += 1;
        if (contribution > entry.primaryContribution) {
          entry.primaryContribution = contribution;
          entry.primarySeed = seed.kpId;
        }
      });
    }
    const ranked = [...candidates.values()]
      .map((entry) => ({ ...entry, final: entry.score * (1 + 0.25 * (entry.hits - 1)) }))
      .sort((a, b) => b.final - a.final);

    // Diversity guard: one hot seed must not own the whole row.
    const perSeed = new Map();
    const picked = [];
    for (const entry of ranked) {
      const used = perSeed.get(entry.primarySeed) || 0;
      if (used >= MAX_PER_SEED) continue;
      perSeed.set(entry.primarySeed, used + 1);
      picked.push(entry);
      if (picked.length >= ROW_SIZE) break;
    }
    return picked;
  }

  function toCuratedItem(candidate, meta) {
    return {
      id: `fy-${candidate.id}`,
      key: `kp:${candidate.id}`,
      title: candidate.ru || candidate.orig || `KP ${candidate.id}`,
      year: meta?.year ? String(meta.year) : "",
      poster: meta?.poster || candidate.poster || "",
      isSeries: !!meta?.isSeries,
      movieLength: Number.isFinite(Number(meta?.movieLength)) ? Number(meta.movieLength) : null,
      rating: meta?.rating || {},
      target: { kind: "kp", kpId: candidate.id },
    };
  }

  // --- pipeline ---------------------------------------------------------------

  function fingerprint(seeds) {
    return seeds.map((seed) => `${seed.kpId}:${seed.weight.toFixed(2)}`).join(",");
  }

  function publish(items) {
    state.items = items.length >= MIN_ROW ? items : [];
    try {
      localStorage.setItem(LAST_KEY, JSON.stringify({ items: state.items, at: Date.now() }));
    } catch { /* ignore */ }
    window.dispatchEvent(new CustomEvent("alphy:foryou"));
  }

  async function compute() {
    if (state.mode !== "on" && state.mode !== "frozen") return;
    if (state.computing) {
      state.queued = true;
      return;
    }
    state.computing = true;
    const network = state.mode === "on";
    try {
      const { seeds, unresolved, excludeKp, excludeTitles } = buildSeeds();
      for (const id of hiddenIds()) excludeKp.add(id);

      // Backfill kpIds for a few title-only entries (zen/newdeaf plays).
      if (network && seeds.length < MAX_SEEDS && unresolved.length) {
        let lookups = 0;
        for (const { entry, weight } of unresolved) {
          if (lookups >= MAX_LOOKUP_PER_RUN || seeds.length >= MAX_SEEDS) break;
          const cached = lsGet(`${LOOKUP_PREFIX}${normTitle(entry.title)}|${entry.year || ""}`);
          if (cached === null) lookups += 1; // a real network lookup
          const kpId = await lookupKpId(entry.title, entry.year).catch(() => "");
          if (!kpId) continue;
          persistKpId(entry.key, kpId);
          excludeKp.add(kpId);
          if (!seeds.some((seed) => seed.kpId === kpId)) {
            seeds.push({ kpId, weight, title: entry.title });
          }
        }
        seeds.sort((a, b) => b.weight - a.weight);
      }

      state.lastFingerprint = fingerprint(seeds);
      state.lastComputeAt = Date.now();
      if (!seeds.length) {
        publish([]);
        return;
      }

      // Similars: cache first, then budgeted fetches for the heaviest seeds.
      const seedSimilars = [];
      const missing = [];
      for (const seed of seeds) {
        const cached = lsGet(`${SIM_PREFIX}${seed.kpId}`);
        if (cached) seedSimilars.push({ seed, similars: cached });
        else missing.push(seed);
      }
      if (network && missing.length) {
        const jobs = missing.slice(0, MAX_SIM_FETCH_PER_RUN).map((seed) => async () => {
          const similars = await fetchSimilars(seed.kpId).catch(() => []);
          if (similars.length) seedSimilars.push({ seed, similars });
        });
        await promisePool(jobs, FETCH_CONCURRENCY);
      }
      if (!seedSimilars.length) {
        publish([]);
        return;
      }

      const picked = scoreCandidates(seedSimilars, excludeKp, excludeTitles);

      // First paint with whatever meta is already local (app cache / own cache).
      const metaFor = new Map();
      for (const candidate of picked) {
        const local = lsGet(`${META_PREFIX}${candidate.id}`) || appMetaFor(candidate.id);
        if (local) metaFor.set(candidate.id, local);
      }
      publish(picked.map((candidate) => toCuratedItem(candidate, metaFor.get(candidate.id))));

      // Then enrich the gaps (year/type/ratings) within budget and re-publish.
      if (network) {
        const gaps = picked.filter((candidate) => !metaFor.has(candidate.id)).slice(0, MAX_META_FETCH_PER_RUN);
        if (gaps.length) {
          const jobs = gaps.map((candidate) => async () => {
            const meta = await fetchMeta(candidate.id).catch(() => null);
            if (meta) metaFor.set(candidate.id, meta);
          });
          await promisePool(jobs, FETCH_CONCURRENCY);
          publish(picked.map((candidate) => toCuratedItem(candidate, metaFor.get(candidate.id))));
        }
      }
      log("computed", { seeds: seeds.length, items: state.items.length, fetchesToday: fetchesToday() });
    } catch (error) {
      log("compute failed", error.message);
    } finally {
      state.computing = false;
      if (state.queued) {
        state.queued = false;
        compute();
      }
    }
  }

  function maybeCompute() {
    if (state.mode !== "on" && state.mode !== "frozen") return;
    const { seeds } = buildSeeds();
    const changed = fingerprint(seeds) !== state.lastFingerprint;
    if (!changed && Date.now() - state.lastComputeAt < RECOMPUTE_MIN_MS) return;
    if (!changed && state.items.length) return;
    compute();
  }

  // --- descriptive extras (жанр / страна / возраст / режиссёр / актёры) -------
  //
  // The resolver's /movie already carries all of this for kp: titles, so this is
  // only the backfill for targets that have no kinopoisk.dev document behind them
  // (zen:, ort:, nd: …). Cached for 30 days: a film's director does not change.
  // Two calls at most, once per title, ever.

  const EXTRAS_PREFIX = "alphy.foryou.extras.";

  function personNames(staff, professionKey, limit) {
    const out = [];
    for (const person of Array.isArray(staff) ? staff : []) {
      if (String(person?.professionKey || "") !== professionKey) continue;
      const name = String(person?.nameRu || person?.nameEn || "").trim();
      if (name && !out.includes(name)) out.push(name);
      if (out.length >= limit) break;
    }
    return out;
  }

  async function filmExtras(kpId, { network = true } = {}) {
    const id = String(kpId || "");
    if (!/^\d+$/.test(id)) return null;
    const cacheKey = `${EXTRAS_PREFIX}${id}`;
    const cached = lsGet(cacheKey);
    if (cached) return cached;
    if (!network) return null;
    if (await whenModeReady() !== "on") return null;
    try {
      const [film, staff] = await Promise.all([
        apiGet(`/api/v2.2/films/${encodeURIComponent(id)}`).catch(() => null),
        apiGet(`/api/v1/staff?filmId=${encodeURIComponent(id)}`).catch(() => null),
      ]);
      if (!film && !staff) return null;
      const extras = {
        genres: (film?.genres || []).map((g) => g?.genre).filter(Boolean).slice(0, 6),
        countries: (film?.countries || []).map((c) => c?.country).filter(Boolean).slice(0, 4),
        ageRating: Number(String(film?.ratingAgeLimits || "").match(/\d+/)?.[0]) || null,
        ratingMpaa: film?.ratingMpaa || null,
        slogan: film?.slogan || null,
        directors: personNames(staff, "DIRECTOR", 3),
        cast: personNames(staff, "ACTOR", 8),
      };
      lsSet(cacheKey, extras, META_TTL);
      return extras;
    } catch (error) {
      log("extras failed", id, error.message);
      return null;
    }
  }

  // --- «Похожее» -------------------------------------------------------------
  //
  // Same engine, different question. «Для вас» asks "what fits this viewer?";
  // «Похожее» asks "what fits THIS title, for this viewer?". The candidate pool is
  // therefore always the current title's own similars, so the row stays honestly
  // about what is on screen — the taste graph only re-orders it.
  //
  // Cost, by construction:
  //   • the pool is one /similars call, cached 30 days, in the SAME namespace
  //     «Для вас» uses — so opening a title either costs nothing (already known)
  //     or costs one call that also improves the homepage row later;
  //   • the affinity signal reads only ALREADY-CACHED seed similars, never
  //     fetches;
  //   • posters/titles come from the similars payload itself, so there is no
  //     per-candidate metadata fan-out. Year/rating are filled in from caches the
  //     app already has, and simply left out when unknown.
  // A cold title costs exactly one request. Nothing here fans out.

  // Affinity = "how connected is this candidate to what the viewer already
  // likes", computed purely from cached seed→similars edges. Zero network.
  function affinityIndex(excludeSeedId) {
    const { seeds } = buildSeeds();
    const affinity = new Map();
    let max = 0;
    for (const seed of seeds) {
      if (String(seed.kpId) === String(excludeSeedId)) continue;
      const similars = lsGet(`${SIM_PREFIX}${seed.kpId}`);
      if (!Array.isArray(similars) || !similars.length) continue;
      similars.forEach((candidate, index) => {
        const contribution = seed.weight / (1 + index * 0.12);
        const next = (affinity.get(candidate.id) || 0) + contribution;
        affinity.set(candidate.id, next);
        if (next > max) max = next;
      });
    }
    return { affinity, max };
  }

  function rankSimilars(base, kpId) {
    const { excludeKp, excludeTitles } = buildSeeds();
    const hidden = hiddenIds();
    const { affinity, max } = affinityIndex(kpId);

    return base
      .filter((candidate) => {
        if (String(candidate.id) === String(kpId)) return false;
        if (hidden.has(String(candidate.id))) return false;
        // Already watched or bookmarked: recommending it back is the single most
        // "forced" thing this row could do.
        if (excludeKp.has(String(candidate.id))) return false;
        return !excludeTitles.has(normTitle(candidate.ru));
      })
      .map((candidate, index) => {
        // Kinopoisk's own ordering is a real relevance signal, so it sets the
        // baseline; taste multiplies it rather than overriding it.
        const positional = 1 / (1 + index * 0.10);
        const taste = max > 0 ? (affinity.get(candidate.id) || 0) / max : 0;
        return { ...candidate, score: positional * (1 + SIMILAR_TASTE_WEIGHT * taste), taste };
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, SIMILAR_ROW_SIZE);
  }

  // Returns curated-shaped items for the watch page, or [] when there is nothing
  // worth showing. `network: false` keeps it strictly cache-only.
  async function similarRow(kpId, { network = true } = {}) {
    const id = String(kpId || "");
    if (!/^\d+$/.test(id)) return [];
    const cached = lsGet(`${SIM_PREFIX}${id}`);
    let base = Array.isArray(cached) ? cached : null;
    if (!base) {
      if (!network) return [];
      if (await whenModeReady() !== "on") return [];
      base = await fetchSimilars(id).catch(() => []);
    } else if (state.mode === "off") {
      return [];
    }
    if (!base.length) return [];
    const picked = rankSimilars(base, id);
    if (picked.length < SIMILAR_MIN_ROW) return [];
    // Metadata is best-effort and free: whatever the app or our own cache already
    // knows. A missing year or rating just renders as absent.
    return picked.map((candidate) =>
      toCuratedItem(candidate, lsGet(`${META_PREFIX}${candidate.id}`) || appMetaFor(candidate.id)));
  }

  // --- public surface -----------------------------------------------------

  function setMode(mode) {
    const next = mode === "frozen" || mode === "off" ? mode : "on";
    resolveModeReady(next);
    if (state.mode === next) return;
    state.mode = next;
    if (next === "off") {
      state.items = [];
      window.dispatchEvent(new CustomEvent("alphy:foryou"));
      return;
    }
    compute();
  }

  // Instant paint on load: yesterday's row is still a good row.
  try {
    const last = JSON.parse(localStorage.getItem(LAST_KEY) || "null");
    if (Array.isArray(last?.items)) state.items = last.items;
  } catch { /* ignore */ }

  window.addEventListener("alphy:view", (event) => {
    if (event.detail?.view === "home") maybeCompute();
  });

  window.alphyForYou = {
    setMode,
    getMode: () => state.mode,
    getItems: () => {
      if (state.mode === "off") return [];
      const hidden = hiddenIds();
      return hidden.size
        ? state.items.filter((item) => !hidden.has(String(item?.target?.kpId || "")))
        : state.items;
    },
    hide,
    refresh: () => compute(),
    similarRow,
    filmExtras,
    // Title -> kpId, verified by normalized title + year and cached for 30 days.
    // Curated zen:/ort: targets carry no Kinopoisk id, and without one there are
    // no similars and no credits for them. One lookup unlocks both, and the same
    // answer later seeds «Для вас».
    resolveKpId: async (title, year) => {
      if (!title) return "";
      if (await whenModeReady() !== "on") return "";
      return lookupKpId(title, year).catch(() => "");
    },
    budgetLeft,
    _test: {
      buildSeeds, scoreCandidates, normTitle, recencyWeight, engagementWeight,
      toCuratedItem, hiddenIds, rankSimilars, affinityIndex, personNames,
    },
  };
})();
