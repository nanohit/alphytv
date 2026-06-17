(() => {
  "use strict";

  // =====================================================================
  // AlphyTV — static client. The browser does everything except the two
  // things it can't: PoiskKino (token must stay server-side) and the Zona
  // kpId->Zenith resolve (needs a trusted non-RU egress IP). Both live on the
  // Deno resolver. newdeaf is scraped from THIS browser (per-user IP), never
  // from a server, so newdeaf only ever sees organic-looking residential RU
  // traffic. Everything resolved is cached in localStorage so a returning
  // user re-opening a title hits neither Deno nor newdeaf again.
  // =====================================================================

  const STORE_RESOLVER = "alphy.resolverBaseUrl";
  const STORE_BOOKMARKS = "alphy.bookmarks";
  const STORE_HISTORY = "alphy.history";
  const CACHE_PREFIX = "alphy.cache.";
  const TTL = {
    search: 6 * 3600e3,
    ndsearch: 6 * 3600e3,
    ndpage: 24 * 3600e3,
    zona: 24 * 3600e3,
    meta: 7 * 24 * 3600e3,
  };

  const params = new URLSearchParams(location.search);
  const DEBUG = params.has("debug");
  const isLocal = /^(127\.0\.0\.1|localhost)$/i.test(location.hostname);

  const el = {
    logoBtn: document.getElementById("logoBtn"),
    searchInput: document.getElementById("searchInput"),
    searchBtn: document.getElementById("searchBtn"),
    settingsToggle: document.getElementById("settingsToggle"),
    settingsPanel: document.getElementById("settingsPanel"),
    resolverInput: document.getElementById("resolverInput"),
    saveResolverBtn: document.getElementById("saveResolverBtn"),
    healthBtn: document.getElementById("healthBtn"),
    resolverState: document.getElementById("resolverState"),
    homeView: document.getElementById("homeView"),
    continueSection: document.getElementById("continueSection"),
    continueHeader: document.getElementById("continueHeader"),
    continueGrid: document.getElementById("continueGrid"),
    bookmarksSection: document.getElementById("bookmarksSection"),
    bookmarksGrid: document.getElementById("bookmarksGrid"),
    homeEmpty: document.getElementById("homeEmpty"),
    searchView: document.getElementById("searchView"),
    resultsTitle: document.getElementById("resultsTitle"),
    resultsGrid: document.getElementById("resultsGrid"),
    watchView: document.getElementById("watchView"),
    backBtn: document.getElementById("backBtn"),
    watchTitle: document.getElementById("watchTitle"),
    bookmarkBtn: document.getElementById("bookmarkBtn"),
    playerHost: document.getElementById("playerHost"),
    trackPanel: document.getElementById("trackPanel"),
    metaPanel: document.getElementById("metaPanel"),
    loading: document.getElementById("loading"),
    error: document.getElementById("error"),
  };

  const state = {
    resolverBaseUrl: "",
    playerPlaceholder: "",
    player: null,
    videoEl: null,
    currentTarget: null,
    audioNames: [],
    sources: {},
    trackInterval: null,
  };

  // Monotonic token: every route bumps it; any async chain whose token is no
  // longer current bails before touching the player/UI (the "плеер не туда" bug).
  let resolveToken = 0;
  const nextToken = () => (resolveToken += 1);
  const isStale = (token) => token !== resolveToken;

  // =====================================================================
  // localStorage: TTL cache + bookmarks + history
  // =====================================================================
  function cacheGet(ns, key) {
    try {
      const raw = localStorage.getItem(`${CACHE_PREFIX}${ns}:${key}`);
      if (!raw) return null;
      const obj = JSON.parse(raw);
      if (obj.exp && Date.now() > obj.exp) {
        localStorage.removeItem(`${CACHE_PREFIX}${ns}:${key}`);
        return null;
      }
      return obj.v;
    } catch {
      return null;
    }
  }
  function cacheSet(ns, key, value, ttlMs) {
    try {
      localStorage.setItem(`${CACHE_PREFIX}${ns}:${key}`, JSON.stringify({ v: value, exp: ttlMs ? Date.now() + ttlMs : 0 }));
    } catch {
      /* quota — ignore */
    }
  }
  function loadList(storeKey) {
    try {
      const v = JSON.parse(localStorage.getItem(storeKey) || "[]");
      return Array.isArray(v) ? v : [];
    } catch {
      return [];
    }
  }
  function saveList(storeKey, value) {
    try {
      localStorage.setItem(storeKey, JSON.stringify(value));
    } catch {
      /* ignore */
    }
  }

  function keyFor(t) {
    if (!t) return "x";
    if (t.key) return t.key;
    if (t.kind === "kp") return `kp:${t.kpId}`;
    if (t.kind === "zen") return `zen:${t.zenithId}`;
    if (t.kind === "ort") return `ort:${t.embedUrl}`;
    if (t.kind === "nd") return `nd:${t.pageUrl}`;
    return "x";
  }
  function cleanTarget(t) {
    if (t.kind === "kp") return { kind: "kp", kpId: t.kpId };
    if (t.kind === "zen") return { kind: "zen", zenithId: t.zenithId };
    if (t.kind === "ort") return { kind: "ort", embedUrl: t.embedUrl };
    if (t.kind === "nd") return { kind: "nd", pageUrl: t.pageUrl };
    return t;
  }
  function hashFor(t) {
    if (t.kind === "kp") return `/watch/kp/${encodeURIComponent(t.kpId)}`;
    if (t.kind === "zen") return `/watch/zen/${encodeURIComponent(t.zenithId)}`;
    if (t.kind === "ort") return `/watch/ort/${encodeURIComponent(t.embedUrl)}`;
    if (t.kind === "nd") return `/watch/nd/${encodeURIComponent(t.pageUrl)}`;
    return "/";
  }

  function recordHistory(entry) {
    let hist = loadList(STORE_HISTORY);
    const i = hist.findIndex((h) => h.key === entry.key);
    const merged = { ...(i >= 0 ? hist[i] : {}), ...entry, updatedAt: Date.now() };
    if (i >= 0) hist[i] = merged;
    else hist.unshift(merged);
    hist.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    saveList(STORE_HISTORY, hist.slice(0, 30));
  }
  function recordOpen(target) {
    const key = keyFor(target);
    const existing = loadList(STORE_HISTORY).find((h) => h.key === key);
    recordHistory({
      key,
      kind: target.kind,
      target: cleanTarget(target),
      title: target.title || existing?.title || "",
      poster: target.poster || existing?.poster || "",
      year: target.year || existing?.year || "",
      position: existing?.position || 0,
      duration: existing?.duration || 0,
      progress: existing?.progress || 0,
    });
  }
  function resumePosition(key) {
    const e = loadList(STORE_HISTORY).find((h) => h.key === key);
    if (!e || !e.duration) return 0;
    if (e.progress >= 0.95) return 0;
    return e.position > 5 ? e.position : 0;
  }

  function isBookmarked(key) {
    return loadList(STORE_BOOKMARKS).some((b) => b.key === key);
  }
  function toggleBookmark(target) {
    const key = keyFor(target);
    let bms = loadList(STORE_BOOKMARKS);
    if (bms.some((b) => b.key === key)) {
      bms = bms.filter((b) => b.key !== key);
    } else {
      bms.unshift({
        key,
        kind: target.kind,
        target: cleanTarget(target),
        title: target.title || "",
        poster: target.poster || "",
        year: target.year || "",
        addedAt: Date.now(),
      });
    }
    saveList(STORE_BOOKMARKS, bms.slice(0, 100));
    updateBookmarkBtn(target);
  }
  function updateBookmarkBtn(target) {
    const on = isBookmarked(keyFor(target));
    el.bookmarkBtn.textContent = on ? "★ В закладках" : "☆ В закладки";
    el.bookmarkBtn.classList.toggle("on", on);
  }

  // =====================================================================
  // Resolver client
  // =====================================================================
  async function resolverJson(path, { retries = 2, timeoutMs = 15000 } = {}) {
    if (!state.resolverBaseUrl) throw new Error("Resolver URL не настроен");
    const url = `${state.resolverBaseUrl}${path}`;
    let lastError;
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetch(url, { cache: "no-store", credentials: "omit", signal: controller.signal });
        const text = await response.text();
        let data;
        try { data = JSON.parse(text); } catch { data = { ok: false, raw: text.slice(0, 500) }; }
        if (!response.ok || data.ok === false) {
          throw new Error(data.message || data.error || `Resolver ${response.status}`);
        }
        return data;
      } catch (error) {
        lastError = error;
        const aborted = error?.name === "AbortError";
        const transient = aborted || /NetworkError|Failed to fetch|load failed|terminated|network/i.test(String(error?.message || ""));
        if (!transient || attempt === retries) break;
        await new Promise((resolve) => setTimeout(resolve, 600 * (attempt + 1)));
      } finally {
        clearTimeout(timer);
      }
    }
    throw lastError || new Error("Resolver request failed");
  }

  // =====================================================================
  // Cached resolution layer (the request-minimization core)
  // =====================================================================
  async function searchPoiskkino(query, year) {
    const ckey = `${query}|${year || ""}`;
    const cached = cacheGet("search", ckey);
    if (cached) return cached;
    const path = `/search?q=${encodeURIComponent(query)}&limit=12${year ? `&year=${encodeURIComponent(year)}` : ""}`;
    const data = await resolverJson(path);
    const results = data.results || [];
    cacheSet("search", ckey, results, TTL.search);
    results.forEach((m) => m.kpId != null && cacheSet("meta", m.kpId, m, TTL.meta));
    return results;
  }

  async function fetchMovieMeta(kpId) {
    const cached = cacheGet("meta", kpId);
    if (cached) return cached;
    try {
      const data = await resolverJson(`/movie?id=${encodeURIComponent(kpId)}`);
      if (data.movie) {
        cacheSet("meta", kpId, data.movie, TTL.meta);
        return data.movie;
      }
    } catch (error) {
      log("meta-warn", error.message);
    }
    return null;
  }

  async function resolveZona(kpId) {
    const cached = cacheGet("zona", kpId);
    if (cached && cached.embedUrl) return cached;
    const data = await resolverJson(`/resolve-zona?kpId=${encodeURIComponent(kpId)}`);
    if (!data.embedUrl) throw new Error("Zona resolver не вернул Zenith embed");
    const value = { zenithId: data.zenithId, embedUrl: data.embedUrl };
    cacheSet("zona", kpId, value, TTL.zona);
    return value;
  }

  async function searchNewdeaf(query) {
    const cached = cacheGet("ndsearch", query);
    if (cached) return cached;
    const mirrors = dailyMirrorCandidates();
    for (const mirror of mirrors) {
      const searchUrl = `${mirror}/index.php?do=search&subaction=search&story=${encodeURIComponent(query)}`;
      try {
        // Direct CORS fetch — newdeaf returns `access-control-allow-origin: *`, so a
        // fetch from the real page origin works. The sandboxed iframe sends
        // `Origin: null`, which newdeaf rejects/hangs, so it must NOT be the only
        // path (it stays as the fallback). This is why newdeaf results were silently
        // empty before.
        const html = await fetchThirdPartyText(searchUrl, { preferSandbox: false, label: "newdeaf-search", timeoutMs: 12000 });
        const candidates = parseNewdeafSearch(html, searchUrl);
        if (candidates.length) {
          cacheSet("ndsearch", query, candidates, TTL.ndsearch);
          return candidates;
        }
      } catch (error) {
        log("newdeaf-warn", "mirror failed", { mirror, message: error.message });
      }
    }
    cacheSet("ndsearch", query, [], TTL.ndsearch);
    return [];
  }

  async function resolveNewdeafPage(pageUrl) {
    const cached = cacheGet("ndpage", pageUrl);
    if (cached) return cached;
    const candidates = pageUrlCandidates(pageUrl);
    let parsed = null;
    for (const candidate of candidates) {
      try {
        const html = await fetchThirdPartyText(candidate, { preferSandbox: false, label: "newdeaf-page" });
        parsed = parseNewdeafPage(html, candidate);
        if (parsed.ortified.length || parsed.allo.length) break;
      } catch (error) {
        log("newdeaf-warn", "page candidate failed", { candidate, message: error.message });
      }
    }
    if (!parsed) throw new Error("Не удалось загрузить страницу newdeaf");
    // Only persist a page that actually exposed a player; an empty parse may be
    // a transient mirror miss we don't want to pin for 24h.
    if (parsed.ortified.length || parsed.allo.length) cacheSet("ndpage", pageUrl, parsed, TTL.ndpage);
    return parsed;
  }

  // =====================================================================
  // Router (hash-based; the URL is the cache key + shareable + back-button)
  // =====================================================================
  function parseHash() {
    const h = location.hash.replace(/^#/, "");
    if (!h || h === "/") return { view: "home" };
    const segs = h.split("/").filter(Boolean);
    if (segs[0] === "search") return { view: "search", q: decodeURIComponent(segs.slice(1).join("/") || "") };
    if (segs[0] === "watch") return { view: "watch", kind: segs[1], raw: decodeURIComponent(segs.slice(2).join("/") || "") };
    return { view: "home" };
  }
  function go(hash) {
    if (`#${hash}` === location.hash) { route(); return; }
    location.hash = hash; // fires hashchange -> route()
  }
  function replaceHash(hash) {
    history.replaceState(null, "", `#${hash}`); // no hashchange, no history entry
  }

  async function route() {
    const r = parseHash();
    const token = nextToken();
    await teardownPlayer();
    hideError();
    el.settingsPanel.classList.add("hidden");
    try {
      if (r.view === "search") {
        await showSearch(r.q, token);
      } else if (r.view === "watch") {
        await showWatch(r, token);
      } else {
        showHome();
      }
    } catch (error) {
      if (!isStale(token)) showError(error);
    }
  }

  // =====================================================================
  // Views
  // =====================================================================
  function setView(name) {
    el.homeView.classList.toggle("hidden", name !== "home");
    el.searchView.classList.toggle("hidden", name !== "search");
    el.watchView.classList.toggle("hidden", name !== "watch");
  }

  function showHome() {
    setView("home");
    document.title = "alphy";
    el.searchInput.value = "";
    const hist = loadList(STORE_HISTORY);
    const bms = loadList(STORE_BOOKMARKS);
    renderHomeGrid(el.continueGrid, el.continueSection, hist, { withProgress: true, store: STORE_HISTORY });
    renderHomeGrid(el.bookmarksGrid, el.bookmarksSection, bms, { withProgress: false, store: STORE_BOOKMARKS });
    el.homeEmpty.classList.toggle("hidden", hist.length > 0 || bms.length > 0);
  }

  function renderHomeGrid(grid, section, entries, opts) {
    grid.replaceChildren();
    if (!entries.length) { section.classList.add("hidden"); return; }
    section.classList.remove("hidden");
    entries.slice(0, 20).forEach((entry) => {
      const card = makeCard({
        title: entry.title || "(без названия)",
        sub: entry.year ? String(entry.year) : "",
        poster: entry.poster,
        progress: opts.withProgress && entry.duration > 0 ? entry.progress || 0 : null,
        onClick: () => go(hashFor(entry.target)),
        onRemove: () => {
          const list = loadList(opts.store).filter((x) => x.key !== entry.key);
          saveList(opts.store, list);
          showHome();
        },
      });
      grid.appendChild(card);
    });
  }

  async function showSearch(query, token) {
    setView("search");
    document.title = `${query} — alphy`;
    el.searchInput.value = query;
    el.resultsTitle.textContent = "Поиск…";
    el.resultsGrid.replaceChildren();

    // PoiskKino first (fast, cached), render immediately; newdeaf merges after.
    let pk = [];
    try { pk = await searchPoiskkino(query); } catch (error) { log("poisk-error", error.message); }
    if (isStale(token)) return;
    renderResults([], pk, query);

    // newdeaf indexes Russian titles only. If the query has no Cyrillic, search
    // newdeaf with the Russian name from the top PoiskKino hit so English queries
    // ("Scavengers Reign") still surface the newdeaf pages ("Царство падальщиков").
    const ndQuery = pickNewdeafQuery(query, pk);
    let nd = [];
    try { nd = await searchNewdeaf(ndQuery); } catch (error) { log("newdeaf-error", error.message); }
    if (isStale(token)) return;
    renderResults(nd, pk, query);
    if (!pk.length && !nd.length) el.resultsTitle.textContent = "Ничего не найдено";
  }

  function pickNewdeafQuery(query, pkResults) {
    if (/[а-яё]/i.test(query)) return query;
    const ru = (pkResults || []).map((m) => m.name).find((name) => /[а-яё]/i.test(name || ""));
    return ru || query;
  }

  function renderResults(ndCandidates, pkResults, query) {
    el.resultsGrid.replaceChildren();
    el.resultsTitle.textContent = "Результаты";
    // newdeaf first and prioritized: when a title is in both sources, the ad-free
    // Ortified path (newdeaf, with the embedded season/episode player) is the
    // preferred choice, so it leads the grid — same ordering as the old MVP.
    for (const item of ndCandidates) {
      const card = makeCard({
        title: item.title || "Newdeaf",
        sub: "Newdeaf · субтитры",
        poster: item.poster,
        onClick: () => go(`/watch/nd/${encodeURIComponent(item.url)}`),
      });
      el.resultsGrid.appendChild(card);
    }
    for (const movie of pkResults) {
      if (movie.kpId == null) continue;
      const kp = movie.rating?.kp;
      const card = makeCard({
        title: movieTitle(movie),
        sub: [movie.year, movie.isSeries ? "сериал" : "фильм"].filter(Boolean).join(" · "),
        poster: movie.poster,
        ratingPill: kp ? Number(kp).toFixed(1) : "",
        onClick: () => go(`/watch/kp/${encodeURIComponent(movie.kpId)}`),
      });
      el.resultsGrid.appendChild(card);
    }
    if (!pkResults.length && !ndCandidates.length) {
      const p = document.createElement("p");
      p.className = "muted";
      p.textContent = `Ничего не найдено по «${query}».`;
      el.resultsGrid.appendChild(p);
    }
  }

  function makeCard({ title, sub, poster, ratingPill, progress, onClick, onRemove }) {
    const card = document.createElement("article");
    card.className = "card";
    if (poster) {
      const img = document.createElement("img");
      img.className = "poster";
      img.loading = "lazy";
      img.src = poster;
      img.alt = "";
      img.addEventListener("error", () => { img.replaceWith(blankPoster()); });
      card.appendChild(img);
    } else {
      card.appendChild(blankPoster());
    }
    if (ratingPill) {
      const pill = document.createElement("div");
      pill.className = "rating-pill";
      pill.textContent = ratingPill;
      card.appendChild(pill);
    }
    if (onRemove) {
      const x = document.createElement("button");
      x.className = "card-remove";
      x.type = "button";
      x.textContent = "×";
      x.addEventListener("click", (event) => { event.stopPropagation(); onRemove(); });
      card.appendChild(x);
    }
    const t = document.createElement("div");
    t.className = "ctitle";
    t.textContent = title;
    card.appendChild(t);
    if (sub) {
      const s = document.createElement("div");
      s.className = "cmeta";
      s.textContent = sub;
      card.appendChild(s);
    }
    if (progress != null) {
      const bar = document.createElement("div");
      bar.className = "progress";
      bar.innerHTML = `<div class="progress-bar" style="width:${Math.round(progress * 100)}%"></div>`;
      card.appendChild(bar);
    }
    card.addEventListener("click", onClick);
    return card;
  }
  function blankPoster() {
    const d = document.createElement("div");
    d.className = "poster";
    return d;
  }

  // =====================================================================
  // Watch dispatch
  // =====================================================================
  async function showWatch(r, token) {
    setView("watch");
    el.metaPanel.classList.add("hidden");
    el.trackPanel.classList.add("hidden");
    if (r.kind === "kp") return playKp(r.raw, token);
    if (r.kind === "zen") return playZen(r.raw, token);
    if (r.kind === "ort") return playOrt(r.raw, token, null);
    if (r.kind === "nd") return playNd(r.raw, token);
    throw new Error("Неизвестный тип контента");
  }

  async function playKp(kpId, token) {
    let meta = cacheGet("meta", kpId);
    if (!meta) { meta = await fetchMovieMeta(kpId); if (isStale(token)) return; }
    const target = { kind: "kp", kpId, title: movieTitle(meta), poster: meta?.poster, year: meta?.year };
    state.currentTarget = target;
    setWatchHead(target.title || `kpId ${kpId}`, target);
    renderMeta(meta, target);
    recordOpen(target);

    const resolved = await resolveZona(kpId);
    if (isStale(token)) return;
    await playZenithEmbed(resolved.embedUrl, target, token, { histKey: `kp:${kpId}`, resume: resumePosition(`kp:${kpId}`) });
  }

  async function playZen(zenithId, token) {
    const target = { kind: "zen", zenithId, title: `Zenith ${zenithId}` };
    state.currentTarget = target;
    setWatchHead(target.title, target);
    el.metaPanel.classList.add("hidden");
    recordOpen(target);
    const embedUrl = `https://api.zenithjs.ws/embed/movie/${encodeURIComponent(zenithId)}`;
    await playZenithEmbed(embedUrl, target, token, { histKey: `zen:${zenithId}`, resume: resumePosition(`zen:${zenithId}`) });
  }

  async function playOrt(embedUrl, token, ndMeta) {
    const target = { kind: "ort", embedUrl, title: ndMeta?.title, poster: ndMeta?.poster, year: ndMeta?.year };
    state.currentTarget = target;
    setWatchHead(target.title || "Ortified", target);
    if (ndMeta && (ndMeta.title || ndMeta.poster || ndMeta.description)) {
      renderMeta({ name: ndMeta.title, poster: ndMeta.poster, year: ndMeta.year, description: ndMeta.description }, target);
    } else {
      el.metaPanel.classList.add("hidden");
    }
    recordOpen(target);
    await playOrtifiedCleanroom(embedUrl, target, token);
  }

  async function playNd(pageUrl, token) {
    setWatchHead("Newdeaf…", { kind: "nd", pageUrl });
    const parsed = await resolveNewdeafPage(pageUrl);
    if (isStale(token)) return;
    const ndMeta = { title: parsed.title, poster: parsed.poster, year: parsed.year, description: parsed.description };

    if (parsed.ortified.length) {
      const embedUrl = parsed.ortified[0];
      // Upgrade the URL to the resolved Ortified target so this title never
      // touches newdeaf again (re-open / share / history all go direct).
      replaceHash(`/watch/ort/${encodeURIComponent(embedUrl)}`);
      return playOrt(embedUrl, token, ndMeta);
    }

    // Allo-only or no player → Zona fallback via title -> kpId, then upgrade URL.
    const title = cleanMovieTitle(parsed.title || "");
    if (!title) throw new Error("Newdeaf не дал ни Ortified, ни названия для Zona");
    const results = await searchPoiskkino(title, parsed.year);
    if (isStale(token)) return;
    const movie = chooseMovie(results, title, parsed.year);
    if (!movie) throw new Error("PoiskKino не вернул kpId для Zona fallback");
    cacheSet("meta", movie.kpId, movie, TTL.meta);
    replaceHash(`/watch/kp/${encodeURIComponent(movie.kpId)}`);
    return playKp(String(movie.kpId), token);
  }

  function setWatchHead(title, target) {
    el.watchTitle.textContent = title;
    document.title = `${title} — alphy`;
    updateBookmarkBtn(target);
  }

  function renderMeta(meta, target) {
    if (!meta) { el.metaPanel.classList.add("hidden"); el.metaPanel.replaceChildren(); return; }
    const title = movieTitle(meta) || target.title || "";
    const year = meta.year || target.year || "";
    const poster = meta.poster || target.poster || "";
    const kp = meta.rating?.kp;
    const imdb = meta.rating?.imdb;
    const desc = meta.description || meta.shortDescription || "";
    const sub = [year, meta.movieLength ? `${meta.movieLength} мин` : ""].filter(Boolean).join(" · ");
    let html = "";
    if (poster) html += `<img src="${escapeAttr(poster)}" alt="">`;
    html += `<div class="mp-title">${escapeHtml(title)}</div>`;
    if (sub) html += `<div class="mp-sub">${escapeHtml(sub)}</div>`;
    if (kp || imdb) {
      html += `<div class="meta-ratings">`;
      if (kp) html += `<div class="rt"><b>${escapeHtml(Number(kp).toFixed(1))}</b><span>Кинопоиск</span></div>`;
      if (imdb) html += `<div class="rt"><b>${escapeHtml(Number(imdb).toFixed(1))}</b><span>IMDb</span></div>`;
      html += `</div>`;
    }
    if (desc) html += `<div class="meta-desc">${escapeHtml(desc)}</div>`;
    el.metaPanel.innerHTML = html;
    el.metaPanel.classList.remove("hidden");
  }

  // =====================================================================
  // Playback — Ortified cleanroom iframe
  // =====================================================================
  async function playOrtifiedCleanroom(embedUrl, target, token) {
    if (isStale(token)) return;
    showPlayerLoading();
    const html = await fetchThirdPartyText(embedUrl, { preferSandbox: true, label: "ortified" });
    if (isStale(token)) return;
    const sanitized = sanitizeOrtifiedHtml(html, embedUrl, "cleanroom-block");
    if (!sanitized.stats.ok) throw new Error("В Ortified HTML нет makePlayer");
    const iframe = document.createElement("iframe");
    iframe.allow = "autoplay; fullscreen; encrypted-media; picture-in-picture";
    iframe.allowFullscreen = true;
    iframe.referrerPolicy = "no-referrer";
    iframe.srcdoc = sanitized.html;
    el.playerHost.replaceChildren(iframe);
    el.trackPanel.classList.add("hidden");
    log("ortified", "cleanroom loaded", sanitized.stats);
  }

  // =====================================================================
  // Playback — Zenith via Shaka
  // =====================================================================
  async function playZenithEmbed(embedUrl, target, token, opts = {}) {
    if (isStale(token)) return;
    showPlayerLoading();
    const html = await fetchThirdPartyText(embedUrl, { preferSandbox: false, label: "zenith" });
    if (isStale(token)) return;
    let parsed = parseZenithEmbed(html);
    if (!parsed.sources.dash && !parsed.sources.hls && !parsed.sources.dasha) {
      parsed = await resolveZenithThroughWorker(embedUrl);
      if (isStale(token)) return;
    }
    state.sources = parsed.sources;
    state.audioNames = parsed.meta.audioNames || [];
    const bestUrl = parsed.sources.dash || parsed.sources.hls || parsed.sources.dasha;
    const kind = parsed.sources.dash ? "dash" : parsed.sources.hls ? "hls" : "dasha";
    if (!bestUrl) throw new Error("Zenith embed не отдал dash/hls");
    await playShaka(bestUrl, kind, token, opts.resume || 0);
    if (isStale(token)) return;
    if (opts.histKey) startTracking(opts.histKey, target);
  }

  async function resolveZenithThroughWorker(embedUrl) {
    const id = embedUrl.match(/\/movie\/(\d+)/i)?.[1] || "";
    if (!id) throw new Error("Не удалось извлечь Zenith id");
    const data = await resolverJson(`/zenith?id=${encodeURIComponent(id)}`);
    if (!data.hasSources) throw new Error("Worker Zenith fallback не отдал источники");
    return { sources: data.sources || {}, meta: data.meta || {} };
  }

  async function playShaka(url, kind, token, resume) {
    if (isStale(token)) return;
    await teardownPlayer(true);
    const video = document.createElement("video");
    video.controls = true;
    video.playsInline = true;
    video.autoplay = true;
    video.crossOrigin = "anonymous";
    if (isStale(token)) return;
    el.playerHost.replaceChildren(video);
    state.videoEl = video;

    if (!window.shaka) throw new Error("Shaka не загрузился");
    shaka.polyfill.installAll();
    if (!shaka.Player.isBrowserSupported()) throw new Error("Shaka: браузер не поддерживается");

    const player = new shaka.Player();
    state.player = player;
    await player.attach(video);
    player.configure({
      streaming: { retryParameters: { maxAttempts: 2, baseDelay: 500, backoffFactor: 1.4 } },
      manifest: { dash: { ignoreMinBufferTime: true } },
    });
    player.addEventListener("trackschanged", renderTracks);
    player.addEventListener("variantchanged", renderTracks);
    player.addEventListener("textchanged", renderTracks);
    await player.load(url);
    if (isStale(token)) {
      await player.destroy().catch(() => {});
      if (state.player === player) { state.player = null; state.videoEl = null; }
      return;
    }
    if (resume > 5) { try { video.currentTime = resume; } catch { /* ignore */ } }
    renderTracks();
    try { await video.play(); } catch { /* user gesture may be required */ }
  }

  function startTracking(histKey, target) {
    stopTracking();
    state.trackInterval = setInterval(() => {
      const v = state.videoEl;
      if (!v) return;
      const dur = v.duration;
      const cur = v.currentTime;
      if (!dur || !isFinite(dur) || dur <= 0) return;
      recordHistory({
        key: histKey,
        kind: target.kind,
        target: cleanTarget(target),
        title: target.title || "",
        poster: target.poster || "",
        year: target.year || "",
        position: cur,
        duration: dur,
        progress: cur / dur,
      });
    }, 5000);
  }
  function stopTracking() {
    if (state.trackInterval) { clearInterval(state.trackInterval); state.trackInterval = null; }
  }

  async function teardownPlayer(keepView) {
    stopTracking();
    if (state.player) {
      await state.player.destroy().catch(() => {});
      state.player = null;
    }
    state.videoEl = null;
    if (!keepView) {
      el.trackPanel.replaceChildren();
      el.trackPanel.classList.add("hidden");
    }
  }

  function showPlayerLoading() {
    el.playerHost.innerHTML = '<div class="placeholder"><div class="spinner"></div><span>Загрузка плеера…</span></div>';
  }

  function renderTracks() {
    const player = state.player;
    if (!player) return;
    el.trackPanel.replaceChildren();
    el.trackPanel.classList.remove("hidden");
    const variants = player.getVariantTracks ? player.getVariantTracks() : [];
    const texts = player.getTextTracks ? player.getTextTracks() : [];

    const audioChoices = groupBy(variants, (track) => `${track.language || ""}|${(track.roles || []).join(",")}`);
    addTrackGroup("Озвучка", audioChoices, (track, index) => {
      const btn = document.createElement("button");
      btn.textContent = audioNameFor(track.language, index);
      if (track.active) btn.className = "active";
      btn.addEventListener("click", () => {
        player.selectAudioLanguage(track.language, (track.roles || [])[0]);
        setTimeout(renderTracks, 250);
      });
      return btn;
    });

    const activeAudio = variants.find((track) => track.active)?.language || audioChoices[0]?.language || "";
    const qualityChoices = groupBy(
      variants.filter((track) => !activeAudio || track.language === activeAudio),
      (track) => `${track.height || 0}|${Math.round((track.bandwidth || 0) / 1000)}`
    ).sort((a, b) => (b.height || 0) - (a.height || 0) || (b.bandwidth || 0) - (a.bandwidth || 0));
    addTrackGroup("Качество", qualityChoices, (track) => {
      const btn = document.createElement("button");
      btn.textContent = `${track.height ? `${track.height}p` : "auto"} ${bitrateLabel(track)}`.trim();
      if (track.active) btn.className = "active";
      btn.addEventListener("click", () => {
        player.configure({ abr: { enabled: false } });
        player.selectVariantTrack(track, true);
        setTimeout(renderTracks, 250);
      });
      return btn;
    });

    addTrackGroup("Субтитры", [{ off: true }, ...texts], (track) => {
      const btn = document.createElement("button");
      if (track.off) {
        btn.textContent = texts.length ? "Выкл" : "нет";
        if (!texts.length || !player.isTextTrackVisible || !player.isTextTrackVisible()) btn.className = "active";
        btn.addEventListener("click", () => player.setTextTrackVisibility(false));
        return btn;
      }
      btn.textContent = track.label || track.language || "subs";
      if (track.active && player.isTextTrackVisible && player.isTextTrackVisible()) btn.className = "active";
      btn.addEventListener("click", () => {
        player.selectTextTrack(track);
        player.setTextTrackVisibility(true);
        setTimeout(renderTracks, 250);
      });
      return btn;
    });
  }

  function addTrackGroup(title, items, renderButton) {
    const group = document.createElement("div");
    group.className = "track-group";
    const label = document.createElement("strong");
    label.textContent = title;
    const buttons = document.createElement("div");
    buttons.className = "track-buttons";
    if (!items.length) {
      const span = document.createElement("span");
      span.className = "muted";
      span.textContent = "—";
      buttons.appendChild(span);
    } else {
      items.forEach((item, index) => buttons.appendChild(renderButton(item, index)));
    }
    group.append(label, buttons);
    el.trackPanel.appendChild(group);
  }

  // =====================================================================
  // Engine: third-party fetch, newdeaf parsing, Zenith/Ortified parsing
  // (ported verbatim from the proven MVP — do not "simplify".)
  // =====================================================================
  async function fetchThirdPartyText(url, options = {}) {
    const preferSandbox = !!options.preferSandbox;
    if (preferSandbox) {
      try {
        return await sandboxFetchText(url, options.label, options.timeoutMs);
      } catch (error) {
        if (options.directFallback === false) throw error;
        log("fetch-warn", "sandbox fetch failed; trying direct CORS", { url, message: error.message });
      }
    }
    try {
      const response = await fetch(url, { cache: "no-store", credentials: "omit", mode: "cors", referrerPolicy: "no-referrer" });
      const text = await response.text();
      if (!response.ok) throw new Error(`Fetch ${response.status}`);
      return text;
    } catch (error) {
      if (!preferSandbox) return sandboxFetchText(url, options.label, options.timeoutMs);
      throw error;
    }
  }

  function sandboxFetchText(url, label, timeoutMs) {
    const id = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    return new Promise((resolve, reject) => {
      const iframe = document.createElement("iframe");
      iframe.sandbox = "allow-scripts";
      iframe.style.cssText = "position:absolute;width:1px;height:1px;left:-9999px;top:-9999px;border:0";
      const timer = setTimeout(() => cleanup(new Error(`Sandbox fetch timeout for ${url}`)), timeoutMs || 30000);
      const cleanup = (error, value) => {
        clearTimeout(timer);
        window.removeEventListener("message", onMessage);
        iframe.remove();
        if (error) reject(error);
        else resolve(value);
      };
      const onMessage = (event) => {
        const data = event.data || {};
        if (!data.alphyFetch || data.id !== id) return;
        if (!data.ok) { cleanup(new Error(data.error || `Sandbox fetch failed for ${url}`)); return; }
        cleanup(null, data.text);
      };
      window.addEventListener("message", onMessage);
      iframe.addEventListener("load", () => iframe.contentWindow.postMessage({ alphyFetch: true, id, url }, "*"), { once: true });
      iframe.srcdoc = `<!doctype html><meta charset="utf-8"><script>
addEventListener('message', async (event) => {
  const data = event.data || {};
  if (!data.alphyFetch) return;
  try {
    const response = await fetch(data.url, { cache: 'no-store', credentials: 'omit', mode: 'cors', referrerPolicy: 'no-referrer' });
    const text = await response.text();
    parent.postMessage({ alphyFetch: true, id: data.id, ok: true, status: response.status, contentType: response.headers.get('content-type') || '', text }, '*');
  } catch (error) {
    parent.postMessage({ alphyFetch: true, id: data.id, ok: false, error: String(error && error.message || error) }, '*');
  }
});
<\/script>`;
      document.body.appendChild(iframe);
    });
  }

  function pageUrlCandidates(pageUrl) {
    const original = new URL(pageUrl);
    if (!/^\d{1,2}[a-z]{3}\.newdeaf\.co$/i.test(original.host)) return [original.href];
    return dailyMirrorCandidates(original.origin).map((mirror) => {
      const candidate = new URL(original.href);
      const mirrorUrl = new URL(mirror);
      candidate.protocol = mirrorUrl.protocol;
      candidate.host = mirrorUrl.host;
      return candidate.href;
    });
  }

  function dailyMirrorCandidates(explicitOrigin) {
    // newdeaf serves a {DD}{mon}.newdeaf.co mirror for the current Moscow date and
    // rolls it over around midnight–02:00 MSK, killing the previous day's host.
    // Probe today's MSK date first, then yesterday and tomorrow so we can't miss
    // the live host whichever side of midnight it is (the earlier code shifted the
    // clock back 2h and probed a dead yesterday-mirror when today's was already up).
    // First host that parses wins, so the others aren't hit.
    const mskNow = Date.now() + 3 * 3600000;
    const slug = (offsetDays) => {
      const date = new Date(mskNow + offsetDays * 86400000);
      return `https://${date.getUTCDate()}${monthSlug(date)}.newdeaf.co`;
    };
    const generated = [slug(0), slug(-1), slug(1)];
    return unique([explicitOrigin, ...generated].filter(Boolean).map((value) => cleanBaseUrl(value)));
  }
  function monthSlug(date) {
    return ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"][date.getUTCMonth()];
  }

  function isNewdeafPage(href, base) {
    const url = cleanUrl(href, base);
    if (!url) return null;
    const parsed = new URL(url);
    // Daily-mirror hosts (17jun.newdeaf.co) 301-redirect to the apex newdeaf.co, so
    // result links come back on EITHER the mirror host or the apex (and which one is
    // geo-dependent). Accept the whole newdeaf.co family instead of demanding an
    // exact match with the mirror we requested — that strict check silently dropped
    // every result after the redirect.
    if (!/(^|\.)newdeaf\.co$/i.test(parsed.host)) return null;
    if (!/\.html(?:$|[?#])/i.test(parsed.href)) return null;
    if (!/(\/film\/|\/serial\/|\/multfilm\/|\/anime\/|\/multserial\/|\/multserialy\/)/i.test(parsed.pathname)) return null;
    return parsed.href;
  }

  function parseNewdeafSearch(html, base) {
    const doc = new DOMParser().parseFromString(html, "text/html");
    const seen = new Set();
    const out = [];
    // newdeaf's DLE "card" layout: <article class="card"> wraps a poster anchor
    // (a.card__img with img[data-src]) AND a title anchor (h2.card__title a).
    // Iterate the card containers and pull the title from the title element so we
    // get a clean name ("Рик и Морти (1 сезон) - русские субтитры") instead of the
    // whole card's text blob. The poster lives in img[data-src] (src is a 1x1
    // lazy-load placeholder). Fall back to a generic anchor scan for other skins.
    for (const card of doc.querySelectorAll("article.card, .card, .th-item, .short, .shortstory")) {
      const titleLink = card.querySelector(".card__title a, h2 a, .th-title a, .short_header a, h3 a");
      const anyLink = titleLink || card.querySelector("a[href]");
      if (!anyLink) continue;
      const href = isNewdeafPage(anyLink.getAttribute("href"), base);
      if (!href || seen.has(href)) continue;
      const titleEl = card.querySelector(".card__title, .th-title, .short_header, h2, h3");
      let title = compact(titleEl ? titleEl.textContent : (titleLink ? titleLink.textContent : ""));
      if (!title) title = compact(anyLink.getAttribute("title")) || new URL(href).pathname.split("/").pop();
      const img = card.querySelector("img[data-src], img[data-original], img[src]");
      const poster = img ? cleanUrl(img.getAttribute("data-src") || img.getAttribute("data-original") || img.getAttribute("src"), base) : null;
      seen.add(href);
      out.push({ url: href, title, poster });
      if (out.length >= 20) break;
    }
    if (out.length) return out;

    for (const a of doc.querySelectorAll("a[href]")) {
      const href = isNewdeafPage(a.getAttribute("href"), base);
      if (!href || seen.has(href)) continue;
      seen.add(href);
      const card = a.closest("article, .short, .shortstory, .story, .item, .th-item, .movie-item") || a.parentElement;
      const title = compact(a.textContent) || compact(card && card.textContent).slice(0, 140) || new URL(href).pathname.split("/").pop();
      const img = card && card.querySelector && card.querySelector("img[data-src], img[data-original], img[src]");
      const poster = img ? cleanUrl(img.getAttribute("data-src") || img.getAttribute("data-original") || img.getAttribute("src"), base) : null;
      out.push({ url: href, title, poster });
      if (out.length >= 20) break;
    }
    return out;
  }

  function parseNewdeafPage(html, pageUrl) {
    const doc = new DOMParser().parseFromString(html, "text/html");
    const ortified = [];
    const allo = [];
    const add = (list, value, re) => {
      const cleaned = cleanUrl(value, pageUrl);
      if (cleaned && re.test(cleaned) && !list.includes(cleaned)) list.push(cleaned);
    };
    for (const node of doc.querySelectorAll("iframe[src], [data-src], [data-url], [src]")) {
      const value = node.getAttribute("src") || node.getAttribute("data-src") || node.getAttribute("data-url");
      add(ortified, value, /^https:\/\/api\.ortified\.ws\/embed\//i);
      add(allo, value, /^https:\/\/allo\.cdnlbox\.club\//i);
    }
    const text = html.replace(/&amp;/g, "&");
    for (const match of text.matchAll(/https:\/\/api\.ortified\.ws\/embed\/[^"'<>\s)]+/gi)) add(ortified, match[0], /^https:\/\/api\.ortified\.ws\/embed\//i);
    for (const match of text.matchAll(/https:\/\/allo\.cdnlbox\.club\/[^"'<>\s)]+/gi)) add(allo, match[0], /^https:\/\/allo\.cdnlbox\.club\//i);

    const title =
      compact(doc.querySelector('meta[property="og:title"]')?.getAttribute("content")) ||
      compact(doc.querySelector("h1")?.textContent) ||
      compact(doc.querySelector("title")?.textContent);
    const description =
      compact(doc.querySelector('meta[property="og:description"]')?.getAttribute("content")) ||
      compact(doc.querySelector('meta[name="description"]')?.getAttribute("content"));
    const poster = cleanUrl(doc.querySelector('meta[property="og:image"], meta[name="og:image"]')?.getAttribute("content"), pageUrl);
    const year = extractYear(`${title} ${description} ${pageUrl}`);
    return { title, description, poster, year, ortified, allo };
  }

  function parseZenithEmbed(html) {
    const sources = {};
    for (const match of html.matchAll(/\b(dash|dasha|hls)\s*:\s*("(?:(?:\\.|[^"\\])*)"|'(?:(?:\\.|[^'\\])*)')/g)) {
      sources[match[1]] = decodeJsString(match[2]).replace(/&amp;/g, "&");
    }
    const fallbackText = html.replace(/\\\//g, "/").replace(/&amp;/g, "&");
    if (!sources.dash) sources.dash = firstUrl(fallbackText, /\.mpd(?:\?|$)/i);
    if (!sources.hls) sources.hls = firstUrl(fallbackText, /(?:\.m3u8|master\.m3u8)(?:\?|$)/i);
    const titleMatch = html.match(/\btitle\s*:\s*("(?:(?:\\.|[^"\\])*)"|'(?:(?:\\.|[^'\\])*)')/);
    const audioMatch = html.match(/\baudio\s*:\s*\{\s*["']?names["']?\s*:\s*\[([^\]]*)\]/);
    return {
      sources,
      meta: {
        title: titleMatch ? decodeJsString(titleMatch[1]) : "",
        audioNames: audioMatch ? [...audioMatch[1].matchAll(/"([^"]+)"|'([^']+)'/g)].map((m) => m[1] || m[2]) : [],
      },
    };
  }

  function firstUrl(text, kindRe) {
    for (const match of text.matchAll(/https?:\/\/[^"'<>\s\\]+/g)) {
      const url = match[0].replace(/[),.;]+$/, "");
      if (kindRe.test(url)) return url;
    }
    return "";
  }

  function sanitizeOrtifiedHtml(html, embedUrl, mode) {
    let out = String(html || "");
    const baseHref = new URL(embedUrl).origin + "/";
    const stats = {
      mode,
      ok: false,
      adScriptBlocks: (out.match(/<script\s+data-name=["']ad["'][\s\S]*?<\/script>/gi) || []).length,
      makePlayerRefs: (out.match(/makePlayer\s*\(/g) || []).length,
    };
    out = out.replace(/<script\s+data-name=["']ad["'][\s\S]*?<\/script>/i, '<script data-name="ad">var middleCount = 0, adsConfig = {};</' + "script>");
    out = out.replace(/ads:\s*adsConfig\s*,/g, "ads: {},");
    if (!/<base\s/i.test(out) && /<head([^>]*)>/i.test(out)) out = out.replace(/<head([^>]*)>/i, `<head$1><base href="${escapeAttr(baseHref)}">`);
    if (!/<base\s/i.test(out)) out = out.replace(/<html([^>]*)>/i, `<html$1><head><base href="${escapeAttr(baseHref)}"></head>`);
    out = out.replace(/<head([^>]*)>/i, `<head$1>${adBlockPrelude()}<style>html,body{margin:0;background:#000;min-height:100%;height:100%;overflow:hidden;}</style>`);
    stats.ok = stats.makePlayerRefs > 0;
    return { html: out, stats };
  }

  function adBlockPrelude() {
    return `<script data-cleanroom="ad-block-prelude">
(() => {
  const blocked = [/vuegenesisvue\\.com/i,/buzzoola/i,/targetads\\.io/i,/ufouxbwn\\.com/i,/getaim\\.org/i,/yandex\\.ru/i,/aidata\\.io/i,/a\\.mts\\.ru/i,/cm\\.a\\.mts\\.ru/i,/trk\\.mail\\.ru/i,/timing-js-menu\\.xyz/i];
  const isBlocked = (value) => {
    try {
      const url = typeof value === 'string' ? value : value && (value.url || value.src || value.href);
      return !!url && blocked.some((re) => re.test(String(url)));
    } catch (e) { return false; }
  };
  const nativeFetch = window.fetch && window.fetch.bind(window);
  if (nativeFetch) window.fetch = (input, init) => isBlocked(typeof input === 'string' ? input : input && input.url) ? Promise.reject(new TypeError('cleanroom blocked fetch')) : nativeFetch(input, init);
  const nativeOpen = XMLHttpRequest && XMLHttpRequest.prototype.open;
  const nativeSend = XMLHttpRequest && XMLHttpRequest.prototype.send;
  if (nativeOpen && nativeSend) {
    XMLHttpRequest.prototype.open = function(method, url) { this.__cleanroomBlocked = isBlocked(url); return nativeOpen.apply(this, arguments); };
    XMLHttpRequest.prototype.send = function() { if (this.__cleanroomBlocked) { setTimeout(() => { try { this.dispatchEvent(new Event('error')); this.dispatchEvent(new Event('loadend')); } catch (e) {} }, 0); return; } return nativeSend.apply(this, arguments); };
  }
})();
<\/script>`;
  }

  // =====================================================================
  // small helpers
  // =====================================================================
  function chooseMovie(results, title, year) {
    if (!Array.isArray(results) || !results.length) return null;
    const normalized = normalizeTitle(title);
    return results.find((movie) => year && String(movie.year) === String(year) && normalizeTitle(movieTitle(movie)).includes(normalized.slice(0, 12))) ||
      results.find((movie) => year && String(movie.year) === String(year)) ||
      results[0];
  }
  function cleanMovieTitle(value) {
    return compact(value)
      .replace(/^(фильм|сериал|мультфильм|аниме|мультсериал)\s+/i, "")
      .replace(/\s*\((?:19|20)\d{2}\).*$/, "")
      .replace(/\s*смотреть.*$/i, "")
      .trim();
  }
  function movieTitle(movie) {
    return movie?.name || movie?.alternativeName || movie?.enName || movie?.title || "";
  }
  function normalizeTitle(value) {
    return cleanMovieTitle(value).toLowerCase().replace(/ё/g, "е").replace(/[^a-zа-я0-9]+/gi, "");
  }
  function audioNameFor(language, fallbackIndex) {
    const names = state.audioNames || [];
    const suffix = String(language || "").match(/(\d+)$/);
    if (suffix && names[Number(suffix[1])]) return names[Number(suffix[1])];
    if (names[fallbackIndex]) return names[fallbackIndex];
    return language || "unknown";
  }
  function bitrateLabel(track) {
    return track.bandwidth ? `${(track.bandwidth / 1000000).toFixed(1)} Mbps` : "";
  }
  function groupBy(list, keyFn) {
    const map = new Map();
    for (const item of list) {
      const key = keyFn(item);
      if (!map.has(key)) map.set(key, item);
    }
    return [...map.values()];
  }
  function decodeJsString(raw) {
    try { return Function(`"use strict"; return (${raw});`)(); }
    catch { return String(raw || "").slice(1, -1); }
  }
  function cleanUrl(value, base) {
    try { return new URL(String(value || "").replace(/&amp;/g, "&"), base).href; }
    catch { return null; }
  }
  function cleanBaseUrl(value) {
    return String(value || "").trim().replace(/\/+$/, "");
  }
  function extractYear(value) {
    return String(value || "").match(/\b(19|20)\d{2}\b/)?.[0] || "";
  }
  function unique(values) {
    return [...new Set(values.filter(Boolean))];
  }
  function compact(value) {
    return String(value || "").replace(/\s+/g, " ").trim();
  }
  function escapeHtml(value) {
    return String(value || "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
  }
  function escapeAttr(value) {
    return escapeHtml(value).replace(/`/g, "&#96;");
  }
  function log(...args) {
    if (DEBUG) console.log("[alphy]", ...args);
  }
  function showError(error) {
    const message = String(error?.message || error);
    el.error.textContent = `Ошибка: ${message}`;
    el.error.classList.remove("hidden");
    log("error", message, error?.stack);
  }
  function hideError() {
    el.error.classList.add("hidden");
  }

  // =====================================================================
  // Search input + onscreen controls
  // =====================================================================
  function onSearchSubmit() {
    const value = el.searchInput.value.trim();
    if (!value) return;
    if (/^https?:\/\//i.test(value)) {
      try {
        const url = new URL(value);
        if (/api\.ortified\.ws$/i.test(url.host)) return go(`/watch/ort/${encodeURIComponent(value)}`);
        if (/api\.zenithjs\.ws$/i.test(url.host)) {
          const id = value.match(/\/movie\/(\d+)/)?.[1];
          if (id) return go(`/watch/zen/${id}`);
        }
        if (/newdeaf\.co$/i.test(url.host)) return go(`/watch/nd/${encodeURIComponent(value)}`);
      } catch { /* fall through to title search */ }
    }
    go(`/search/${encodeURIComponent(value)}`);
  }

  function bindKeyboard() {
    document.addEventListener("keydown", (e) => {
      if (document.activeElement === el.searchInput) return;
      if (el.watchView.classList.contains("hidden")) return;
      const v = state.videoEl;
      if (!v) return; // shortcuts only for the Shaka <video>, not the Ortified iframe
      const code = e.code;
      if (code === "ArrowRight") { e.preventDefault(); v.currentTime += 10; }
      else if (code === "ArrowLeft") { e.preventDefault(); v.currentTime -= 10; }
      else if (code === "ArrowUp") { e.preventDefault(); v.volume = Math.min(1, v.volume + 0.05); }
      else if (code === "ArrowDown") { e.preventDefault(); v.volume = Math.max(0, v.volume - 0.05); }
      else if (code === "Space" || code === "KeyK") { e.preventDefault(); v.paused ? v.play() : v.pause(); }
      else if (code === "KeyF") { e.preventDefault(); if (document.fullscreenElement) document.exitFullscreen(); else v.requestFullscreen?.(); }
    });
  }

  // =====================================================================
  // resolver settings
  // =====================================================================
  function saveResolver() {
    state.resolverBaseUrl = cleanBaseUrl(el.resolverInput.value);
    if (state.resolverBaseUrl) localStorage.setItem(STORE_RESOLVER, state.resolverBaseUrl);
    else localStorage.removeItem(STORE_RESOLVER);
    el.resolverState.textContent = state.resolverBaseUrl ? "сохранён" : "—";
  }
  async function testResolver() {
    saveResolver();
    try {
      const data = await resolverJson("/health");
      el.resolverState.textContent = data.ok ? "ok" : "?";
    } catch (error) {
      el.resolverState.textContent = `ошибка: ${error.message}`;
    }
  }

  // =====================================================================
  // boot
  // =====================================================================
  function boot() {
    state.playerPlaceholder = el.playerHost.innerHTML;

    const resolverFromUrl = params.get("resolver");
    if (resolverFromUrl) localStorage.setItem(STORE_RESOLVER, cleanBaseUrl(resolverFromUrl));
    const defaultResolver = isLocal ? "http://127.0.0.1:8787" : "https://alphytv.alphy.deno.net";
    const legacyResolvers = ["https://alphy-resolver.p-tikhonin.workers.dev"];
    let storedResolver = cleanBaseUrl(localStorage.getItem(STORE_RESOLVER) || "");
    if (!storedResolver || legacyResolvers.includes(storedResolver)) {
      storedResolver = defaultResolver;
      localStorage.setItem(STORE_RESOLVER, storedResolver);
    }
    state.resolverBaseUrl = storedResolver;
    el.resolverInput.value = state.resolverBaseUrl;
    el.resolverState.textContent = "сохранён";

    el.logoBtn.addEventListener("click", () => go("/"));
    el.searchBtn.addEventListener("click", onSearchSubmit);
    el.searchInput.addEventListener("keydown", (e) => { if (e.key === "Enter") onSearchSubmit(); });
    el.settingsToggle.addEventListener("click", () => el.settingsPanel.classList.toggle("hidden"));
    el.saveResolverBtn.addEventListener("click", saveResolver);
    el.healthBtn.addEventListener("click", () => testResolver());
    el.backBtn.addEventListener("click", () => { if (history.length > 1) history.back(); else go("/"); });
    el.bookmarkBtn.addEventListener("click", () => { if (state.currentTarget) toggleBookmark(state.currentTarget); });
    window.addEventListener("hashchange", route);
    bindKeyboard();

    // Migrate legacy query-param deep links (?q / ?url / ?kpId / ?zenith) to hash.
    if (!location.hash) {
      if (params.get("kpId")) replaceHash(`/watch/kp/${encodeURIComponent(params.get("kpId"))}`);
      else if (params.get("zenith")) replaceHash(`/watch/zen/${encodeURIComponent(params.get("zenith"))}`);
      else if (params.get("url")) {
        el.searchInput.value = params.get("url");
        onSearchSubmit();
        return;
      } else if (params.get("q")) replaceHash(`/search/${encodeURIComponent(params.get("q"))}`);
    }

    route();
  }

  boot();
})();
