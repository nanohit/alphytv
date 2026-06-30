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
  // Older builds cached a transient empty Newdeaf result for six hours. Keep
  // this namespace versioned so those false misses cannot survive an upgrade.
  const ND_SEARCH_CACHE_NS = "ndsearch.v2";
  const TTL = {
    search: 6 * 3600e3,
    ndsearch: 6 * 3600e3,
    ndpage: 24 * 3600e3,
    zona: 30 * 24 * 3600e3,
    meta: 7 * 24 * 3600e3,
    enriched: 30 * 24 * 3600e3,
    subtitles: 24 * 3600e3,
  };
  const WYZIE_BASE_URL = "https://sub.wyzie.io";
  const WYZIE_KEYS = [
    "wyzie-7qnppx8o6q5f7hqa0uxg8u739dv0tm8t",
    "wyzie-tzgfaqnbu5319z0yjl38l1lfun1cmv9t",
    "wyzie-qu8oh8trk1i63dsvqvbevylamzg5lpwu",
    "wyzie-c5dkfwmef9gdj8mi6hvjmjne2kgtdf1v",
    "wyzie-df0ppilx82fhonhekq55hg2q3lqu8wzv",
  ];
  const WYZIE_LANGUAGES = ["ru", "en"];

  const params = new URLSearchParams(location.search);
  const DEBUG = params.has("debug");
  const isLocal = /^(127\.0\.0\.1|localhost)$/i.test(location.hostname);

  const el = {
    logoBtn: document.getElementById("logoBtn"),
    searchInput: document.getElementById("searchInput"),
    searchBtn: document.getElementById("searchBtn"),
    bookmarksToggle: document.getElementById("bookmarksToggle"),
    bookmarksNavCount: document.getElementById("bookmarksNavCount"),
    settingsPanel: document.getElementById("settingsPanel"),
    resolverInput: document.getElementById("resolverInput"),
    saveResolverBtn: document.getElementById("saveResolverBtn"),
    healthBtn: document.getElementById("healthBtn"),
    resolverState: document.getElementById("resolverState"),
    homeView: document.getElementById("homeView"),
    continueSection: document.getElementById("continueSection"),
    continueHeader: document.getElementById("continueHeader"),
    continueGrid: document.getElementById("continueGrid"),
    bookmarksView: document.getElementById("bookmarksView"),
    bookmarksCount: document.getElementById("bookmarksCount"),
    bookmarksGrid: document.getElementById("bookmarksGrid"),
    bookmarksEmpty: document.getElementById("bookmarksEmpty"),
    homeEmpty: document.getElementById("homeEmpty"),
    searchView: document.getElementById("searchView"),
    resultsTitle: document.getElementById("resultsTitle"),
    resultsGrid: document.getElementById("resultsGrid"),
    watchView: document.getElementById("watchView"),
    watchTitle: document.getElementById("watchTitle"),
    playerHost: document.getElementById("playerHost"),
    serialPanel: document.getElementById("serialPanel"),
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
    opravar: null,
    serial: null,
    currentMeta: null,
    zenithEmbedUrl: "",
    playerReady: false,
    lastSnapshotAt: 0,
    trackInterval: null,
    playbackRate: 1,
    subtitleRequest: {
      loading: false,
      error: "",
      message: "",
    },
    subtitleObjectUrls: [],
    // Subtitle sync: the raw subtitles we fetched (so the offset control can
    // re-render them shifted), the current global offset, the open state of the
    // ⚙ control, and the Shaka text-track ids superseded by a shifted copy
    // (4.11 has no removeTextTrack, so we hide stale tracks from the menu).
    loadedSubs: [],
    subtitleOffset: 0,
    subtitleOffsetOpen: false,
    subtitleOffsetBusy: false,
    staleTextTrackIds: [],
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
    if (t.kind === "opr") return `opr:${t.playerUrl}`;
    if (t.kind === "nd") return `nd:${t.pageUrl}`;
    return "x";
  }
  function cleanTarget(t) {
    if (t.kind === "kp") return { kind: "kp", kpId: t.kpId };
    if (t.kind === "zen") return { kind: "zen", zenithId: t.zenithId };
    if (t.kind === "ort") return { kind: "ort", embedUrl: t.embedUrl };
    if (t.kind === "opr") return { kind: "opr", playerUrl: t.playerUrl, pageUrl: t.pageUrl || "" };
    if (t.kind === "nd") return { kind: "nd", pageUrl: t.pageUrl };
    return t;
  }
  function hashFor(t) {
    if (t.kind === "kp") return `/watch/kp/${encodeURIComponent(t.kpId)}`;
    if (t.kind === "zen") return `/watch/zen/${encodeURIComponent(t.zenithId)}`;
    if (t.kind === "ort") return `/watch/ort/${encodeURIComponent(t.embedUrl)}`;
    if (t.kind === "opr") return `/watch/opr/${encodeURIComponent(t.playerUrl)}`;
    if (t.kind === "nd") return `/watch/nd/${encodeURIComponent(t.pageUrl)}`;
    return "/";
  }

  function recordHistory(entry) {
    let hist = loadList(STORE_HISTORY);
    if (entry.snapshot) {
      hist = hist.map((item) => item.key === entry.key ? item : ({ ...item, snapshot: "" }));
    }
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
      rating: state.currentMeta?.rating || existing?.rating,
      movieLength: state.currentMeta?.movieLength || existing?.movieLength,
      isSeries: state.currentMeta?.isSeries ?? target.isSeries ?? existing?.isSeries ?? false,
      position: existing?.position || 0,
      duration: existing?.duration || 0,
      progress: existing?.progress || 0,
    });
  }
  // Recover title/poster/year for a target that carries no kpId (Ortified), e.g.
  // when reopened from Continue/Bookmarks where the URL is just the embed. Falls
  // back to whatever the history/bookmark entry kept so the watch tab is never bare.
  function storedMeta(key) {
    const entry = loadList(STORE_HISTORY).find((x) => x.key === key) || loadList(STORE_BOOKMARKS).find((x) => x.key === key);
    return entry ? { title: entry.title, poster: entry.poster, year: entry.year } : null;
  }

  function resumePosition(key) {
    const e = loadList(STORE_HISTORY).find((h) => h.key === key);
    if (!e || !e.duration) return 0;
    if (e.progress >= 0.95) return 0;
    return e.position > 5 ? e.position : 0;
  }
  function savedAudioLang(key) {
    return loadList(STORE_HISTORY).find((h) => h.key === key)?.audioLang || null;
  }
  function savedOpravarSelection(key) {
    return loadList(STORE_HISTORY).find((h) => h.key === key)?.opravarSelection || null;
  }
  function savedSerialSelection(key) {
    return loadList(STORE_HISTORY).find((h) => h.key === key)?.serialSelection || null;
  }
  function persistAudio(lang) {
    const t = state.currentTarget;
    if (!t || !lang) return;
    recordHistory({
      key: keyFor(t), kind: t.kind, target: cleanTarget(t),
      title: t.title || "", poster: t.poster || "", year: t.year || "", audioLang: lang,
    });
  }

  function isBookmarked(key) {
    return loadList(STORE_BOOKMARKS).some((b) => b.key === key);
  }
  function toggleBookmark(target, details = {}) {
    const key = keyFor(target);
    let bms = loadList(STORE_BOOKMARKS);
    let added = false;
    if (bms.some((b) => b.key === key)) {
      bms = bms.filter((b) => b.key !== key);
    } else {
      added = true;
      bms.unshift({
        key,
        kind: target.kind,
        target: cleanTarget(target),
        title: details.title || target.title || "",
        poster: details.poster || target.poster || "",
        year: details.year || target.year || "",
        rating: details.rating || target.rating || {},
        movieLength: details.movieLength || target.movieLength || null,
        isSeries: details.isSeries ?? target.isSeries ?? false,
        addedAt: Date.now(),
      });
    }
    saveList(STORE_BOOKMARKS, bms.slice(0, 100));
    updateBookmarkBtn(state.currentTarget);
    syncBookmarkControls(key);
    updateBookmarksNav();
    return added;
  }
  function updateBookmarkBtn(target) {
    if (!target) return;
    syncBookmarkControls(keyFor(target));
  }

  function updateBookmarksNav() {
    const count = loadList(STORE_BOOKMARKS).length;
    el.bookmarksNavCount.textContent = String(count);
    el.bookmarksNavCount.classList.toggle("hidden", count === 0);
  }

  function syncBookmarkButton(button, key) {
    const on = isBookmarked(key);
    button.classList.toggle("on", on);
    button.setAttribute("aria-pressed", String(on));
    button.setAttribute("aria-label", on ? "Убрать из закладок" : "Добавить в закладки");
    button.title = on ? "Убрать из закладок" : "Добавить в закладки";
  }

  function syncBookmarkControls(key) {
    document.querySelectorAll(".card-bookmark").forEach((button) => {
      if (!key || button.dataset.bookmarkKey === key) {
        syncBookmarkButton(button, button.dataset.bookmarkKey);
      }
    });
  }

  function addCardBookmark(media, target, details = {}, onChange) {
    if (!target?.kind) return null;
    const key = keyFor(target);
    const button = document.createElement("button");
    button.className = "card-bookmark";
    button.type = "button";
    button.dataset.bookmarkKey = key;
    button.innerHTML = `
      <svg viewBox="0 0 24 30" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" aria-hidden="true">
        <path d="M3 1h18v27l-9-7-9 7z"></path>
      </svg>
    `;
    syncBookmarkButton(button, key);
    button.addEventListener("keydown", (event) => event.stopPropagation());
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      const added = toggleBookmark(target, details);
      onChange?.(added);
    });
    media.appendChild(button);
    return button;
  }

  // =====================================================================
  // Resolver client
  // =====================================================================
  async function resolverJson(path, { retries = 2, timeoutMs = 15000 } = {}) {
    if (!state.resolverBaseUrl) throw new Error("Resolver URL не настроен");
    const url = /^https?:\/\//i.test(path) ? path : `${state.resolverBaseUrl}${path}`;
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
          const resolverError = new Error(data.message || data.error || `Resolver ${response.status}`);
          resolverError.code = data.error || "";
          resolverError.status = response.status;
          throw resolverError;
        }
        return data;
      } catch (error) {
        lastError = error;
        const aborted = error?.name === "AbortError";
        const transient =
          aborted ||
          Number(error?.status) >= 500 ||
          error?.code === "zona_upstream_empty" ||
          /NetworkError|Failed to fetch|load failed|terminated|network/i.test(String(error?.message || ""));
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

  async function resolveZona(kpId, selection = null) {
    const cached = cacheGet("zona", kpId);
    if (cached && cached.embedUrl) return cached;
    const params = new URLSearchParams({ kpId: String(kpId) });
    const serialSelection = normalizeSerialHint(selection);
    if (serialSelection) {
      params.set("season", String(serialSelection.season));
      params.set("episode", String(serialSelection.episode));
    }
    const path = `/resolve-zona?${params}`;
    const candidates = isLocal
      ? [path]
      : [new URL(`/api${path}`, location.origin).href, path];
    let lastError;
    for (const candidate of candidates) {
      try {
        const data = await resolverJson(candidate, { retries: 0, timeoutMs: 10000 });
        if (!data.embedUrl) throw new Error("Zenith временно недоступен");
        const value = { zenithId: data.zenithId, embedUrl: data.embedUrl };
        cacheSet("zona", kpId, value, TTL.zona);
        return value;
      } catch (error) {
        lastError = error;
        log("zona-resolver-fallback", { candidate, message: error.message });
      }
    }
    throw lastError || new Error("Zenith временно недоступен");
  }

  async function resolveOpravar(playerUrl, pageUrl) {
    const query = new URLSearchParams({ url: playerUrl });
    if (pageUrl) query.set("pageUrl", pageUrl);
    return resolverJson(`/resolve-opravar?${query}`, { retries: 1, timeoutMs: 20000 });
  }

  async function resolveOpravarVideo(playerUrl, videoId, base) {
    const query = new URLSearchParams({ url: playerUrl, videoId: String(videoId) });
    if (base) query.set("base", base); // the live (rotating) host the initial resolve found
    return resolverJson(`/resolve-opravar?${query}`, { retries: 1, timeoutMs: 20000 });
  }

  async function searchNewdeaf(query) {
    const normalizedQuery = compact(query);
    const cacheKey = normalizedQuery.toLowerCase().replace(/ё/g, "е");
    const cached = cacheGet(ND_SEARCH_CACHE_NS, cacheKey);
    if (Array.isArray(cached) && cached.length) return cached;

    const mirrors = dailyMirrorCandidates();
    return new Promise((resolve, reject) => {
      let settled = false;
      let finished = 0;
      let lastError = null;
      const timers = [];

      const finish = (candidates) => {
        if (settled) return;
        settled = true;
        timers.forEach((timer) => clearTimeout(timer));
        // Never persist an empty result. "No matches" and "the browser privacy
        // layer swallowed the response" are indistinguishable at the cache
        // boundary, and pinning either one caused browser-specific false misses.
        if (candidates.length) cacheSet(ND_SEARCH_CACHE_NS, cacheKey, candidates, TTL.ndsearch);
        resolve(candidates);
      };
      const fail = (error, mirror) => {
        lastError = error;
        finished += 1;
        log("newdeaf-warn", "mirror failed", { mirror, message: error.message });
        if (!settled && finished === mirrors.length) {
          settled = true;
          reject(lastError || new Error("Newdeaf search unavailable"));
        }
      };

      mirrors.forEach((mirror, index) => {
        // Usually only today's mirror is touched. Adjacent mirrors start only
        // when the previous probe is slow/blocked, avoiding a long serial wait
        // on browsers whose privacy layer leaves cross-site fetch pending.
        const timer = setTimeout(async () => {
          if (settled) return;
          const searchUrl = `${mirror}/index.php?do=search&subaction=search&story=${encodeURIComponent(normalizedQuery)}`;
          try {
            const html = await fetchThirdPartyText(searchUrl, {
              preferSandbox: false,
              label: "newdeaf-search",
              timeoutMs: 7000,
              sandboxTimeoutMs: 9000,
            });
            if (!isNewdeafSearchDocument(html)) throw new Error("Newdeaf returned an invalid search document");
            finish(parseNewdeafSearch(html, searchUrl));
          } catch (error) {
            fail(error, mirror);
          }
        }, index * 1400);
        timers.push(timer);
      });
    });
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
        if (parsed.ortified.length || parsed.opravar.length || parsed.allo.length) break;
      } catch (error) {
        log("newdeaf-warn", "page candidate failed", { candidate, message: error.message });
      }
    }
    if (!parsed) throw new Error("Не удалось загрузить страницу newdeaf");
    // Only persist a page that actually exposed a player; an empty parse may be
    // a transient mirror miss we don't want to pin for 24h.
    if (parsed.ortified.length || parsed.opravar.length || parsed.allo.length) cacheSet("ndpage", pageUrl, parsed, TTL.ndpage);
    return parsed;
  }

  // =====================================================================
  // Router (hash-based; the URL is the cache key + shareable + back-button)
  // =====================================================================
  function parseHash() {
    const h = location.hash.replace(/^#/, "");
    if (!h || h === "/") return { view: "home" };
    const segs = h.split("/").filter(Boolean);
    if (segs[0] === "bookmarks") return { view: "bookmarks" };
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
      } else if (r.view === "bookmarks") {
        showBookmarks();
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
    el.bookmarksView.classList.toggle("hidden", name !== "bookmarks");
    el.searchView.classList.toggle("hidden", name !== "search");
    el.watchView.classList.toggle("hidden", name !== "watch");
    el.bookmarksToggle.classList.toggle("active", name === "bookmarks");
    window.dispatchEvent(new CustomEvent("alphy:view", { detail: { view: name } }));
  }

  function showHome() {
    setView("home");
    document.title = "alphy";
    el.searchInput.value = "";
    const hist = loadList(STORE_HISTORY);
    renderContinueHeader(hist.length);
    renderHomeGrid(el.continueGrid, el.continueSection, hist, {
      withProgress: true,
      store: STORE_HISTORY,
      featureLatest: true,
    });
    el.homeEmpty.classList.toggle("hidden", hist.length > 0);
  }

  function showBookmarks() {
    setView("bookmarks");
    document.title = "Закладки — alphy";
    el.searchInput.value = "";
    const entries = loadList(STORE_BOOKMARKS);
    el.bookmarksGrid.replaceChildren();
    el.bookmarksCount.textContent = String(entries.length);
    el.bookmarksCount.classList.toggle("hidden", entries.length === 0);
    el.bookmarksEmpty.classList.toggle("hidden", entries.length > 0);
    entries.forEach((entry) => {
      const target = entry.target;
      const card = makeCard({
        title: entry.title || "(без названия)",
        sub: [entry.year, entry.isSeries ? "сериал" : "фильм"].filter(Boolean).join(" · "),
        poster: entry.poster,
        rating: entry.rating,
        movieLength: entry.movieLength,
        isSeries: entry.isSeries,
        bookmark: { target, details: entry },
        onBookmarkChange: () => showBookmarks(),
        onClick: () => go(hashFor(target)),
      });
      el.bookmarksGrid.appendChild(card);
    });
    layoutMobileGrid(el.bookmarksGrid);
  }

  function renderHomeGrid(grid, section, entries, opts) {
    grid.replaceChildren();
    if (!entries.length) { section.classList.add("hidden"); return; }
    section.classList.remove("hidden");
    entries.slice(0, 20).forEach((entry, index) => {
      if (opts.withProgress) {
        grid.appendChild(makeContinueCard(entry, index, opts));
        return;
      }
      let sub = entry.year ? String(entry.year) : "";
      const card = makeCard({
        title: entry.title || "(без названия)",
        sub,
        poster: entry.poster,
        rating: entry.rating,
        movieLength: entry.movieLength,
        isSeries: entry.isSeries,
        bookmark: opts.store === STORE_BOOKMARKS ? { target: entry.target, details: entry } : null,
        onClick: () => go(hashFor(entry.target)),
        onRemove: () => {
          const list = loadList(opts.store).filter((x) => x.key !== entry.key);
          saveList(opts.store, list);
          showHome();
        },
      });
      grid.appendChild(card);
    });
    if (!opts.withProgress) layoutMobileGrid(grid);
  }

  function layoutMobileGrid(grid) {
    if (!grid) return;
    const cards = [...grid.children].filter((child) => child.classList.contains("card"));
    grid.classList.toggle("mobile-two-row", cards.length > 5);
    cards.forEach((card, index) => {
      const page = Math.floor(index / 10);
      const pageIndex = index % 10;
      card.style.setProperty("--mobile-row", pageIndex < 5 ? "1" : "2");
      card.style.setProperty("--mobile-column", String(page * 5 + (pageIndex % 5) + 1));
    });
  }

  function renderContinueHeader(count) {
    if (!el.continueHeader) return;
    el.continueHeader.replaceChildren(document.createTextNode("Продолжить просмотр"));
    if (!count) return;
    const badge = document.createElement("span");
    badge.className = "continue-count";
    badge.textContent = String(count);
    el.continueHeader.appendChild(badge);
  }

  function makeContinueCard(entry, index, opts) {
    const featured = !!opts.featureLatest && index === 0;
    const card = document.createElement("article");
    card.className = `card continue-card${featured ? " continue-featured" : ""}`;
    card.tabIndex = 0;
    card.setAttribute("role", "button");

    const media = document.createElement("div");
    media.className = "card-media continue-media";
    const imageUrl = featured && entry.snapshot ? entry.snapshot : entry.poster || entry.snapshot;
    if (imageUrl) {
      const image = document.createElement("img");
      image.className = "poster";
      image.loading = featured ? "eager" : "lazy";
      image.src = imageUrl;
      image.alt = "";
      image.addEventListener("error", () => image.replaceWith(blankPoster()));
      media.appendChild(image);
    } else {
      media.appendChild(blankPoster());
    }

    const play = document.createElement("span");
    play.className = "continue-play";
    play.setAttribute("aria-hidden", "true");
    media.appendChild(play);

    const progress = continueProgress(entry);
    const overlay = document.createElement("div");
    overlay.className = "continue-overlay";
    overlay.innerHTML = `
      <div class="continue-status">${escapeHtml(continueStatus(entry))}</div>
      <div class="continue-progress" aria-hidden="true">
        <div class="continue-progress-bar" style="width:${Math.round(progress * 100)}%"></div>
      </div>
    `;
    media.appendChild(overlay);

    addCardBookmark(media, entry.target, entry);

    const remove = document.createElement("button");
    remove.className = "card-remove";
    remove.type = "button";
    remove.innerHTML = `<span class="card-remove-glyph" aria-hidden="true">×</span>`;
    remove.setAttribute("aria-label", "Убрать из продолжения");
    remove.addEventListener("click", (event) => {
      event.stopPropagation();
      const list = loadList(opts.store).filter((item) => item.key !== entry.key);
      saveList(opts.store, list);
      showHome();
    });
    media.appendChild(remove);
    card.appendChild(media);

    const title = document.createElement("div");
    title.className = "ctitle";
    title.textContent = entry.title || "(без названия)";
    card.appendChild(title);
    if (entry.year) {
      const year = document.createElement("div");
      year.className = "cmeta";
      year.textContent = String(entry.year);
      card.appendChild(year);
    }

    const open = () => go(hashFor(entry.target));
    card.addEventListener("click", open);
    card.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        open();
      }
    });
    return card;
  }

  function continueProgress(entry) {
    const value = Number(entry?.progress);
    const duration = Number(entry?.duration);
    const position = Number(entry?.position);
    const derived = duration > 0 && position > 0 ? Math.min(1, position / duration) : 0;
    if (Number.isFinite(value) && value > 0) return Math.min(1, value);
    return derived;
  }

  function continueStatus(entry) {
    const selection = entry?.serialSelection || entry?.opravarSelection || null;
    const season = positiveInt(selection?.season);
    const episode = positiveInt(selection?.episode);
    const episodeLabel = season && episode ? `S${season}E${episode}` : "";
    const duration = Number(entry?.duration);
    const position = Number(entry?.position);
    const left = duration > 0
      ? Math.max(0, Math.ceil((duration - Math.max(0, position || 0)) / 60))
      : null;
    if (episodeLabel && left != null) return `${episodeLabel} · ${left} мин осталось`;
    if (episodeLabel) return episodeLabel;
    if (left != null) return `${left} мин осталось`;
    const progress = Math.round(continueProgress(entry) * 100);
    return progress > 0 ? `${progress}% просмотрено` : "Продолжить";
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
    let newdeafUnavailable = false;
    try {
      nd = await searchNewdeaf(ndQuery);
    } catch (error) {
      newdeafUnavailable = true;
      log("newdeaf-error", error.message);
    }
    if (isStale(token)) return;
    renderResults(nd, pk, query, { newdeafUnavailable });
    if (!pk.length && !nd.length) el.resultsTitle.textContent = "Ничего не найдено";
  }

  function pickNewdeafQuery(query, pkResults) {
    if (/[а-яё]/i.test(query)) return query;
    const ru = (pkResults || []).map((m) => m.name).find((name) => /[а-яё]/i.test(name || ""));
    return ru || query;
  }

  function renderResults(ndCandidates, pkResults, query, options = {}) {
    el.resultsGrid.replaceChildren();
    el.resultsTitle.textContent = "Результаты";
    // newdeaf first and prioritized: when a title is in both sources, the ad-free
    // Ortified path (newdeaf, with the embedded season/episode player) is the
    // preferred choice, so it leads the grid — same ordering as the old MVP.
    for (const item of ndCandidates) {
      const match = matchNewdeafMetadata(item, pkResults);
      if (match) cacheSet("ndenriched", item.url, match, TTL.enriched);
      const title = item.title || "Newdeaf";
      const target = { kind: "nd", pageUrl: item.url };
      const details = {
        title,
        year: match?.year || "",
        poster: match?.poster || item.poster || "",
        rating: match?.rating || {},
        movieLength: match?.movieLength || null,
        isSeries: match?.isSeries ?? false,
      };
      const card = makeCard({
        title,
        sub: [match?.year, match?.isSeries ? "сериал" : "Newdeaf"].filter(Boolean).join(" · "),
        poster: details.poster,
        rating: match?.rating,
        movieLength: match?.movieLength,
        isSeries: match?.isSeries,
        bookmark: { target, details },
        onClick: () => go(`/watch/nd/${encodeURIComponent(item.url)}`),
      });
      el.resultsGrid.appendChild(card);
    }
    for (const movie of pkResults) {
      if (movie.kpId == null) continue;
      const title = movieTitle(movie);
      const target = { kind: "kp", kpId: movie.kpId };
      const details = {
        title,
        year: movie.year || "",
        poster: movie.poster || "",
        rating: movie.rating || {},
        movieLength: movie.movieLength || null,
        isSeries: !!movie.isSeries,
      };
      const card = makeCard({
        title,
        sub: [movie.year, movie.isSeries ? "сериал" : "фильм"].filter(Boolean).join(" · "),
        poster: movie.poster,
        rating: movie.rating,
        movieLength: movie.movieLength,
        isSeries: movie.isSeries,
        bookmark: { target, details },
        onClick: () => go(`/watch/kp/${encodeURIComponent(movie.kpId)}`),
      });
      el.resultsGrid.appendChild(card);
    }
    if (options.newdeafUnavailable) {
      const note = document.createElement("p");
      note.className = "muted search-note";
      note.textContent = "Newdeaf не ответил этому браузеру — показаны остальные результаты.";
      el.resultsGrid.appendChild(note);
    }
    if (!pkResults.length && !ndCandidates.length) {
      const p = document.createElement("p");
      p.className = "muted";
      p.textContent = `Ничего не найдено по «${query}».`;
      el.resultsGrid.appendChild(p);
    }
    layoutMobileGrid(el.resultsGrid);
  }

  function makeCard({
    title,
    sub,
    poster,
    ratingPill,
    rating,
    movieLength,
    isSeries,
    bookmark,
    onBookmarkChange,
    onClick,
    onRemove,
  }) {
    const card = document.createElement("article");
    card.className = "card";
    card.tabIndex = 0;
    card.setAttribute("role", "button");
    const media = document.createElement("div");
    media.className = "card-media";
    const imageUrl = poster;
    if (imageUrl) {
      const img = document.createElement("img");
      img.className = "poster";
      img.loading = "lazy";
      img.src = imageUrl;
      img.alt = "";
      img.addEventListener("error", () => { img.replaceWith(blankPoster()); });
      media.appendChild(img);
    } else {
      media.appendChild(blankPoster());
    }
    if (ratingPill) {
      const pill = document.createElement("div");
      pill.className = "rating-pill";
      pill.textContent = ratingPill;
      media.appendChild(pill);
    }
    const hover = document.createElement("div");
    hover.className = "card-hover-meta";
    hover.setAttribute("aria-hidden", "true");
    hover.innerHTML = `
      <div class="hover-ratings">
        <div class="hover-rating">
          <span class="hover-rating-name">IMDb</span>
          <b class="hover-rating-value">${formatRating(rating?.imdb)}</b>
        </div>
        <i class="hover-rating-divider"></i>
        <div class="hover-rating">
          <span class="hover-rating-name">КП</span>
          <b class="hover-rating-value">${formatRating(rating?.kp)}</b>
        </div>
      </div>
      <div class="hover-duration">${formatDuration(movieLength, isSeries)}</div>
    `;
    media.appendChild(hover);
    if (bookmark?.target) {
      addCardBookmark(media, bookmark.target, bookmark.details, onBookmarkChange);
    }
    if (onRemove) {
      const x = document.createElement("button");
      x.className = "card-remove";
      x.type = "button";
      x.innerHTML = `<span class="card-remove-glyph" aria-hidden="true">×</span>`;
      x.addEventListener("click", (event) => { event.stopPropagation(); onRemove(); });
      media.appendChild(x);
    }
    card.appendChild(media);
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
    card.addEventListener("click", onClick);
    card.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        onClick();
      }
    });
    return card;
  }
  function blankPoster() {
    const d = document.createElement("div");
    d.className = "poster";
    return d;
  }

  function formatRating(value) {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? number.toFixed(1) : "—";
  }

  function formatDuration(value, isSeries = false) {
    const minutes = Math.round(Number(value));
    if (Number.isFinite(minutes) && minutes > 0) {
      if (minutes >= 60) {
        const hours = Math.floor(minutes / 60);
        const rest = minutes % 60;
        return `${hours} ч${rest ? ` ${rest} м` : ""}`;
      }
      return `${minutes} мин`;
    }
    return isSeries ? "СЕРИАЛ" : "—";
  }

  // =====================================================================
  // Watch dispatch
  // =====================================================================
  async function showWatch(r, token) {
    setView("watch");
    state.playerReady = false;
    state.currentMeta = null;
    state.zenithEmbedUrl = "";
    window.dispatchEvent(new CustomEvent("alphy:player-ready", { detail: { ready: false } }));
    el.metaPanel.classList.add("hidden");
    el.serialPanel.classList.add("hidden");
    el.trackPanel.classList.add("hidden");
    // Show the loading state immediately so the previous title's player is never
    // left on screen while the new one resolves (or fails to resolve).
    showPlayerLoading();
    if (r.kind === "kp") return playKp(r.raw, token);
    if (r.kind === "zen") return playZen(r.raw, token);
    if (r.kind === "ort") return playOrt(r.raw, token, null);
    if (r.kind === "opr") return playOpr(r.raw, token, null);
    if (r.kind === "nd") return playNd(r.raw, token);
    throw new Error("Неизвестный тип контента");
  }

  async function playKp(kpId, token, opts = {}) {
    let meta = opts.meta || cacheGet("meta", kpId);
    if (!meta) { meta = await fetchMovieMeta(kpId); if (isStale(token)) return; }
    if (meta) cacheSet("meta", kpId, meta, TTL.meta);
    const savedSelection = normalizeSerialHint(savedSerialSelection(`kp:${kpId}`));
    const requestedSelection = normalizeSerialHint(opts.serialSelection) || savedSelection;
    const isSeries = !!(opts.forceSeries || meta?.isSeries || requestedSelection);
    const serialSelection = requestedSelection || (isSeries ? { season: 1, episode: 1 } : null);
    const target = {
      kind: "kp",
      kpId,
      title: movieTitle(meta),
      poster: meta?.poster,
      year: meta?.year,
      isSeries,
    };
    state.currentTarget = target;
    setWatchHead(target.title || `kpId ${kpId}`, target);
    renderMeta(meta, target);
    recordOpen(target);

    const resolved = await resolveZona(kpId, serialSelection);
    if (isStale(token)) return;
    await playZenithEmbed(resolved.embedUrl, target, token, {
      histKey: `kp:${kpId}`,
      resume: resumePosition(`kp:${kpId}`),
      audioLang: savedAudioLang(`kp:${kpId}`),
      serialSelection,
      forceSeries: target.isSeries,
    });
  }

  async function playZen(zenithId, token) {
    const cachedMeta = cacheGet("curatedmeta", `zen:${zenithId}`) || storedMeta(`zen:${zenithId}`);
    const target = {
      kind: "zen",
      zenithId,
      title: cachedMeta?.title || `Zenith ${zenithId}`,
      poster: cachedMeta?.poster,
      year: cachedMeta?.year,
      isSeries: !!cachedMeta?.isSeries,
    };
    state.currentTarget = target;
    setWatchHead(target.title, target);
    if (cachedMeta) renderMeta(cachedMeta, target);
    else el.metaPanel.classList.add("hidden");
    recordOpen(target);
    const embedUrl = `https://api.zenithjs.ws/embed/movie/${encodeURIComponent(zenithId)}`;
    await playZenithEmbed(embedUrl, target, token, {
      histKey: `zen:${zenithId}`,
      resume: resumePosition(`zen:${zenithId}`),
      audioLang: savedAudioLang(`zen:${zenithId}`),
      serialSelection: savedSerialSelection(keyFor(target)),
    });
  }

  async function playOrt(embedUrl, token, ndMeta) {
    // ndMeta is only present on the first resolve (search -> newdeaf -> ortified).
    // On reopen (Continue/Bookmarks/direct URL) recover it from the persisted
    // newdeaf meta, then from the history/bookmark entry, so the sidebar + title
    // look the same as right after search instead of a bare "Ortified" player.
    const meta = ndMeta || cacheGet("ortmeta", embedUrl) || storedMeta(`ort:${embedUrl}`);
    const target = { kind: "ort", embedUrl, title: meta?.title, poster: meta?.poster, year: meta?.year };
    state.currentTarget = target;
    setWatchHead(target.title || "Ortified", target);
    if (meta && (meta.title || meta.poster || meta.description)) {
      renderMeta(meta, target);
    } else {
      el.metaPanel.classList.add("hidden");
    }
    recordOpen(target);
    await playOrtifiedCleanroom(embedUrl, target, token);
  }

  async function playOpr(playerUrl, token, ndMeta) {
    const meta = ndMeta || cacheGet("oprmeta", playerUrl) || storedMeta(`opr:${playerUrl}`);
    const pageUrl = meta?.pageUrl || "";
    const serialHint = normalizeSerialHint(meta?.serialSelection) ||
      newdeafSerialHint(meta?.title || "", pageUrl, playerUrl);
    const target = {
      kind: "opr",
      playerUrl,
      pageUrl,
      title: meta?.title,
      poster: meta?.poster,
      year: meta?.year,
      isSeries: !!(meta?.isSeries || serialHint),
    };
    state.currentTarget = target;
    setWatchHead(target.title || "Opravar", target);
    if (meta && (meta.title || meta.poster || meta.description)) {
      renderMeta(meta, target);
    } else {
      el.metaPanel.classList.add("hidden");
    }
    recordOpen(target);

    try {
      const resolved = await resolveOpravar(playerUrl, pageUrl);
      if (isStale(token)) return;
      const context = {
        playerUrl,
        pageUrl,
        base: resolved.base || "",
        playlist: resolved.playlist || [],
        selection: chooseOpravarSelection(
          resolved.playlist || [],
          (ndMeta ? serialHint : null) ||
            savedOpravarSelection(keyFor(target)) ||
            serialHint ||
            resolved.current,
        ),
      };
      const currentMatches = sameOpravarSelection(context.selection, resolved.current);
      const media = currentMatches
        ? resolved
        : await resolveOpravarVideo(playerUrl, context.selection.videoId, context.base);
      if (isStale(token)) return;
      await playOpravarMedia(media, context, target, token, currentMatches ? resumePosition(keyFor(target)) : 0);
    } catch (error) {
      if (isStale(token)) return;
      if (meta?.title) {
        log("opravar-fallback", { message: error.message, title: meta.title });
        return playZonaFallback(meta.title, meta.year, token, {
          meta,
          serialSelection: serialHint,
          forceSeries: target.isSeries,
        });
      }
      throw new Error("Плеер недоступен, а для резервного поиска не найдено название");
    }
  }

  async function playOpravarMedia(media, context, target, token, resume = 0) {
    if (!media?.source) throw new Error("Opravar не вернул HLS с открытым CORS");
    const selection = chooseOpravarSelection(context.playlist, context.selection);
    if (!selection?.videoId) throw new Error("Opravar не вернул выбранную серию/озвучку");
    context.selection = selection;
    persistOpravarSelection(target, selection, resume);
    await playShaka(media.source, "hls", token, {
      resume,
      opravar: context,
      textTracks: media.subtitles || [],
    });
    if (isStale(token)) return;
    startTracking(keyFor(target), target);
  }

  async function switchOpravarSelection(nextSelection) {
    const context = state.opravar;
    const target = state.currentTarget;
    if (!context || !target || target.kind !== "opr") return;
    const selection = chooseOpravarSelection(context.playlist, nextSelection);
    if (!selection?.videoId || sameOpravarSelection(selection, context.selection)) return;
    const token = resolveToken;
    await teardownPlayer();
    showPlayerLoading();
    try {
      const media = await resolveOpravarVideo(context.playerUrl, selection.videoId, context.base);
      if (isStale(token) || keyFor(state.currentTarget) !== keyFor(target)) return;
      await playOpravarMedia(media, { ...context, selection }, target, token, 0);
    } catch (error) {
      if (isStale(token)) return;
      if (target.title) {
        log("opravar-switch-fallback", { message: error.message, title: target.title });
        return playZonaFallback(target.title, target.year, token, {
          meta: state.currentMeta || target,
          serialSelection: {
            season: selection.season,
            episode: selection.episode,
          },
          forceSeries: true,
        });
      }
      showError(new Error("Не удалось переключить серию"));
    }
  }

  function persistOpravarSelection(target, selection, position = 0) {
    recordHistory({
      key: keyFor(target),
      kind: target.kind,
      target: cleanTarget(target),
      title: target.title || "",
      poster: target.poster || "",
      year: target.year || "",
      opravarSelection: {
        season: selection.season,
        episode: selection.episode,
        voiceId: selection.voiceId,
        videoId: selection.videoId,
      },
      position,
      duration: 0,
      progress: 0,
    });
  }

  async function switchZenithSelection(nextSelection) {
    const context = state.serial;
    const target = state.currentTarget;
    if (!context || context.provider !== "zenith" || !target || context.switching) return;
    const selection = chooseSerialSelection(context.seasons, nextSelection);
    if (!selection || sameSerialSelection(selection, context.selection)) return;
    const episode = findSerialEpisode(context.seasons, selection);
    const media = bestZenithSource(episode?.sources);
    if (!media) return;

    const token = resolveToken;
    const audioLang = state.player?.getVariantTracks?.().find((track) => track.active)?.language || savedAudioLang(keyFor(target));
    context.switching = true;
    renderTracks();
    await teardownPlayer();
    showPlayerLoading();
    persistSerialSelection(target, selection, true);

    try {
      if (isStale(token) || keyFor(state.currentTarget) !== keyFor(target)) return;
      const nextContext = { ...context, selection, switching: false };
      state.sources = episode.sources;
      await playShaka(media.url, media.kind, token, {
        resume: 0,
        audioLang,
        serial: nextContext,
      });
      if (isStale(token)) return;
      startTracking(context.histKey || keyFor(target), target);
    } catch (error) {
      if (isStale(token)) return;
      log("zenith-episode-refresh", { selection, message: error.message });
      try {
        await playZenithEmbed(context.embedUrl, target, token, {
          histKey: context.histKey || keyFor(target),
          resume: 0,
          audioLang,
          serialSelection: selection,
          forceWorker: true,
        });
      } catch (refreshError) {
        if (isStale(token)) return;
        showError(new Error("Не удалось загрузить выбранную серию"));
        log("zenith-episode-switch-error", { selection, message: refreshError.message });
      }
    }
  }

  function persistSerialSelection(target, selection, resetPlayback = false) {
    const entry = {
      key: keyFor(target),
      kind: target.kind,
      target: cleanTarget(target),
      title: target.title || "",
      poster: target.poster || "",
      year: target.year || "",
      serialSelection: {
        season: selection.season,
        episode: selection.episode,
      },
    };
    if (resetPlayback) {
      entry.position = 0;
      entry.duration = 0;
      entry.progress = 0;
    }
    recordHistory(entry);
  }

  async function playNd(pageUrl, token) {
    setWatchHead("Newdeaf…", { kind: "nd", pageUrl });
    const parsed = await resolveNewdeafPage(pageUrl);
    if (isStale(token)) return;
    const enriched = cacheGet("ndenriched", pageUrl);
    const serialHint = newdeafSerialHint(
      parsed.title || "",
      pageUrl,
      parsed.opravar[0] || "",
      parsed.allo[0] || "",
    );
    const ndMeta = mergeMetadata(
      { title: parsed.title, poster: parsed.poster, year: parsed.year, description: parsed.description },
      enriched,
    );
    if (serialHint) {
      ndMeta.isSeries = true;
      ndMeta.serialSelection = serialHint;
    }
    if (!ndMeta.rating?.kp && !ndMeta.rating?.imdb) {
      enrichNewdeafMetadata(ndMeta, pageUrl, token).catch(() => {});
    }

    if (parsed.ortified.length) {
      const embedUrl = parsed.ortified[0];
      // Persist the newdeaf meta keyed by the embed so a later reopen (which goes
      // straight to /watch/ort/<embedUrl>, never touching newdeaf again) can still
      // show poster/description/title in the sidebar.
      cacheSet("ortmeta", embedUrl, ndMeta, TTL.meta);
      // Upgrade the URL to the resolved Ortified target so this title never
      // touches newdeaf again (re-open / share / history all go direct).
      replaceHash(`/watch/ort/${encodeURIComponent(embedUrl)}`);
      return playOrt(embedUrl, token, ndMeta);
    }

    if (parsed.opravar.length) {
      const playerUrl = parsed.opravar[0];
      const oprMeta = { ...ndMeta, pageUrl };
      cacheSet("oprmeta", playerUrl, oprMeta, TTL.meta);
      replaceHash(`/watch/opr/${encodeURIComponent(playerUrl)}`);
      return playOpr(playerUrl, token, oprMeta);
    }

    // Allo-only or no player → Zona fallback via title -> kpId, then upgrade URL.
    return playZonaFallback(parsed.title, parsed.year, token, {
      meta: ndMeta,
      serialSelection: serialHint,
      forceSeries: !!(ndMeta.isSeries || serialHint),
    });
  }

  async function playZonaFallback(rawTitle, year, token, opts = {}) {
    const title = cleanMovieTitle(rawTitle || "");
    if (!title) throw new Error("Не найдено название для резервного поиска");
    let movie = opts.meta?.kpId ? opts.meta : null;
    if (!movie) {
      const results = await searchPoiskkino(title, year);
      if (isStale(token)) return;
      movie = chooseMovie(results, title, year);
    }
    if (!movie) throw new Error("PoiskKino не вернул kpId для Zona fallback");
    const meta = mergeMetadata(opts.meta || {}, movie);
    cacheSet("meta", movie.kpId, meta, TTL.meta);
    replaceHash(`/watch/kp/${encodeURIComponent(movie.kpId)}`);
    return playKp(String(movie.kpId), token, {
      meta,
      serialSelection: opts.serialSelection,
      forceSeries: !!(opts.forceSeries || meta.isSeries || opts.serialSelection),
    });
  }

  function mergeMetadata(base, enriched) {
    const left = base && typeof base === "object" ? base : {};
    const right = enriched && typeof enriched === "object" ? enriched : {};
    return {
      ...right,
      ...left,
      title: left.title || movieTitle(left) || right.title || movieTitle(right) || "",
      year: left.year || right.year || "",
      poster: left.poster || right.poster || "",
      backdrop: left.backdrop || right.backdrop || "",
      description: left.description || left.shortDescription || right.description || right.shortDescription || "",
      isSeries: left.isSeries ?? right.isSeries ?? false,
      movieLength: left.movieLength || right.movieLength || null,
      rating: {
        ...(right.rating || {}),
        ...(left.rating || {}),
      },
    };
  }

  async function enrichNewdeafMetadata(meta, pageUrl, token) {
    const cleanTitle = [...matchTitleTokens(meta?.title || "")].join(" ");
    if (!cleanTitle) return null;
    const results = await searchPoiskkino(cleanTitle, meta?.year);
    const match = matchNewdeafMetadata({ title: meta?.title, url: pageUrl }, results);
    if (!match) return null;
    cacheSet("ndenriched", pageUrl, match, TTL.enriched);
    if (isStale(token) || !state.currentTarget) return match;
    const merged = mergeMetadata(meta, match);
    state.currentMeta = merged;
    state.currentTarget.poster = merged.poster || state.currentTarget.poster;
    state.currentTarget.year = merged.year || state.currentTarget.year;
    state.currentTarget.isSeries = merged.isSeries;
    renderMeta(merged, state.currentTarget);
    if (state.currentTarget.kind === "ort") cacheSet("ortmeta", state.currentTarget.embedUrl, merged, TTL.enriched);
    if (state.currentTarget.kind === "opr") {
      cacheSet("oprmeta", state.currentTarget.playerUrl, {
        ...merged,
        pageUrl: state.currentTarget.pageUrl || pageUrl,
      }, TTL.enriched);
    }
    window.dispatchEvent(new CustomEvent("alphy:metadata", { detail: merged }));
    return match;
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
    state.currentMeta = mergeMetadata(state.currentMeta || {}, {
      ...meta,
      title,
      year,
      poster,
      description: desc,
      isSeries: meta.isSeries ?? target?.isSeries,
    });
    const sub = [year, meta.movieLength ? `${meta.movieLength} мин` : ""].filter(Boolean).join(" · ");
    let html = "";
    if (poster) html += `<div class="meta-poster"><img src="${escapeAttr(poster)}" alt=""></div>`;
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
    const posterHost = el.metaPanel.querySelector(".meta-poster");
    if (posterHost) {
      addCardBookmark(posterHost, target, {
        title,
        year,
        poster,
        rating: meta.rating || {},
        movieLength: meta.movieLength || null,
        isSeries: meta.isSeries ?? target?.isSeries ?? false,
      });
    }
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
    el.serialPanel.classList.add("hidden");
    el.trackPanel.classList.add("hidden");
    await new Promise((resolve) => {
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        resolve();
      };
      iframe.addEventListener("load", done, { once: true });
      setTimeout(done, 1800);
    });
    if (!isStale(token)) markPlayerReady();
    log("ortified", "cleanroom loaded", sanitized.stats);
  }

  // =====================================================================
  // Playback — Zenith via Shaka
  // =====================================================================
  async function playZenithEmbed(embedUrl, target, token, opts = {}) {
    if (isStale(token)) return;
    showPlayerLoading();
    state.zenithEmbedUrl = embedUrl;
    let parsed = { sources: {}, meta: {}, playlist: { current: null, seasons: [] } };
    if (!opts.forceWorker) {
      try {
        const html = await fetchThirdPartyText(embedUrl, { preferSandbox: false, label: "zenith" });
        if (isStale(token)) return;
        parsed = parseZenithEmbed(html);
      } catch (error) {
        log("zenith-browser-fallback", { message: error.message });
      }
    }
    const needsWorker =
      !parsed.sources.dash && !parsed.sources.hls && !parsed.sources.dasha ||
      ((opts.forceSeries || target?.isSeries || opts.serialSelection) && !parsed.playlist?.seasons?.length);
    if (opts.forceWorker || needsWorker) {
      parsed = await resolveZenithThroughWorker(embedUrl);
      if (isStale(token)) return;
    }

    const seasons = normalizeSerialSeasons(parsed.playlist?.seasons);
    const requested = opts.serialSelection || parsed.playlist?.current;
    const selection = chooseSerialSelection(seasons, requested);
    const episode = findSerialEpisode(seasons, selection);
    const sources = episode?.sources || parsed.sources;
    const media = bestZenithSource(sources);
    const serial = selection
      ? {
          provider: "zenith",
          embedUrl,
          histKey: opts.histKey || keyFor(target),
          seasons,
          selection,
          switching: false,
        }
      : null;

    state.sources = sources;
    state.audioNames = parsed.meta.audioNames || [];
    if (!media) throw new Error("Zenith embed не отдал dash/hls");
    if (selection) persistSerialSelection(target, selection);
    await playShaka(media.url, media.kind, token, {
      resume: opts.resume || 0,
      audioLang: opts.audioLang,
      serial,
    });
    if (isStale(token)) return;
    if (opts.histKey) startTracking(opts.histKey, target);
  }

  async function resolveZenithThroughWorker(embedUrl) {
    const id = embedUrl.match(/\/movie\/(\d+)/i)?.[1] || "";
    if (!id) throw new Error("Не удалось извлечь Zenith id");
    const data = await resolverJson(`/zenith?id=${encodeURIComponent(id)}`);
    if (!data.hasSources) throw new Error("Worker Zenith fallback не отдал источники");
    return {
      sources: data.sources || {},
      meta: data.meta || {},
      playlist: data.playlist || { current: null, seasons: [] },
    };
  }

  async function playShaka(url, kind, token, opts = {}) {
    if (isStale(token)) return;
    await teardownPlayer();
    state.opravar = opts.opravar || null;
    state.serial = opts.serial || null;
    resetSubtitleRequest();
    const video = document.createElement("video");
    video.controls = true;
    video.playsInline = true;
    video.autoplay = true;
    video.crossOrigin = "anonymous";
    video.playbackRate = state.playbackRate;
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
      abr: { enabled: false },
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
    for (const track of opts.textTracks || []) {
      try {
        await player.addTextTrackAsync(track.url, track.language || "und", "subtitles", "text/vtt", "", track.label || track.language || "subs");
      } catch (error) {
        log("subtitle-warn", track.url, error.message);
      }
    }
    // Restore saved озвучка (audio language) and resume position from history.
    if (opts.audioLang) { try { player.selectAudioLanguage(opts.audioLang); } catch { /* ignore */ } }
    selectHighestShakaVariant(player, opts.audioLang);
    if (opts.resume > 5) { try { video.currentTime = opts.resume; } catch { /* ignore */ } }
    video.playbackRate = state.playbackRate;
    renderTracks();
    markPlayerReady();
    const snapshotCurrentFrame = () => {
      const target = state.currentTarget;
      if (!target) return;
      setTimeout(() => captureVideoSnapshot(keyFor(target), target), 350);
    };
    video.addEventListener("loadeddata", snapshotCurrentFrame, { once: true });
    video.addEventListener("playing", snapshotCurrentFrame);
    video.addEventListener("pause", snapshotCurrentFrame);
    video.addEventListener("seeked", snapshotCurrentFrame);
    setTimeout(snapshotCurrentFrame, 2200);
    try { await video.play(); } catch { /* user gesture may be required */ }
  }

  function selectHighestShakaVariant(player, preferredLanguage = "") {
    const variants = player?.getVariantTracks?.() || [];
    if (!variants.length) return null;
    const active = variants.find((track) => track.active);
    const language = preferredLanguage || active?.language || "";
    const candidates = variants.filter((track) => !language || track.language === language);
    const best = [...(candidates.length ? candidates : variants)].sort(
      (a, b) => (b.height || 0) - (a.height || 0) || (b.bandwidth || 0) - (a.bandwidth || 0),
    )[0];
    if (!best) return null;
    player.configure({ abr: { enabled: false } });
    player.selectVariantTrack(best, true);
    return best;
  }

  function startTracking(histKey, target) {
    stopTracking();
    state.trackInterval = setInterval(() => {
      const v = state.videoEl;
      if (!v) return;
      const dur = v.duration;
      const cur = v.currentTime;
      if (!dur || !isFinite(dur) || dur <= 0) return;
      const audioLang = state.player?.getVariantTracks?.().find((t) => t.active)?.language;
      const entry = {
        key: histKey,
        kind: target.kind,
        target: cleanTarget(target),
        title: target.title || "",
        poster: target.poster || "",
        year: target.year || "",
        rating: state.currentMeta?.rating || undefined,
        movieLength: state.currentMeta?.movieLength || undefined,
        isSeries: state.currentMeta?.isSeries ?? target.isSeries ?? false,
        position: cur,
        duration: dur,
        progress: cur / dur,
      };
      if (audioLang) entry.audioLang = audioLang;
      recordHistory(entry);
      if (Date.now() - state.lastSnapshotAt > 20_000) {
        captureVideoSnapshot(histKey, target);
      }
    }, 5000);
  }
  function stopTracking() {
    if (state.trackInterval) { clearInterval(state.trackInterval); state.trackInterval = null; }
  }

  function markPlayerReady() {
    state.playerReady = true;
    window.dispatchEvent(new CustomEvent("alphy:player-ready", {
      detail: { ready: true },
    }));
  }

  function resetSubtitleRequest() {
    state.subtitleRequest = { loading: false, error: "", message: "" };
  }

  function revokeSubtitleObjectUrls() {
    for (const url of state.subtitleObjectUrls || []) {
      try { URL.revokeObjectURL(url); } catch { /* ignore */ }
    }
    state.subtitleObjectUrls = [];
    state.loadedSubs = [];
    state.subtitleOffset = 0;
    state.subtitleOffsetOpen = false;
    state.subtitleOffsetBusy = false;
    state.staleTextTrackIds = [];
  }

  function captureVideoSnapshot(histKey, target) {
    const video = state.videoEl;
    if (!video || !video.videoWidth || !video.videoHeight || video.readyState < 2) return;
    const width = Math.min(480, video.videoWidth);
    const height = Math.max(1, Math.round(width * 9 / 16));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d", { alpha: false });
    if (!context) return;
    const sourceRatio = video.videoWidth / video.videoHeight;
    const targetRatio = width / height;
    let sx = 0;
    let sy = 0;
    let sw = video.videoWidth;
    let sh = video.videoHeight;
    if (sourceRatio > targetRatio) {
      sw = video.videoHeight * targetRatio;
      sx = (video.videoWidth - sw) / 2;
    } else {
      sh = video.videoWidth / targetRatio;
      sy = (video.videoHeight - sh) / 2;
    }
    try {
      context.drawImage(video, sx, sy, sw, sh, 0, 0, width, height);
      const snapshot = canvas.toDataURL("image/jpeg", 0.58);
      state.lastSnapshotAt = Date.now();
      recordHistory({
        key: histKey,
        kind: target.kind,
        target: cleanTarget(target),
        title: target.title || state.currentMeta?.title || "",
        poster: target.poster || state.currentMeta?.poster || "",
        year: target.year || state.currentMeta?.year || "",
        snapshot,
      });
    } catch (error) {
      state.lastSnapshotAt = Date.now();
      log("snapshot-warn", error?.message || String(error));
    }
  }

  // Position reports from the Ortified cleanroom iframe (see progressHook). We can't
  // resume the embedded player, but we record where the viewer stopped so the
  // homepage card shows progress for Ortified titles too.
  function onOrtProgress(event) {
    const data = event.data || {};
    if (!data.alphyOrtProgress) return;
    const target = state.currentTarget;
    if (!target || target.kind !== "ort") return;
    const { position, duration, snapshot } = data;
    if (!duration || !isFinite(duration) || duration <= 0) return;
    recordHistory({
      key: keyFor(target),
      kind: "ort",
      target: cleanTarget(target),
      title: target.title || "",
      poster: target.poster || "",
      year: target.year || "",
      rating: state.currentMeta?.rating || undefined,
      movieLength: state.currentMeta?.movieLength || undefined,
      isSeries: state.currentMeta?.isSeries ?? target.isSeries ?? false,
      position,
      duration,
      progress: position / duration,
      ...(typeof snapshot === "string" && snapshot.startsWith("data:image/jpeg") ? { snapshot } : {}),
    });
  }

  async function teardownPlayer() {
    stopTracking();
    if (state.player) {
      await state.player.destroy().catch(() => {});
      state.player = null;
    }
    revokeSubtitleObjectUrls();
    resetSubtitleRequest();
    state.videoEl = null;
    state.opravar = null;
    state.serial = null;
    state.playerReady = false;
    window.dispatchEvent(new CustomEvent("alphy:player-ready", { detail: { ready: false } }));
    // Remove the old <iframe>/<video> from the DOM: stops its audio instantly and
    // guarantees a new resolve never leaves stale content on screen — even when the
    // new one errors before mounting (the "плеер залочен на старом контенте" bug).
    el.playerHost.replaceChildren();
    if (state.playerPlaceholder) el.playerHost.innerHTML = state.playerPlaceholder;
    el.serialPanel.replaceChildren();
    el.serialPanel.classList.add("hidden");
    el.trackPanel.replaceChildren();
    el.trackPanel.classList.add("hidden");
  }

  function showPlayerLoading() {
    el.playerHost.innerHTML = '<div class="placeholder"><div class="spinner"></div><span>Загрузка плеера…</span></div>';
  }

  function renderTracks() {
    const player = state.player;
    if (!player) return;
    el.serialPanel.replaceChildren();
    el.serialPanel.classList.add("hidden");
    el.trackPanel.replaceChildren();
    el.trackPanel.classList.remove("hidden");
    const variants = player.getVariantTracks ? player.getVariantTracks() : [];
    // Hide text tracks superseded by a shifted copy (Shaka 4.11 can't remove them).
    const texts = (player.getTextTracks ? player.getTextTracks() : [])
      .filter((track) => !state.staleTextTrackIds.includes(track.id));

    if (state.opravar) {
      renderOpravarControls(state.opravar);
    } else {
      if (state.serial?.provider === "zenith") renderZenithSerialControls(state.serial);
      const audioChoices = groupBy(variants, (track) => `${track.language || ""}|${(track.roles || []).join(",")}`);
      addTrackGroup("Озвучка", audioChoices, (track, index) => {
        const btn = document.createElement("button");
        btn.textContent = audioNameFor(track.language, index);
        if (track.active) btn.className = "active";
        btn.addEventListener("click", () => {
          player.selectAudioLanguage(track.language, (track.roles || [])[0]);
          selectHighestShakaVariant(player, track.language);
          persistAudio(track.language);
          setTimeout(renderTracks, 250);
        });
        return btn;
      });
    }

    const activeAudio = variants.find((track) => track.active)?.language || "";
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

    // Subtitle-sync control: a ⚙ button that reveals two nudge buttons. Only
    // shown once we have fetched subs whose raw text we can re-shift.
    const offsetItems = state.loadedSubs.length
      ? [{ settings: true }, ...(state.subtitleOffsetOpen ? [{ offset: -0.5 }, { offsetLabel: true }, { offset: 0.5 }] : [])]
      : [];
    const subtitleItems = texts.length
      ? [{ off: true }, ...texts, ...offsetItems]
      : [
          { request: true },
          ...(state.subtitleRequest.error ? [{ note: state.subtitleRequest.error }] : []),
        ];
    addTrackGroup("Субтитры", subtitleItems, (track) => {
      const btn = document.createElement("button");
      if (track.note) {
        const span = document.createElement("span");
        span.className = "muted subtitle-note";
        span.textContent = track.note;
        return span;
      }
      if (track.request) {
        btn.textContent = state.subtitleRequest.loading
          ? "ищу…"
          : state.subtitleRequest.error
            ? "повторить"
            : "запросить";
        btn.disabled = !!state.subtitleRequest.loading;
        if (state.subtitleRequest.error) btn.title = state.subtitleRequest.error;
        else if (state.subtitleRequest.message) btn.title = state.subtitleRequest.message;
        btn.addEventListener("click", requestSubtitles);
        return btn;
      }
      if (track.off) {
        btn.textContent = "Выкл";
        if (!player.isTextTrackVisible || !player.isTextTrackVisible()) btn.className = "active";
        btn.addEventListener("click", () => player.setTextTrackVisibility(false));
        return btn;
      }
      if (track.settings) {
        btn.textContent = "⚙ синхр.";
        btn.title = "Сдвиг субтитров, если они не совпадают с видео";
        if (state.subtitleOffsetOpen) btn.className = "active";
        btn.addEventListener("click", () => {
          state.subtitleOffsetOpen = !state.subtitleOffsetOpen;
          renderTracks();
        });
        return btn;
      }
      if (track.offsetLabel) {
        const span = document.createElement("span");
        span.className = "muted subtitle-note";
        const o = state.subtitleOffset;
        span.textContent = `${o > 0 ? "+" : ""}${o.toFixed(1)}с`;
        return span;
      }
      if (typeof track.offset === "number") {
        btn.textContent = track.offset < 0 ? "◀ −0,5с" : "+0,5с ▶";
        btn.title = track.offset < 0 ? "Субтитры раньше" : "Субтитры позже";
        btn.disabled = !!state.subtitleOffsetBusy;
        btn.addEventListener("click", () => applySubtitleOffset(track.offset));
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

    addTrackGroup("Скорость", [0.5, 1, 1.25, 1.5, 1.75, 2].map((s) => ({ speed: s })), (item) => {
      const btn = document.createElement("button");
      btn.textContent = `${item.speed}×`;
      if (item.speed === state.playbackRate) btn.className = "active";
      btn.addEventListener("click", () => {
        state.playbackRate = item.speed;
        try { localStorage.setItem("alphy.playbackRate", String(item.speed)); } catch { /* ignore */ }
        if (state.videoEl) state.videoEl.playbackRate = item.speed;
        setTimeout(renderTracks, 50);
      });
      return btn;
    });
  }

  async function requestSubtitles() {
    const player = state.player;
    const token = resolveToken;
    if (!player || state.subtitleRequest.loading) return;
    state.subtitleRequest = { loading: true, error: "", message: "Запрашиваю субтитры…" };
    renderTracks();

    try {
      const context = await resolveSubtitleSearchContext(token);
      if (isStale(token) || player !== state.player) return;
      if (!context?.id) throw new Error("Не найден IMDb/TMDB ID для поиска субтитров");

      let added = [];
      // Primary: OpenSubtitles v3, proxied through the resolver. Needs an IMDb id
      // and is RU-reachable — the Cloudflare-fronted subtitle hosts are not, but
      // the Deno resolver fetches them server-side and returns CORS-open text.
      if (context.idKind === "imdb" && state.resolverBaseUrl) {
        try {
          added = await addOpenSubtitlesToPlayer(player, context, token);
        } catch (error) {
          if (isStale(token) || player !== state.player) return;
          log("opensubs-warn", error.message);
        }
      }

      // Fallback: Wyzie (also accepts a TMDB id), only if the primary added nothing.
      if (!added.length) {
        if (isStale(token) || player !== state.player) return;
        const forceRefresh = !!state.subtitleRequest.error;
        const candidates = await fetchWyzieSubtitleCandidates(context, token, { forceRefresh });
        if (isStale(token) || player !== state.player) return;
        if (candidates.length) {
          added = await addWyzieSubtitlesToPlayer(player, candidates, token, { forceRefresh });
        }
      }

      if (isStale(token) || player !== state.player) return;
      if (!added.length) throw new Error("Субтитры не нашлись или не скачались в браузере");

      const texts = player.getTextTracks ? player.getTextTracks() : [];
      const first = texts.find((track) => added.some((item) => item.label === track.label && item.language === track.language)) || texts[0];
      if (first) {
        player.selectTextTrack(first);
        player.setTextTrackVisibility(true);
      }
      state.subtitleRequest = { loading: false, error: "", message: `Добавлено: ${added.map((item) => item.label).join(", ")}` };
      setTimeout(renderTracks, 100);
    } catch (error) {
      if (isStale(token) || player !== state.player) return;
      const message = subtitleErrorMessage(error);
      state.subtitleRequest = { loading: false, error: message, message: "" };
      log("subtitles-error", message);
      renderTracks();
    }
  }

  // --- Subtitle result cache, blob tracks, and offset/sync -----------------

  const subsMemoryCache = new Map();
  const SUBS_CACHE_NS = "subsv3";
  const SUBS_CACHE_MAX = 24;

  function subsCacheGet(key) {
    if (subsMemoryCache.has(key)) return subsMemoryCache.get(key);
    const stored = cacheGet(SUBS_CACHE_NS, key);
    if (Array.isArray(stored) && stored.length) {
      subsMemoryCache.set(key, stored);
      return stored;
    }
    return null;
  }

  function subsCacheSet(key, results) {
    subsMemoryCache.set(key, results);
    try {
      pruneSubsCache(SUBS_CACHE_MAX - 1);
      cacheSet(SUBS_CACHE_NS, key, results, TTL.subtitles);
    } catch { /* localStorage full — the in-memory cache still covers the session */ }
  }

  // Subtitle content is large (~50-150KB/title), so cap how many titles persist in
  // localStorage and evict the oldest, so the cache can never grow unbounded.
  function pruneSubsCache(max) {
    const prefix = `${CACHE_PREFIX}${SUBS_CACHE_NS}:`;
    const entries = [];
    for (let i = 0; i < localStorage.length; i += 1) {
      const k = localStorage.key(i);
      if (!k || !k.startsWith(prefix)) continue;
      let exp = 0;
      try { exp = JSON.parse(localStorage.getItem(k) || "{}").exp || 0; } catch { /* treat as oldest */ }
      entries.push({ k, exp });
    }
    if (entries.length <= max) return;
    entries.sort((a, b) => a.exp - b.exp);
    for (const entry of entries.slice(0, entries.length - max)) {
      try { localStorage.removeItem(entry.k); } catch { /* ignore */ }
    }
  }

  // Add a fetched subtitle to Shaka as a blob VTT track, recording its raw text +
  // Shaka track id so the offset control can re-render it shifted later.
  async function addLoadedSubtitle(player, { content, format, language, label }) {
    const vtt = shiftVtt(subtitleTextToVtt(content, format), state.subtitleOffset);
    const blobUrl = URL.createObjectURL(new Blob([vtt], { type: "text/vtt;charset=utf-8" }));
    state.subtitleObjectUrls.push(blobUrl);
    const track = await player.addTextTrackAsync(blobUrl, language, "subtitles", "text/vtt", "", label);
    state.loadedSubs.push({ language, label, content, format, trackId: track?.id ?? null });
    return track;
  }

  // Re-render every fetched subtitle with the new global offset. Shaka 4.11 has no
  // removeTextTrack, so the previous generation is hidden from the menu instead.
  async function applySubtitleOffset(delta) {
    const player = state.player;
    if (!player || !state.loadedSubs.length || state.subtitleOffsetBusy) return;
    state.subtitleOffsetBusy = true;
    try {
      state.subtitleOffset = clampOffset(state.subtitleOffset + delta);
      const activeLang = (player.getTextTracks?.() || []).find((t) => t.active)?.language
        || state.loadedSubs[0]?.language;

      for (const sub of state.loadedSubs) {
        if (sub.trackId != null) state.staleTextTrackIds.push(sub.trackId);
      }

      const regenerated = [];
      for (const sub of state.loadedSubs) {
        const vtt = shiftVtt(subtitleTextToVtt(sub.content, sub.format), state.subtitleOffset);
        const blobUrl = URL.createObjectURL(new Blob([vtt], { type: "text/vtt;charset=utf-8" }));
        state.subtitleObjectUrls.push(blobUrl);
        const track = await player.addTextTrackAsync(blobUrl, sub.language, "subtitles", "text/vtt", "", sub.label);
        regenerated.push({ ...sub, trackId: track?.id ?? null });
      }
      state.loadedSubs = regenerated;

      const pick = regenerated.find((s) => s.language === activeLang) || regenerated[0];
      const newTrack = (player.getTextTracks?.() || []).find((t) => t.id === pick?.trackId);
      if (newTrack) {
        player.selectTextTrack(newTrack);
        player.setTextTrackVisibility(true);
      }
    } catch (error) {
      log("subtitle-offset-warn", error.message);
    } finally {
      state.subtitleOffsetBusy = false;
      renderTracks();
    }
  }

  function clampOffset(seconds) {
    return Math.max(-60, Math.min(60, Math.round(seconds * 10) / 10));
  }

  // Shift every WEBVTT timestamp (cue start and end) by offsetSeconds, in integer
  // milliseconds so rounding can never produce an invalid ".1000" fraction.
  function shiftVtt(vtt, offsetSeconds) {
    if (!offsetSeconds) return vtt;
    const deltaMs = Math.round(offsetSeconds * 1000);
    return String(vtt).replace(/(\d{2,}):([0-5]\d):([0-5]\d)\.(\d{3})/g, (_, h, m, s, ms) => {
      let total = ((+h) * 3600 + (+m) * 60 + (+s)) * 1000 + (+ms) + deltaMs;
      if (total < 0) total = 0;
      const pad = (n, w = 2) => String(n).padStart(w, "0");
      return `${pad(Math.floor(total / 3600000))}:${pad(Math.floor((total % 3600000) / 60000))}:${pad(Math.floor((total % 60000) / 1000))}.${pad(total % 1000, 3)}`;
    });
  }

  // OpenSubtitles v3 via the resolver /subs proxy: it returns ready subtitle text
  // (CORS-open), which we convert to VTT and hand to Shaka as a blob track.
  async function addOpenSubtitlesToPlayer(player, context, token) {
    const type = context.season && context.episode ? "series" : "movie";
    const cacheKey = `${context.id}:${type}:${type === "series" ? `${context.season}:${context.episode}` : ""}:${WYZIE_LANGUAGES.join(",")}`;

    // Cache the resolver result (memory for the session + a bounded localStorage
    // copy), so re-opening an already-seen episode never hits the resolver again.
    let results = subsCacheGet(cacheKey);
    if (!results) {
      const params = new URLSearchParams({ imdb: context.id, type, lang: WYZIE_LANGUAGES.join(",") });
      if (type === "series") {
        params.set("season", String(context.season));
        params.set("episode", String(context.episode));
      }
      const data = await resolverJson(`/subs?${params}`);
      if (isStale(token) || player !== state.player) return [];
      results = Array.isArray(data?.results) ? data.results : [];
      if (results.length) subsCacheSet(cacheKey, results);
    }

    const added = [];
    const seenLabels = new Set();
    for (const item of results) {
      if (isStale(token) || player !== state.player) break;
      try {
        const label = uniqueSubtitleLabel(item.label || item.language || "Subs", seenLabels);
        seenLabels.add(label);
        await addLoadedSubtitle(player, { content: item.content, format: item.format, language: item.language || "und", label });
        added.push({ label, language: item.language || "und" });
      } catch (error) {
        log("opensubs-track-warn", { language: item.language, message: error.message });
      }
    }
    return added;
  }

  async function resolveSubtitleSearchContext(token) {
    const target = state.currentTarget || {};
    let meta = state.currentMeta || {};
    let kpId = target.kind === "kp" ? target.kpId : (meta.kpId || meta.kinopoiskId || meta.id);
    let external = subtitleExternalId(meta);

    if (!external.id && kpId) {
      const fresh = await fetchMovieMeta(kpId);
      if (isStale(token)) return null;
      if (fresh) {
        meta = mergeMetadata(meta, fresh);
        cacheSet("meta", kpId, meta, TTL.meta);
        state.currentMeta = meta;
        if (state.currentTarget) {
          state.currentTarget.poster = meta.poster || state.currentTarget.poster;
          state.currentTarget.year = meta.year || state.currentTarget.year;
          state.currentTarget.isSeries = meta.isSeries ?? state.currentTarget.isSeries;
          renderMeta(meta, state.currentTarget);
        }
        external = subtitleExternalId(meta);
      }
    }

    if (!external.id && !kpId) {
      const title = meta.title || movieTitle(meta) || target.title || "";
      if (title) {
        const results = await searchPoiskkino(cleanMovieTitle(title), meta.year || target.year);
        if (isStale(token)) return null;
        const movie = chooseMovie(results, title, meta.year || target.year);
        kpId = movie?.kpId;
        if (kpId) {
          const fresh = await fetchMovieMeta(kpId);
          if (isStale(token)) return null;
          meta = mergeMetadata(meta, fresh || movie);
          cacheSet("meta", kpId, meta, TTL.meta);
          state.currentMeta = meta;
          if (state.currentTarget) renderMeta(meta, state.currentTarget);
          external = subtitleExternalId(meta);
        }
      }
    }

    if (!external.id && kpId) {
      const externalId = await fetchWikidataExternalIds(kpId);
      if (isStale(token)) return null;
      if (externalId) {
        meta = mergeMetadata(meta, { kpId, externalId });
        state.currentMeta = meta;
        cacheSet("meta", kpId, meta, TTL.meta);
        if (state.currentTarget) renderMeta(meta, state.currentTarget);
        external = subtitleExternalId(meta);
      }
    }

    const selection = currentSubtitleSelection(meta, target);
    return {
      id: external.id,
      idKind: external.kind,
      kpId,
      title: meta.title || movieTitle(meta) || target.title || "",
      season: selection.season,
      episode: selection.episode,
    };
  }

  function currentSubtitleSelection(meta = {}, target = {}) {
    const selection = state.serial?.selection || state.opravar?.selection || savedSerialSelection(keyFor(target));
    const season = positiveInt(selection?.season);
    const episode = positiveInt(selection?.episode);
    if (!(meta.isSeries ?? target.isSeries) || !season || !episode) return {};
    return { season, episode };
  }

  function subtitleExternalId(meta = {}) {
    const external = meta.externalId || meta.externalIds || {};
    const imdb = compact(
      external.imdb ||
      external.imdbId ||
      meta.imdbId ||
      meta.externalImdbId ||
      "",
    );
    const tmdb = compact(
      external.tmdb ||
      external.tmdbId ||
      meta.tmdbId ||
      meta.externalTmdbId ||
      "",
    );
    if (/^tt\d{5,}$/i.test(imdb)) return { id: imdb, kind: "imdb" };
    if (/^\d+$/.test(tmdb)) return { id: tmdb, kind: "tmdb" };
    return { id: "", kind: "" };
  }

  async function fetchWikidataExternalIds(kpId) {
    const id = String(kpId || "").trim();
    if (!/^\d+$/.test(id)) return null;
    const cached = cacheGet("wikidataids", id);
    if (cached && typeof cached === "object") return cached;
    const query = `
SELECT ?imdb ?tmdbMovie ?tmdbTv WHERE {
  ?item wdt:P2603 "${id}".
  OPTIONAL { ?item wdt:P345 ?imdb. }
  OPTIONAL { ?item wdt:P4947 ?tmdbMovie. }
  OPTIONAL { ?item wdt:P4983 ?tmdbTv. }
}
LIMIT 1`;
    const url = `https://query.wikidata.org/sparql?${new URLSearchParams({ query, format: "json" })}`;
    try {
      const response = await fetchWithTimeout(url, {
        headers: { Accept: "application/sparql-results+json,application/json" },
      }, 12000);
      const data = JSON.parse(await response.text());
      if (!response.ok) throw new Error(`Wikidata ${response.status}`);
      const binding = data?.results?.bindings?.[0] || {};
      const externalId = {
        imdb: compact(binding.imdb?.value || ""),
        tmdb: compact(binding.tmdbMovie?.value || binding.tmdbTv?.value || ""),
      };
      if (!/^tt\d{5,}$/i.test(externalId.imdb)) delete externalId.imdb;
      if (!/^\d+$/.test(externalId.tmdb || "")) delete externalId.tmdb;
      if (!Object.keys(externalId).length) return null;
      cacheSet("wikidataids", id, externalId, TTL.enriched);
      return externalId;
    } catch (error) {
      log("wikidata-external-id-warn", { kpId: id, message: error.message });
      return null;
    }
  }

  async function fetchWyzieSubtitleCandidates(context, token, options = {}) {
    const cacheKey = [
      context.id,
      context.season || "movie",
      context.episode || "",
      WYZIE_LANGUAGES.join(","),
    ].join(":");
    const cached = options.forceRefresh ? null : cacheGet("wyziesubs", cacheKey);
    if (Array.isArray(cached) && cached.length) return cached;

    let lastError = null;
    for (const [index, key] of WYZIE_KEYS.entries()) {
      try {
        const sources = await fetchWyzieSources(key, index);
        if (isStale(token)) return [];
        const params = new URLSearchParams({
          id: context.id,
          language: WYZIE_LANGUAGES.join(","),
          format: "srt,vtt",
          key,
        });
        if (sources.length) params.set("source", sources.join(","));
        if (context.season) params.set("season", String(context.season));
        if (context.episode) params.set("episode", String(context.episode));
        if (options.forceRefresh) params.set("refresh", "true");

        const response = await fetchWithTimeout(`${WYZIE_BASE_URL}/search?${params}`, {
          headers: { Accept: "application/json" },
          cache: "no-store",
        }, 18000);
        const body = await response.text();
        let data;
        try { data = JSON.parse(body); } catch { data = { message: body }; }
        if (!response.ok) throw new Error(data?.details || data?.message || `Wyzie ${response.status}`);
        const items = normalizeWyzieResults(data);
        if (items.length) {
          cacheSet("wyziesubs", cacheKey, items, TTL.subtitles);
          return items;
        }
      } catch (error) {
        lastError = error;
        log("wyzie-search-warn", { keyIndex: index + 1, message: error.message });
      }
    }
    if (lastError) throw lastError;
    return [];
  }

  async function fetchWyzieSources(key, index) {
    const cacheKey = String(index + 1);
    const cached = cacheGet("wyziesources", cacheKey);
    if (Array.isArray(cached)) return cached;
    try {
      const response = await fetchWithTimeout(`${WYZIE_BASE_URL}/sources?key=${encodeURIComponent(key)}`, {
        headers: { Accept: "application/json" },
      }, 10000);
      const data = JSON.parse(await response.text());
      const sources = Array.isArray(data?.available) ? data.available.map(compact).filter(Boolean) : [];
      cacheSet("wyziesources", cacheKey, sources, TTL.subtitles);
      return sources;
    } catch (error) {
      log("wyzie-sources-warn", { keyIndex: index + 1, message: error.message });
      return ["charlie", "lima"];
    }
  }

  function normalizeWyzieResults(data) {
    return (Array.isArray(data) ? data : [])
      .map((item) => ({
        language: compact(item.language || item.lang || ""),
        display: compact(item.display || item.language || ""),
        source: compact(item.source || ""),
        format: compact(item.format || "srt").toLowerCase(),
        url: compact(item.url || item.download || ""),
        release: compact(item.release || item.filename || item.name || ""),
      }))
      .filter((item) => item.url && /^https:\/\//i.test(item.url));
  }

  async function addWyzieSubtitlesToPlayer(player, candidates, token, options = {}) {
    const added = [];
    const seenLabels = new Set();
    const ordered = orderWyzieCandidates(candidates);
    const perLanguageAdded = new Set();
    let attempts = 0;

    for (const item of ordered) {
      if (isStale(token) || player !== state.player) return added;
      const language = item.language || "und";
      if (perLanguageAdded.has(language)) continue;
      if (attempts >= 14 || added.length >= 3) break;
      attempts += 1;

      try {
        const downloadUrl = wyzieDownloadUrl(item, { cacheBust: options.forceRefresh });
        const raw = await fetchSubtitleText(downloadUrl);
        const label = uniqueSubtitleLabel(wyzieSubtitleLabel(item), seenLabels);
        seenLabels.add(label);
        await addLoadedSubtitle(player, { content: raw, format: item.format, language, label });
        added.push({ label, language });
        perLanguageAdded.add(language);
      } catch (error) {
        log("wyzie-download-warn", {
          language: item.language,
          source: item.source,
          message: error.message,
        });
      }
    }

    return added;
  }

  function orderWyzieCandidates(candidates) {
    const rankLanguage = (lang) => {
      const index = WYZIE_LANGUAGES.indexOf(String(lang || "").toLowerCase());
      return index === -1 ? 99 : index;
    };
    const rankSource = (source) => String(source || "") === "lima" ? 0 : 1;
    return [...candidates].sort((a, b) =>
      rankLanguage(a.language) - rankLanguage(b.language) ||
      rankSource(a.source) - rankSource(b.source) ||
      (a.release || "").length - (b.release || "").length
    );
  }

  function wyzieDownloadUrl(item, options = {}) {
    const url = item.url || "";
    const key = options.key || WYZIE_KEYS[0];
    // The Wyzie /c/ content proxy (and any sub.wyzie.io endpoint) needs the API
    // key as a `key` query param, exactly like /search and /sources. Without it
    // the proxy answers with an empty body, so the download silently fails and
    // the subtitle never reaches the player. This is the whole reason Wyzie subs
    // would not embed. The proxy returns CORS `access-control-allow-origin: *`,
    // so once the key is attached the fetch is fully client-side.
    const finalizeUrl = (value) => {
      try {
        const parsed = new URL(value);
        if (key && /(^|\.)wyzie\.io$/i.test(parsed.hostname) && !parsed.searchParams.has("key")) {
          parsed.searchParams.set("key", key);
        }
        if (options.cacheBust) parsed.searchParams.set("_", String(Date.now()));
        return parsed.href;
      } catch {
        return value;
      }
    };
    try {
      const parsed = new URL(url);
      if (/dl\.opensubtitles\.org$/i.test(parsed.hostname)) {
        const match = parsed.pathname.match(/\/vrf-([^/]+)\/file\/(\d+)/i);
        if (match) {
          const format = item.format === "vtt" ? "vtt" : "srt";
          return finalizeUrl(`${WYZIE_BASE_URL}/c/${encodeURIComponent(match[1])}/id/${encodeURIComponent(match[2])}?format=${format}&encoding=UTF-8`);
        }
      }
    } catch {
      // Use the original URL below; fetch will report the real failure.
    }
    return finalizeUrl(url);
  }

  async function fetchSubtitleText(url) {
    const response = await fetchWithTimeout(url, {
      headers: { Accept: "text/vtt,text/plain,*/*" },
      cache: "no-store",
    }, 20000);
    const text = await response.text();
    if (!response.ok) throw new Error(`download ${response.status}`);
    const clean = text.replace(/^\uFEFF/, "").trim();
    if (!clean) throw new Error("empty subtitle file");
    if (/^<!doctype html|<html[\s>]/i.test(clean)) throw new Error("download returned html");
    if (!/-->/m.test(clean) && !/^WEBVTT/i.test(clean)) throw new Error("not a subtitle file");
    return text;
  }

  function subtitleTextToVtt(text, format = "") {
    const clean = text.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();
    if (/^WEBVTT/i.test(clean)) return `${clean}\n`;
    if (/^\[Script Info\]/i.test(clean) || format === "ass") throw new Error("ASS subtitles are not supported in browser Shaka");
    const body = clean
      .replace(/(\d{1,2}:\d{2}:\d{2}),(\d{3})/g, "$1.$2")
      .replace(/\{\\an\d+\}/g, "")
      .replace(/\n{3,}/g, "\n\n");
    if (!/-->/m.test(body)) throw new Error("invalid subtitle timing");
    return `WEBVTT\n\n${body}\n`;
  }

  function wyzieSubtitleLabel(item) {
    const lang = String(item.language || "").toLowerCase();
    const display =
      lang === "ru" ? "Русские" :
      lang === "en" ? "English" :
      item.display || lang || "Subs";
    const source = item.source ? ` · ${item.source}` : "";
    return `${display}${source}`;
  }

  function uniqueSubtitleLabel(label, seen) {
    let value = label || "Subs";
    let index = 2;
    while (seen.has(value)) {
      value = `${label} ${index}`;
      index += 1;
    }
    return value;
  }

  function subtitleErrorMessage(error) {
    const message = String(error?.message || error || "");
    if (/IMDb\/TMDB/i.test(message)) return "Не найден IMDb/TMDB ID для Wyzie";
    if (/No subtitles found|не наш/i.test(message)) return "Wyzie не нашёл субтитры";
    if (/empty subtitle|download|cors|failed to fetch/i.test(message)) return "Субтитры найдены, но файл не скачался в браузере";
    return message || "Не удалось запросить субтитры";
  }

  async function fetchWithTimeout(url, init = {}, timeoutMs = 15000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetch(url, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  }

  function renderOpravarControls(context) {
    const seasons = context.playlist || [];
    const current = chooseOpravarSelection(seasons, context.selection);
    const season = seasons.find((item) => item.season === current?.season);
    const episode = season?.episodes.find((item) => item.episode === current?.episode);

    addTrackGroup("", seasons, (item) => {
      const btn = document.createElement("button");
      btn.textContent = `Сезон ${item.season}`;
      if (item.season === current?.season) btn.className = "active";
      btn.addEventListener("click", () => {
        const preferredEpisode =
          item.episodes.find((value) => value.episode === current?.episode) ||
          item.episodes.find((value) => value.episode > 0) ||
          item.episodes[0];
        switchOpravarSelection({ season: item.season, episode: preferredEpisode?.episode, voiceId: current?.voiceId });
      });
      return btn;
    }, { panel: el.serialPanel, hideLabel: true, className: "serial-seasons" });

    addTrackGroup("", season?.episodes || [], (item) => {
      const btn = document.createElement("button");
      btn.textContent = item.episode > 0 ? String(item.episode) : `S${Math.abs(item.episode)}`;
      if (item.episode === current?.episode) btn.className = "active";
      btn.addEventListener("click", () => {
        switchOpravarSelection({ season: current?.season, episode: item.episode, voiceId: current?.voiceId });
      });
      return btn;
    }, { panel: el.serialPanel, hideLabel: true, className: "serial-episodes" });

    addTrackGroup("Озвучка", episode?.voices || [], (item) => {
      const btn = document.createElement("button");
      btn.textContent = item.name || `Voice ${item.voiceId}`;
      if (item.voiceId === current?.voiceId) btn.className = "active";
      btn.addEventListener("click", () => {
        switchOpravarSelection({ season: current?.season, episode: current?.episode, voiceId: item.voiceId });
      });
      return btn;
    });
  }

  function renderZenithSerialControls(context) {
    const seasons = context.seasons || [];
    const current = chooseSerialSelection(seasons, context.selection);
    const season = seasons.find((item) => item.season === current?.season);

    addTrackGroup("", seasons, (item) => {
      const btn = document.createElement("button");
      btn.textContent = `Сезон ${item.season}`;
      btn.disabled = !!context.switching;
      if (item.season === current?.season) btn.className = "active";
      btn.addEventListener("click", () => {
        const sameEpisode = item.episodes.find((value) => value.episode === current?.episode);
        const episode = sameEpisode || item.episodes[0];
        switchZenithSelection({ season: item.season, episode: episode?.episode });
      });
      return btn;
    }, { panel: el.serialPanel, hideLabel: true, className: "serial-seasons" });

    addTrackGroup("", season?.episodes || [], (item) => {
      const btn = document.createElement("button");
      btn.textContent = String(item.episode);
      btn.disabled = !!context.switching;
      if (item.title) btn.title = item.title;
      if (item.episode === current?.episode) btn.className = "active";
      btn.addEventListener("click", () => {
        switchZenithSelection({ season: current?.season, episode: item.episode });
      });
      return btn;
    }, { panel: el.serialPanel, hideLabel: true, className: "serial-episodes" });
  }

  function addTrackGroup(title, items, renderButton, options = {}) {
    const panel = options.panel || el.trackPanel;
    const group = document.createElement("div");
    group.className = `track-group${options.className ? ` ${options.className}` : ""}`;
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
    if (!options.hideLabel) group.appendChild(label);
    group.appendChild(buttons);
    panel.appendChild(group);
    panel.classList.remove("hidden");
  }

  // =====================================================================
  // Engine: third-party fetch, newdeaf parsing, Zenith/Ortified parsing
  // (ported verbatim from the proven MVP — do not "simplify".)
  // =====================================================================
  function progressHook() {
    // We build the Ortified cleanroom srcdoc ourselves, so a script we inject runs
    // in the SAME document as the player's <video> and can read its position even
    // though the parent page can't reach a cross-origin iframe. We can't stop the
    // player resetting on reload, but we can report where the viewer stopped so the
    // homepage shows progress. Posts {alphyOrtProgress, position, duration} out.
    return `<script data-cleanroom="progress-hook">
(() => {
  const hooked = new WeakSet();
  let lastSent = 0;
  let lastShot = 0;
  const send = (v) => {
    const now = Date.now();
    if (now - lastSent < 4000) return;
    if (!v.duration || !isFinite(v.duration) || v.duration <= 0) return;
    lastSent = now;
    let snapshot = '';
    if (now - lastShot > 20000 && v.videoWidth && v.videoHeight) {
      lastShot = now;
      try {
        const width = Math.min(480, v.videoWidth), height = Math.max(1, Math.round(width * 9 / 16));
        const canvas = document.createElement('canvas');
        canvas.width = width; canvas.height = height;
        const ctx = canvas.getContext('2d', { alpha: false });
        const sourceRatio = v.videoWidth / v.videoHeight, targetRatio = width / height;
        let sx = 0, sy = 0, sw = v.videoWidth, sh = v.videoHeight;
        if (sourceRatio > targetRatio) { sw = v.videoHeight * targetRatio; sx = (v.videoWidth - sw) / 2; }
        else { sh = v.videoWidth / targetRatio; sy = (v.videoHeight - sh) / 2; }
        ctx.drawImage(v, sx, sy, sw, sh, 0, 0, width, height);
        snapshot = canvas.toDataURL('image/jpeg', 0.58);
      } catch (e) {}
    }
    try { parent.postMessage({ alphyOrtProgress: true, position: v.currentTime, duration: v.duration, snapshot }, '*'); } catch (e) {}
  };
  const hook = (v) => {
    if (hooked.has(v)) return; hooked.add(v);
    v.addEventListener('timeupdate', () => send(v));
    v.addEventListener('pause', () => { lastSent = 0; send(v); });
  };
  setInterval(() => { try { document.querySelectorAll('video').forEach(hook); } catch (e) {} }, 1500);
})();
<\/script>`;
  }

  async function fetchThirdPartyText(url, options = {}) {
    const preferSandbox = !!options.preferSandbox;
    const timeoutMs = options.timeoutMs || 30000;
    const sandboxTimeoutMs = options.sandboxTimeoutMs || timeoutMs;
    if (preferSandbox) {
      try {
        return await sandboxFetchText(url, options.label, sandboxTimeoutMs);
      } catch (error) {
        if (options.directFallback === false) throw error;
        log("fetch-warn", "sandbox fetch failed; trying direct CORS", { url, message: error.message });
      }
    }
    try {
      return await directFetchText(url, timeoutMs);
    } catch (error) {
      log("fetch-warn", "direct CORS fetch failed; trying XHR", { url, message: error.message });
    }
    try {
      return await xhrFetchText(url, timeoutMs);
    } catch (error) {
      if (!preferSandbox) {
        log("fetch-warn", "XHR failed; trying sandbox", { url, message: error.message });
        return sandboxFetchText(url, options.label, sandboxTimeoutMs);
      }
      throw error;
    }
  }

  function directFetchText(url, timeoutMs) {
    const controller = typeof AbortController === "function" ? new AbortController() : null;
    let timer = null;
    const operation = (async () => {
      const response = await fetch(url, {
        cache: "no-store",
        credentials: "omit",
        mode: "cors",
        referrerPolicy: "no-referrer",
        ...(controller ? { signal: controller.signal } : {}),
      });
      const text = await response.text();
      if (!response.ok) throw new Error(`Fetch ${response.status}`);
      return text;
    })();
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        controller?.abort();
        reject(new Error(`Direct fetch timeout for ${url}`));
      }, timeoutMs);
    });
    return Promise.race([operation, timeout]).finally(() => clearTimeout(timer));
  }

  function xhrFetchText(url, timeoutMs) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open("GET", url, true);
      xhr.withCredentials = false;
      xhr.timeout = timeoutMs;
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) resolve(xhr.responseText);
        else reject(new Error(`XHR ${xhr.status || "failed"}`));
      };
      xhr.onerror = () => reject(new Error(`XHR network error for ${url}`));
      xhr.ontimeout = () => reject(new Error(`XHR timeout for ${url}`));
      xhr.onabort = () => reject(new Error(`XHR aborted for ${url}`));
      try {
        xhr.send();
      } catch (error) {
        reject(error);
      }
    });
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
    if (!response.ok) throw new Error('Fetch ' + response.status);
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
      let title = cleanNewdeafTitle(compact(titleEl ? titleEl.textContent : (titleLink ? titleLink.textContent : "")));
      if (!title) title = cleanNewdeafTitle(compact(anyLink.getAttribute("title"))) || new URL(href).pathname.split("/").pop();
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

  function isNewdeafSearchDocument(html) {
    const text = String(html || "");
    if (text.length < 5000) return false;
    return /(?:id=["']quicksearch["']|name=["']story["'])/i.test(text) &&
      /(?:newdeaf|Новый мир глухих)/i.test(text);
  }

  function parseNewdeafPage(html, pageUrl) {
    const doc = new DOMParser().parseFromString(html, "text/html");
    const ortified = [];
    const opravar = [];
    const allo = [];
    const add = (list, value, re) => {
      const cleaned = cleanUrl(value, pageUrl);
      if (cleaned && re.test(cleaned) && !list.includes(cleaned)) list.push(cleaned);
    };
    for (const node of doc.querySelectorAll("iframe[src], [data-src], [data-url], [src]")) {
      const value = node.getAttribute("src") || node.getAttribute("data-src") || node.getAttribute("data-url");
      add(ortified, value, /^https:\/\/api\.ortified\.ws\/embed\//i);
      add(opravar, value, /^https:\/\/(?:gencit\.info|opravar\.online)\/bil\/\d+/i);
      add(allo, value, /^https:\/\/allo\.cdnlbox\.club\//i);
    }
    const text = html.replace(/&amp;/g, "&");
    for (const match of text.matchAll(/https:\/\/api\.ortified\.ws\/embed\/[^"'<>\s)]+/gi)) add(ortified, match[0], /^https:\/\/api\.ortified\.ws\/embed\//i);
    for (const match of text.matchAll(/https:\/\/(?:gencit\.info|opravar\.online)\/bil\/\d+[^"'<>\s)]*/gi)) add(opravar, match[0], /^https:\/\/(?:gencit\.info|opravar\.online)\/bil\/\d+/i);
    for (const match of text.matchAll(/https:\/\/allo\.cdnlbox\.club\/[^"'<>\s)]+/gi)) add(allo, match[0], /^https:\/\/allo\.cdnlbox\.club\//i);

    const title = cleanNewdeafTitle(
      compact(doc.querySelector('meta[property="og:title"]')?.getAttribute("content")) ||
      compact(doc.querySelector("h1")?.textContent) ||
      compact(doc.querySelector("title")?.textContent)
    );
    const description =
      compact(doc.querySelector('meta[property="og:description"]')?.getAttribute("content")) ||
      compact(doc.querySelector('meta[name="description"]')?.getAttribute("content"));
    const poster = cleanUrl(doc.querySelector('meta[property="og:image"], meta[name="og:image"]')?.getAttribute("content"), pageUrl);
    const year = extractYear(`${title} ${description} ${pageUrl}`);
    return { title, description, poster, year, ortified, opravar, allo };
  }

  function parseZenithEmbed(html) {
    const text = String(html || "");
    const sources = {};
    for (const match of text.matchAll(/\b(dash|dasha|hls)\s*:\s*("(?:(?:\\.|[^"\\])*)"|'(?:(?:\\.|[^'\\])*)')/g)) {
      sources[match[1]] = decodeJsString(match[2]).replace(/&amp;/g, "&");
    }
    const fallbackText = text.replace(/\\\//g, "/").replace(/&amp;/g, "&");
    if (!sources.dash) sources.dash = firstUrl(fallbackText, /\.mpd(?:\?|$)/i);
    if (!sources.hls) sources.hls = firstUrl(fallbackText, /(?:\.m3u8|master\.m3u8)(?:\?|$)/i);
    const playlist = parseZenithPlaylist(text);
    const currentEpisode = findSerialEpisode(playlist.seasons, playlist.current);
    if (currentEpisode) Object.assign(sources, currentEpisode.sources);
    const titleMatch = text.match(/\btitle\s*:\s*("(?:(?:\\.|[^"\\])*)"|'(?:(?:\\.|[^'\\])*)')/);
    const audioMatch = text.match(/\baudio\s*:\s*\{\s*["']?names["']?\s*:\s*\[([^\]]*)\]/);
    return {
      sources,
      meta: {
        title: titleMatch ? decodeJsString(titleMatch[1]) : "",
        audioNames: audioMatch ? [...audioMatch[1].matchAll(/"([^"]+)"|'([^']+)'/g)].map((m) => m[1] || m[2]) : [],
      },
      playlist,
    };
  }

  function parseZenithPlaylist(text) {
    const playlistMatch = /\bplaylist\s*:\s*\{/.exec(text);
    if (!playlistMatch) return { current: null, seasons: [] };
    const tail = text.slice(playlistMatch.index);
    const seasonsMatch = /\bseasons\s*:\s*\[/.exec(tail);
    if (!seasonsMatch) return { current: null, seasons: [] };
    const arrayStart = playlistMatch.index + seasonsMatch.index + seasonsMatch[0].lastIndexOf("[");
    const arrayText = balancedJsContainer(text, arrayStart, "[", "]");
    if (!arrayText) return { current: null, seasons: [] };

    let rawSeasons;
    try {
      rawSeasons = JSON.parse(arrayText);
    } catch {
      return { current: null, seasons: [] };
    }
    const beforeSeasons = text.slice(playlistMatch.index, arrayStart);
    const currentMatch = beforeSeasons.match(
      /\bcurrent\s*:\s*\{\s*season\s*:\s*(\d+)\s*,\s*episode\s*:\s*(?:"([^"]+)"|'([^']+)'|(\d+))/,
    );
    return {
      current: currentMatch
        ? { season: Number(currentMatch[1]), episode: Number(currentMatch[2] || currentMatch[3] || currentMatch[4]) }
        : null,
      seasons: normalizeSerialSeasons(rawSeasons),
    };
  }

  function balancedJsContainer(text, start, open, close) {
    if (text[start] !== open) return "";
    let depth = 0;
    let quote = "";
    let escaped = false;
    for (let index = start; index < text.length; index += 1) {
      const char = text[index];
      if (quote) {
        if (escaped) escaped = false;
        else if (char === "\\") escaped = true;
        else if (char === quote) quote = "";
        continue;
      }
      if (char === '"' || char === "'" || char === "`") {
        quote = char;
        continue;
      }
      if (char === open) depth += 1;
      else if (char === close) {
        depth -= 1;
        if (depth === 0) return text.slice(start, index + 1);
      }
    }
    return "";
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
    out = out.replace(/<head([^>]*)>/i, `<head$1>${adBlockPrelude()}${progressHook()}<style>html,body{margin:0;background:#000;min-height:100%;height:100%;overflow:hidden;}</style>`);
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
  function normalizeSerialSeasons(value) {
    return (Array.isArray(value) ? value : [])
      .map((season) => ({
        season: positiveInt(season?.season ?? season?.number),
        episodes: (Array.isArray(season?.episodes) ? season.episodes : [])
          .map((episode) => ({
            episode: positiveInt(episode?.episode ?? episode?.number ?? episode?.episodeNumber),
            title: compact(episode?.title || episode?.name || episode?.nameRu || episode?.nameEn || ""),
            id: positiveInt(episode?.id),
            videoKey: positiveInt(episode?.videoKey),
            sources: zenithEpisodeSources(episode?.sources || episode),
          }))
          .filter((episode) => episode.episode && Object.keys(episode.sources).length)
          .sort((a, b) => a.episode - b.episode),
      }))
      .filter((season) => season.season && season.episodes.length)
      .sort((a, b) => a.season - b.season);
  }

  function chooseSerialSelection(seasons, requested) {
    const list = normalizeSerialSeasons(seasons);
    if (!list.length) return null;
    const season = list.find((item) => item.season === positiveInt(requested?.season)) || list[0];
    const episode =
      season.episodes.find((item) => item.episode === positiveInt(requested?.episode)) ||
      season.episodes[0];
    return episode ? { season: season.season, episode: episode.episode } : null;
  }

  function sameSerialSelection(a, b) {
    return !!a && !!b &&
      Number(a.season) === Number(b.season) &&
      Number(a.episode) === Number(b.episode);
  }

  function positiveInt(value) {
    const parsed = Number.parseInt(String(value ?? ""), 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  }

  function normalizeSerialHint(value) {
    const season = positiveInt(value?.season);
    const episode = positiveInt(value?.episode);
    if (!season && !episode) return null;
    return {
      ...(season ? { season } : {}),
      ...(episode ? { episode } : {}),
    };
  }

  // Newdeaf has a separate result/page for each season, while the fallback
  // providers expose one combined serial playlist. Preserve the page's explicit
  // season/episode instead of letting Zenith/Opravar pick an unrelated
  // playlist.current. Query parameters are authoritative; title/path patterns
  // cover Allo-only pages that have no selectable player query.
  function newdeafSerialHint(...values) {
    let season = null;
    let episode = null;
    const textParts = [];
    for (const value of values) {
      const text = String(value || "");
      if (!text) continue;
      textParts.push(text);
      try {
        const url = new URL(text);
        season ||= positiveInt(url.searchParams.get("season"));
        episode ||= positiveInt(url.searchParams.get("episode"));
        textParts.push(decodeURIComponent(url.pathname.replace(/[+_-]+/g, " ")));
      } catch {
        // A title is expected to land here.
      }
    }

    const text = compact(textParts.join(" "));
    season ||= positiveInt(
      text.match(/\b(?:сезон|season|sezon)\s*(?:№|#|:|-)?\s*(\d{1,3})\b/i)?.[1] ||
      text.match(/\b(\d{1,3})\s*(?:сезон|season|sezon)\b/i)?.[1] ||
      text.match(/(?:^|[\s/_-])s(?:eason|ezon)?[\s_-]?(\d{1,3})(?:$|[\s/_.-])/i)?.[1],
    );
    episode ||= positiveInt(
      text.match(/\b(?:серия|эпизод|episode|seriya|epizod|ep)\s*(?:№|#|:|-)?\s*(\d{1,4})\b/i)?.[1] ||
      text.match(/\b(\d{1,4})\s*(?:серия|эпизод|episode|seriya|epizod)\b/i)?.[1] ||
      text.match(/(?:^|[\s/_.-])e(?:p(?:isode)?)?[\s_-]?(\d{1,4})(?:$|[\s/_.-])/i)?.[1],
    );
    return normalizeSerialHint({ season, episode });
  }

  function zenithEpisodeSources(value) {
    const sources = {};
    for (const key of ["dash", "dasha", "hls"]) {
      const url = String(value?.[key] || "").replace(/&amp;/g, "&");
      if (/^https:\/\//i.test(url)) sources[key] = url;
    }
    return sources;
  }

  function findSerialEpisode(seasons, selection) {
    const season = (Array.isArray(seasons) ? seasons : []).find((item) => item.season === selection?.season);
    return season?.episodes.find((item) => item.episode === selection?.episode) || null;
  }

  function bestZenithSource(sources) {
    if (sources?.dash) return { url: sources.dash, kind: "dash" };
    if (sources?.hls) return { url: sources.hls, kind: "hls" };
    if (sources?.dasha) return { url: sources.dasha, kind: "dasha" };
    return null;
  }

  function chooseOpravarSelection(playlist, requested) {
    const seasons = Array.isArray(playlist) ? playlist : [];
    if (!seasons.length) return null;
    const season = seasons.find((item) => item.season === Number(requested?.season)) || seasons[0];
    const positiveEpisodes = season.episodes.filter((item) => item.episode > 0);
    const episode =
      season.episodes.find((item) => item.episode === Number(requested?.episode)) ||
      positiveEpisodes[0] ||
      season.episodes[0];
    if (!episode) return null;
    const voice =
      episode.voices.find((item) => item.voiceId === Number(requested?.voiceId)) ||
      episode.voices.find((item) => item.voiceId === 2) ||
      episode.voices[0];
    if (!voice) return null;
    return {
      season: season.season,
      episode: episode.episode,
      voiceId: voice.voiceId,
      videoId: voice.videoId,
      voiceName: voice.name,
    };
  }

  function sameOpravarSelection(a, b) {
    return !!a && !!b &&
      Number(a.season) === Number(b.season) &&
      Number(a.episode) === Number(b.episode) &&
      Number(a.voiceId) === Number(b.voiceId) &&
      (!a.videoId || !b.videoId || Number(a.videoId) === Number(b.videoId));
  }

  function chooseMovie(results, title, year) {
    if (!Array.isArray(results) || !results.length) return null;
    const normalized = normalizeTitle(title);
    return results.find((movie) => year && String(movie.year) === String(year) && normalizeTitle(movieTitle(movie)).includes(normalized.slice(0, 12))) ||
      results.find((movie) => year && String(movie.year) === String(year)) ||
      results[0];
  }

  function matchNewdeafMetadata(item, movies) {
    if (!item?.title || !Array.isArray(movies) || !movies.length) return null;
    const wanted = matchTitleTokens(item.title);
    if (!wanted.size) return null;
    let best = null;
    let bestScore = 0;
    for (const movie of movies) {
      const names = [movieTitle(movie), movie?.alternativeName, movie?.enName].filter(Boolean);
      let score = 0;
      for (const name of names) {
        const candidate = matchTitleTokens(name);
        if (!candidate.size) continue;
        const intersection = [...wanted].filter((token) => candidate.has(token)).length;
        const union = new Set([...wanted, ...candidate]).size;
        const jaccard = union ? intersection / union : 0;
        const left = [...wanted].join("");
        const right = [...candidate].join("");
        const containment = left === right ? 1 : left.includes(right) || right.includes(left) ? 0.86 : 0;
        score = Math.max(score, jaccard, containment);
      }
      const pageYear = extractYear(`${item.title} ${item.url}`);
      if (pageYear && String(movie?.year || "") === pageYear) score += 0.1;
      if (score > bestScore) {
        best = movie;
        bestScore = score;
      }
    }
    return bestScore >= 0.54 ? best : null;
  }

  function matchTitleTokens(value) {
    const cleaned = compact(value)
      .replace(/\([^)]*\b(?:сезон|season)\b[^)]*\)/gi, " ")
      .replace(/\b\d+\s*(?:сезон|season)\b/gi, " ")
      .replace(/\b(?:русские?|english|английские?)\s+субтитры\b/gi, " ")
      .replace(/\b(?:субтитры|subtitle[sd]?|смотреть|онлайн|online)\b/gi, " ")
      .replace(/\b(?:19|20)\d{2}\b/g, " ")
      .toLowerCase()
      .replace(/ё/g, "е")
      .replace(/[^a-zа-я0-9]+/gi, " ")
      .trim();
    return new Set(cleaned.split(/\s+/).filter((token) => token.length > 1));
  }

  function cleanNewdeafTitle(value) {
    // newdeaf's og:title is promo-padded ("… - смотреть онлайн с субтитрами").
    // Strip that tail so the player shows a clean name; keep season info.
    return compact(value)
      .replace(/\s*[-–—]\s*смотреть\s+онлайн.*$/i, "")
      .replace(/\s*смотреть\s+онлайн.*$/i, "")
      .replace(/\s*[-–—]\s*newdeaf.*$/i, "")
      .trim();
  }

  function cleanMovieTitle(value) {
    return compact(value)
      .replace(/^(фильм|сериал|мультфильм|аниме|мультсериал)\s+/i, "")
      .replace(/\([^)]*\b(?:сезон|season|sezon)\b[^)]*\)/gi, " ")
      .replace(/\b\d+\s*(?:сезон|season|sezon)\b/gi, " ")
      .replace(/\b(?:русские?|english|английские?)\s+субтитры\b/gi, " ")
      .replace(/\b(?:субтитры|subtitle[sd]?)\b/gi, " ")
      .replace(/\s*\((?:19|20)\d{2}\).*$/, "")
      .replace(/\s*смотреть.*$/i, "")
      .replace(/\s*[-–—]\s*$/, "")
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
        if (/^(?:gencit\.info|opravar\.online)$/i.test(url.host) && /^\/bil\/\d+/i.test(url.pathname)) {
          return go(`/watch/opr/${encodeURIComponent(value)}`);
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

  function currentCuratedItem() {
    const current = state.currentTarget;
    const meta = state.currentMeta || {};
    if (!state.playerReady || !current) return null;
    let target = cleanTarget(current);
    const zenithId = state.zenithEmbedUrl.match(/\/movie\/(\d+)/i)?.[1];
    if (zenithId) target = { kind: "zen", zenithId };
    const title = meta.title || movieTitle(meta) || current.title || "";
    if (!title) return null;
    return {
      id: crypto?.randomUUID?.() || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`,
      key: keyFor(target),
      title,
      year: meta.year || current.year || "",
      poster: meta.poster || current.poster || "",
      backdrop: typeof meta.backdrop === "string" ? meta.backdrop : meta.backdrop?.url || "",
      description: meta.description || meta.shortDescription || "",
      isSeries: meta.isSeries ?? current.isSeries ?? !!state.serial,
      movieLength: meta.movieLength || null,
      rating: {
        ...(meta.rating || {}),
      },
      kpId: meta.kpId || current.kpId || "",
      externalId: {
        ...(meta.externalId || meta.externalIds || {}),
      },
      target,
      cachedAt: new Date().toISOString(),
    };
  }

  function openCuratedItem(item) {
    const target = item?.target;
    if (!target?.kind) return;
    const meta = {
      title: item.title,
      year: item.year,
      poster: item.poster,
      backdrop: item.backdrop,
      description: item.description,
      isSeries: item.isSeries,
      movieLength: item.movieLength,
      rating: item.rating,
      kpId: item.kpId,
      externalId: item.externalId,
    };
    cacheSet("curatedmeta", keyFor(target), meta, TTL.enriched);
    if (target.kind === "ort") cacheSet("ortmeta", target.embedUrl, meta, TTL.enriched);
    if (target.kind === "opr") {
      cacheSet("oprmeta", target.playerUrl, { ...meta, pageUrl: target.pageUrl || "" }, TTL.enriched);
    }
    if (target.kind === "kp") cacheSet("meta", target.kpId, { ...meta, kpId: target.kpId }, TTL.enriched);
    go(hashFor(target));
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
    const savedRate = parseFloat(localStorage.getItem("alphy.playbackRate") || "1");
    if ([0.5, 1, 1.25, 1.5, 1.75, 2].includes(savedRate)) state.playbackRate = savedRate;

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

    el.logoBtn.addEventListener("click", (event) => {
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      event.preventDefault();
      go("/");
    });
    el.searchBtn.addEventListener("click", onSearchSubmit);
    el.searchInput.addEventListener("keydown", (e) => { if (e.key === "Enter") onSearchSubmit(); });
    el.bookmarksToggle.addEventListener("click", () => go("/bookmarks"));
    el.saveResolverBtn.addEventListener("click", saveResolver);
    el.healthBtn.addEventListener("click", () => testResolver());
    window.addEventListener("hashchange", route);
    window.addEventListener("storage", (event) => {
      if (event.key !== STORE_BOOKMARKS) return;
      updateBookmarksNav();
      syncBookmarkControls();
      if (parseHash().view === "bookmarks") showBookmarks();
    });
    window.addEventListener("message", onOrtProgress);
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

    updateBookmarksNav();
    route();
  }

  // Resolve a title to its real Kinopoisk poster URL (avatars.mds.yandex.net),
  // so the catalog can replace a poster whose host is blocked in RU. Matching is
  // by title+year (the item key's number is a zona id, not a Kinopoisk id, so it
  // cannot be used). Reuses searchPoiskkino's localStorage cache.
  async function resolvePosterByTitle(title, year) {
    try {
      const results = await searchPoiskkino(cleanMovieTitle(title), year);
      const movie = chooseMovie(results, title, year);
      return movie?.poster ? String(movie.poster) : "";
    } catch {
      return "";
    }
  }

  // Best EXACT-title match among search hits (year is a soft tie-breaker, since
  // stored years are unreliable). Returning only exact matches keeps a Force
  // update from ever baking in a wrong cover/rating.
  function pickExactMovie(results, title, year) {
    if (!Array.isArray(results) || !results.length) return null;
    const want = normalizeTitle(title);
    const exact = results.filter((m) =>
      [movieTitle(m), m.alternativeName, m.enName]
        .filter(Boolean).map(normalizeTitle).includes(want));
    if (!exact.length) return null;
    return (year && exact.find((m) => String(m.year) === String(year))) || exact[0];
  }

  // A RU-reachable Kinopoisk poster: prefer an already-Yandex URL, else the
  // deterministic st.kp poster (301s to avatars.mds.yandex.net) built from the
  // real kpId. Never returns the unofficial API's kinopoiskapiunofficial.tech host.
  function kinopoiskPosterUrl(...candidates) {
    for (const c of candidates) {
      const u = c?.poster || "";
      try { if (/(^|\.)yandex\.net$/.test(new URL(u).hostname)) return u; } catch { /* not a URL */ }
    }
    const kpId = candidates.find((c) => /^\d+$/.test(String(c?.kpId)))?.kpId;
    return kpId ? `https://st.kp.yandex.net/images/film_iphone/iphone360_${kpId}.jpg` : "";
  }

  // Re-resolve cover + rating for an existing curated item by title, WITHOUT
  // touching its target (player/links). The /movie detail endpoint recovers the
  // IMDb rating + imdbId even when /search has fallen back to the unofficial API
  // (whose search hits carry no IMDb). Returns ok:false when no exact match.
  async function resolveCardMeta(title, year) {
    try {
      const results = await searchPoiskkino(cleanMovieTitle(title), "");
      const hit = pickExactMovie(results, title, year);
      if (!hit?.kpId) return { ok: false };
      const detail = await fetchMovieMeta(hit.kpId);
      const m = detail || hit;
      const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);
      return {
        ok: true,
        kpId: hit.kpId,
        poster: kinopoiskPosterUrl(m, hit),
        rating: { kp: num(m.rating?.kp) ?? num(hit.rating?.kp), imdb: num(m.rating?.imdb) ?? num(hit.rating?.imdb) },
        imdbId: m.externalId?.imdb || hit.externalId?.imdb || "",
        name: movieTitle(m) || title,
        year: m.year || hit.year || year || "",
      };
    } catch {
      return { ok: false };
    }
  }

  window.alphyBridge = {
    getCurrentCuratedItem: currentCuratedItem,
    openCuratedItem,
    addCardBookmark,
    layoutMobileGrid,
    resolvePosterByTitle,
    resolveCardMeta,
  };

  boot();
})();
