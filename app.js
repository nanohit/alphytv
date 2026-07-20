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

  // Keep in sync with the <title> in index.html — that one covers the first paint
  // and anything that reads the page without running JS; this one covers every
  // client-side route change afterwards.
  const SITE_TITLE = "Alphy TV — каталог фильмов и сериалов.";

  const STORE_RESOLVER = "alphy.resolverBaseUrl";
  const STORE_BOOKMARKS = "alphy.bookmarks";
  const STORE_HISTORY = "alphy.history";
  const CACHE_PREFIX = "alphy.cache.";
  // Older builds cached a transient empty Newdeaf result for six hours. Keep
  // this namespace versioned so those false misses cannot survive an upgrade.
  const ND_SEARCH_CACHE_NS = "ndsearch.v2";
  const SHAKA_SCRIPT_URL = "https://cdn.jsdelivr.net/npm/shaka-player@4.11.17/dist/shaka-player.compiled.js";
  const HLS_SCRIPT_URL = "https://cdn.jsdelivr.net/npm/hls.js@1.5.17/dist/hls.min.js";
  const SOAP_CDN_ORIGIN = "https://cdn-r11.soap4youand.me";
  const COLLAPS_BASE_URL = "https://plapi.cdnvideohub.com/api/v1/player/sv";
  const COLLAPS_PREVIEW_LIMIT = 1;
  const COLLAPS_PREVIEW_IDLE_TIMEOUT = 3500;
  const COLLAPS_PREVIEW_COOLDOWN_MS = 20 * 60e3;
  const COLLAPS_FAST_PATH_TIMEOUT_MS = 1400;
  const ZENITH_BROWSER_FAST_WINDOW_MS = 1400;
  // The resolver itself hands the SAME payload to every client for a full hour
  // (ZENITH_FRESH_MS in resolver-deno/main.js) and can serve it stale for a day,
  // so a 20-minute client copy is strictly more conservative than what the server
  // already guarantees — and it turns a reopened title into zero network before
  // Shaka. An expired signature still cannot strand playback: a load failure
  // re-resolves with forceWorker.
  const ZENITH_PARSED_CACHE_MS = 20 * 60e3;
  // Whether THIS browser can reach api.zenithjs.ws directly is a property of the
  // network, not of the tab. Remembering it only in sessionStorage made the first
  // click of every new session burn the full fast window on a fetch that was
  // already known to fail.
  const ZENITH_DIRECT_BLOCK_MS = 12 * 3600e3;
  const COLLAPS_REFRESH_SEC = 240;
  const COLLAPS_QUALITY_FIELDS = [
    ["mpeg4kUrl", "4K", 2160],
    ["mpeg2kUrl", "2K", 1440],
    ["mpegQhdUrl", "1440p", 1440],
    ["mpegFullHdUrl", "1080p", 1080],
    ["mpegHighUrl", "720p", 720],
    ["mpegMediumUrl", "480p", 480],
    ["mpegLowUrl", "360p", 360],
    ["mpegLowestUrl", "240p", 240],
    ["mpegTinyUrl", "144p", 144],
  ];
  const TTL = {
    search: 6 * 3600e3,
    ndsearch: 6 * 3600e3,
    ndpage: 24 * 3600e3,
    clpsplaylist: 2 * 3600e3,
    clpsprobe: 6 * 3600e3,
    clpsmiss: 60 * 60e3,
    clpsvideo: 90e3,
    zona: 30 * 24 * 3600e3,
    zenith: 20 * 60e3,
    meta: 7 * 24 * 3600e3,
    credits: 30 * 24 * 3600e3,
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
    searchView: document.getElementById("searchView"),
    resultsTitle: document.getElementById("resultsTitle"),
    resultsGrid: document.getElementById("resultsGrid"),
    soapView: document.getElementById("soapView"),
    soapFilter: document.getElementById("soapFilter"),
    soapToggle: document.getElementById("soapToggle"),
    soapCount: document.getElementById("soapCount"),
    soapGrid: document.getElementById("soapGrid"),
    soapBrowseBtn: document.getElementById("soapBrowseBtn"),
    watchView: document.getElementById("watchView"),
    watchTitle: document.getElementById("watchTitle"),
    playerHost: document.getElementById("playerHost"),
    serialPanel: document.getElementById("serialPanel"),
    trackPanel: document.getElementById("trackPanel"),
    metaPanel: document.getElementById("metaPanel"),
    similarSection: document.getElementById("similarSection"),
    similarRow: document.getElementById("similarRow"),
    loading: document.getElementById("loading"),
    error: document.getElementById("error"),
  };

  const state = {
    resolverBaseUrl: "",
    playerPlaceholder: "",
    player: null,
    hls: null,
    videoEl: null,
    currentTarget: null,
    audioNames: [],
    sources: {},
    opravar: null,
    serial: null,
    collaps: null,
    rezka: null,
    currentMeta: null,
    zenithEmbedUrl: "",
    playerReady: false,
    lastSnapshotAt: 0,
    // Ortified progress is reported from the srcdoc player every ~4s. We coalesce
    // the localStorage write (see onOrtProgress) so weak TV browsers don't stall
    // the shared event loop on every tick; the newest tick lives here until flush.
    pendingOrtEntry: null,
    lastOrtWriteAt: 0,
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
  const newdeafWarmOrigins = new Set();
  const newdeafPagePrefetches = new Set();
  const newdeafPageInflight = new Map();
  const soapWarmOrigins = new Set();
  const soapManifestPrefetches = new Set();
  const collapsWarmOrigins = new Set();
  const collapsProbeInflight = new Map();
  const collapsVideoInflight = new Map();
  const embedTextCache = new Map();
  const embedTextInflight = new Map();
  const zenithParsedCache = new Map();
  const zenithParsedInflight = new Map();
  const externalScriptPromises = new Map();
  const preparedTargets = new Set();
  // Hover prefetch budget. This used to be a plain countdown that, once spent,
  // disabled hover warming for the REST OF THE SESSION — four hovers on the
  // homepage and every later click paid full resolve latency again. It is now a
  // token bucket: a burst of hovers is still capped, but browsing for a while
  // earns the budget back.
  const SPECULATIVE_BUDGET_MAX = 6;
  const SPECULATIVE_REFILL_MS = 15e3;
  let speculativeIntentBudget = SPECULATIVE_BUDGET_MAX;
  let speculativeRefillAt = Date.now();

  function claimSpeculativeIntent() {
    const now = Date.now();
    const earned = Math.floor((now - speculativeRefillAt) / SPECULATIVE_REFILL_MS);
    if (earned > 0) {
      speculativeIntentBudget = Math.min(SPECULATIVE_BUDGET_MAX, speculativeIntentBudget + earned);
      speculativeRefillAt = now;
    }
    if (speculativeIntentBudget <= 0) return false;
    speculativeIntentBudget -= 1;
    return true;
  }

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
    const storageKey = `${CACHE_PREFIX}${ns}:${key}`;
    const payload = JSON.stringify({ v: value, exp: ttlMs ? Date.now() + ttlMs : 0 });
    try {
      localStorage.setItem(storageKey, payload);
    } catch {
      freeCacheSpace();
      try { localStorage.setItem(storageKey, payload); } catch { /* still full — session runs on network */ }
    }
  }
  // Silent quota failures used to drop the ortmeta/curatedmeta handoff between the
  // homepage and the watch page, leaving Ortified titles with a bare sidebar.
  // Reclaim space from our own TTL cache instead: expired entries first, then the
  // oldest-expiring third. History/bookmarks/foryou storage is never touched.
  function dropExpiredCache() {
    const doomed = [];
    try {
      const now = Date.now();
      for (let i = 0; i < localStorage.length; i += 1) {
        const key = localStorage.key(i) || "";
        // foryou.js uses the same {v, exp} envelope but deletes expired entries
        // only on read — sims of films that left history are never read again,
        // so without this sweep they would accumulate forever (~4KB per film).
        // Its non-TTL keys (quota counters, hidden.v1, last.v1) carry no exp
        // field and are therefore never treated as expired.
        if (!key.startsWith(CACHE_PREFIX) && !key.startsWith("alphy.foryou.")) continue;
        let exp = 0;
        try { exp = JSON.parse(localStorage.getItem(key) || "{}").exp || 0; } catch { exp = 1; }
        if (exp && exp <= now) doomed.push(key);
      }
      doomed.forEach((key) => localStorage.removeItem(key));
    } catch { /* ignore */ }
    return doomed.length;
  }
  function freeCacheSpace() {
    if (dropExpiredCache()) return;
    try {
      const entries = [];
      for (let i = 0; i < localStorage.length; i += 1) {
        const key = localStorage.key(i) || "";
        if (!key.startsWith(CACHE_PREFIX)) continue;
        let exp = Infinity;
        try { exp = JSON.parse(localStorage.getItem(key) || "{}").exp || Infinity; } catch { exp = 0; }
        entries.push({ key, exp });
      }
      entries.sort((a, b) => a.exp - b.exp);
      entries.slice(0, Math.max(10, Math.ceil(entries.length / 3))).forEach((entry) => {
        localStorage.removeItem(entry.key);
      });
    } catch { /* ignore */ }
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
    const payload = JSON.stringify(value);
    try {
      localStorage.setItem(storeKey, payload);
    } catch {
      freeCacheSpace();
      try { localStorage.setItem(storeKey, payload); } catch { /* ignore */ }
    }
  }

  // =====================================================================
  // soap4you static movie catalog. All 1212 titles + their HLS master URLs
  // are shipped as one static JSON — playback hits soap's CDN directly
  // (account-free), so browsing/search/lists need no backend at all.
  // =====================================================================
  const soapMovies = new Map();   // id -> { id, t, q, w, m, a, s }
  let soapMoviesList = [];
  let soapCatalogLoaded = null;
  function soapPoster(id) {
    return `https://soap4youand.me/assets/covers/movies/${encodeURIComponent(id)}.jpg`;
  }
  function loadSoapCatalog() {
    if (soapCatalogLoaded) return soapCatalogLoaded;
    soapCatalogLoaded = fetch("/soap-movies.json")
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        soapMoviesList = (data && data.movies) || [];
        soapMovies.clear();
        for (const m of soapMoviesList) soapMovies.set(String(m.id), m);
        warmSoapConnections(soapMoviesList[0]?.m);
        return soapMoviesList;
      })
      .catch(() => {
        soapCatalogLoaded = null; // allow a later retry
        return [];
      });
    return soapCatalogLoaded;
  }
  function soapSearch(query, { fourKOnly = false, limit = 0 } = {}) {
    const q = String(query || "").trim().toLowerCase();
    let list = fourKOnly ? soapMoviesList.filter((m) => m.q === "4K") : soapMoviesList;
    if (q) list = list.filter((m) => String(m.t || "").toLowerCase().includes(q));
    list = [...list].sort((a, b) => String(a.t).localeCompare(String(b.t)));
    return limit ? list.slice(0, limit) : list;
  }
  function soapQualityLabel(m) {
    return m.q === "4K" ? "4K UHD" : m.q === "720" ? "720p" : `${m.q}p`;
  }
  // Curated-list item shape (matches catalog.js normalizeItem) for a soap movie.
  function soapListItem(m) {
    return {
      id: crypto?.randomUUID?.() || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`,
      key: `soap:${m.id}`,
      title: m.t,
      year: "",
      poster: soapPoster(m.id),
      isSeries: false,
      target: { kind: "soap", soapId: String(m.id) },
      cachedAt: new Date().toISOString(),
    };
  }

  // =====================================================================
  // Collaps / CDNvideohub. Browser-only path:
  // KP id -> public playlist -> video/{vkId} -> progressive OK.ru MP4.
  // HLS/DASH exist but okcdn does not expose CORS for MSE, so keep this source
  // on plain <video src=mp4> and re-resolve fresh signed URLs in the browser.
  // =====================================================================
  function collapsTarget(kpId, selection = {}) {
    const target = { kind: "clps", kpId: String(kpId || "") };
    const season = positiveInt(selection.season);
    const episode = positiveInt(selection.episode);
    if (season) target.season = season;
    if (episode) target.episode = episode;
    return target;
  }

  function collapsListItem(hit, details = {}) {
    const target = collapsTarget(hit.kpId, hit.selection || hit);
    const title = details.title || hit.title || `KP ${hit.kpId}`;
    return {
      id: crypto?.randomUUID?.() || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`,
      key: keyFor(target),
      title,
      year: details.year || hit.year || "",
      poster: details.poster || hit.poster || "",
      description: details.description || "",
      isSeries: !!(details.isSeries ?? hit.isSeries),
      movieLength: details.movieLength || hit.movieLength || null,
      rating: details.rating || hit.rating || {},
      kpId: String(hit.kpId || ""),
      target,
      cachedAt: new Date().toISOString(),
    };
  }

  // Admin-only browser over the whole soap catalog: filter by name, toggle
  // 4K-only, click to play, "+" to add to a curated list. Pure client-side.
  async function showSoapBrowser() {
    setView("soap");
    warmSoapConnections();
    document.title = `soap — ${SITE_TITLE}`;
    if (el.soapFilter) el.soapFilter.value = "";
    if (state.soapFourKOnly == null) state.soapFourKOnly = true;
    await loadSoapCatalog();
    renderSoapBrowser();
    el.soapFilter?.focus();
  }
  function renderSoapBrowser() {
    if (!el.soapGrid) return;
    const fourK = state.soapFourKOnly !== false;
    const list = soapSearch(el.soapFilter?.value || "", { fourKOnly: fourK });
    if (list.length) prefetchTopSoapManifest(list);
    if (el.soapToggle) el.soapToggle.textContent = fourK ? "Показать все" : "Только 4K";
    if (el.soapCount) el.soapCount.textContent = String(list.length);
    const frag = document.createDocumentFragment();
    for (const m of list) {
      const target = { kind: "soap", soapId: String(m.id) };
      const card = makeCard({
        title: m.t,
        sub: soapQualityLabel(m),
        poster: soapPoster(m.id),
        bookmark: { target, details: { title: m.t, poster: soapPoster(m.id), year: "" } },
        onClick: () => go(`/m/${m.id}`),
        onAdd: () => window.alphyCatalog?.addToList?.(soapListItem(m)),
      });
      frag.appendChild(card);
    }
    el.soapGrid.replaceChildren(frag);
    layoutMobileGrid(el.soapGrid);
  }

  function keyFor(t) {
    if (!t) return "x";
    if (t.key) return t.key;
    if (t.kind === "kp") return `kp:${t.kpId}`;
    if (t.kind === "zen") return `zen:${t.zenithId}`;
    if (t.kind === "ort") return `ort:${t.embedUrl}`;
    if (t.kind === "opr") return `opr:${t.playerUrl}`;
    if (t.kind === "nd") return `nd:${t.pageUrl}`;
    if (t.kind === "soap") return `soap:${t.soapId}`;
    if (t.kind === "clps") return `clps:${t.kpId}`;
    return "x";
  }
  function cleanTarget(t) {
    if (t.kind === "kp") return { kind: "kp", kpId: t.kpId };
    if (t.kind === "zen") return { kind: "zen", zenithId: t.zenithId };
    if (t.kind === "ort") return { kind: "ort", embedUrl: t.embedUrl };
    if (t.kind === "opr") return { kind: "opr", playerUrl: t.playerUrl, pageUrl: t.pageUrl || "" };
    if (t.kind === "nd") return { kind: "nd", pageUrl: t.pageUrl };
    if (t.kind === "soap") return { kind: "soap", soapId: String(t.soapId) };
    if (t.kind === "clps") return collapsTarget(t.kpId, t);
    return t;
  }
  function hashFor(t) {
    if (t.kind === "kp") return `/k/${encodeURIComponent(t.kpId)}`;
    if (t.kind === "zen") return `/${encodeURIComponent(t.zenithId)}`;
    if (t.kind === "ort") return shortOrtifiedPath(t.embedUrl) || legacyHashPath(`/watch/ort/${encodeURIComponent(t.embedUrl)}`);
    if (t.kind === "opr") return legacyHashPath(`/watch/opr/${encodeURIComponent(t.playerUrl)}`);
    if (t.kind === "nd") return shortNewdeafPath(t.pageUrl) || legacyHashPath(`/watch/nd/${encodeURIComponent(t.pageUrl)}`);
    if (t.kind === "soap") return `/m/${encodeURIComponent(t.soapId)}`;
    if (t.kind === "clps") {
      const path = `/c/${encodeURIComponent(t.kpId)}`;
      const season = positiveInt(t.season);
      const episode = positiveInt(t.episode);
      return season && episode ? `${path}/s${season}e${episode}` : path;
    }
    return "/";
  }

  function recordHistory(entry) {
    let hist = loadList(STORE_HISTORY);
    if (entry.snapshot) {
      hist = hist.map((item) => item.key === entry.key ? item : ({ ...item, snapshot: "" }));
    }
    const i = hist.findIndex((h) => h.key === entry.key);
    const prev = i >= 0 ? hist[i] : null;
    const merged = { ...(prev || {}), ...entry, updatedAt: Date.now() };
    // A replay whose caches rotted (expired ortmeta, bare deep link) must never
    // blank out metadata an earlier session already stored — progress reporters
    // pass whatever the current target knows, which can be nothing.
    if (prev) {
      for (const field of ["title", "poster", "year", "movieLength", "kpId", "isSeries", "snapshot"]) {
        if (!merged[field] && prev[field]) merged[field] = prev[field];
      }
      // rating flows through mergeMetadata and arrives as {} when unknown.
      const ratingEmpty = !merged.rating || !Object.values(merged.rating).some((v) => v);
      if (ratingEmpty && prev.rating && Object.values(prev.rating).some((v) => v)) merged.rating = prev.rating;
    }
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
      // Kinopoisk id when known — the "Для вас" recommender seeds from it.
      kpId: (target.kind === "kp" || target.kind === "clps") ? String(target.kpId)
        : (state.currentMeta?.kpId ? String(state.currentMeta.kpId) : existing?.kpId),
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
  // Late kpId attach: zen/nd/ort plays learn their Kinopoisk id only after the
  // metadata enrichment lands. Persist it into the existing history entry
  // without bumping updatedAt so the recommender can seed from these plays too.
  function attachHistoryKpId(key, kpId) {
    if (!key || !/^\d+$/.test(String(kpId || ""))) return;
    const hist = loadList(STORE_HISTORY);
    const entry = hist.find((h) => h.key === key);
    if (!entry || entry.kpId) return;
    entry.kpId = String(kpId);
    saveList(STORE_HISTORY, hist);
  }

  // Recover title/poster/year for a target that carries no kpId (Ortified), e.g.
  // when reopened from Continue/Bookmarks where the URL is just the embed. Falls
  // back to whatever the history/bookmark entry kept so the watch tab is never bare.
  function storedMeta(key) {
    const entry = loadList(STORE_HISTORY).find((x) => x.key === key) || loadList(STORE_BOOKMARKS).find((x) => x.key === key);
    return entry ? { title: entry.title, poster: entry.poster, year: entry.year } : null;
  }

  // Ortified/Opravar targets carry no kpId, so their sidebar lives entirely on the
  // localStorage relay (ortmeta/oprmeta cache -> history entry). When both rot
  // (TTL expiry, quota, a bare replay), recover from the published admin catalog —
  // the same data the homepage cards render from. One same-origin fetch a session.
  let curatedCatalogItemsPromise = null;
  function curatedCatalogItems() {
    if (!curatedCatalogItemsPromise) {
      curatedCatalogItemsPromise = (async () => {
        const grab = async (url) => {
          const response = await fetch(url, { cache: "no-cache" });
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          return response.json();
        };
        let blobUrl = "";
        try { blobUrl = String((await grab("/curated-config.json")).blobUrl || ""); } catch { /* fall through */ }
        let payload = null;
        if (blobUrl) { try { payload = await grab(blobUrl); } catch { /* fall through */ } }
        if (!payload) { try { payload = await grab("/curated-live.json"); } catch { /* fall through */ } }
        if (!payload) { try { payload = await grab("/curated-fallback.json"); } catch { return []; } }
        const items = [];
        for (const list of payload?.lists || []) {
          for (const item of list?.items || []) if (item?.key) items.push(item);
        }
        return items;
      })().catch(() => []);
    }
    return curatedCatalogItemsPromise;
  }
  // Ort series keys in the admin catalog carry whatever query string the embed was
  // added with (historically even duplicated params like ?season=1&episode=1&episode=1),
  // while the router reconstructs a clean one — and series meta is the same for every
  // episode anyway. Compare ort keys by their base embed URL, query stripped.
  function curatedKeyBase(key) {
    const raw = String(key || "");
    if (!raw.startsWith("ort:")) return raw;
    try {
      const url = new URL(raw.slice(4));
      return `ort:${url.origin}${url.pathname}`;
    } catch {
      return raw;
    }
  }
  async function findCuratedMeta(key) {
    const items = await curatedCatalogItems();
    const base = curatedKeyBase(key);
    const item = items.find((x) => curatedKeyBase(x.key) === base);
    if (!item) return null;
    return {
      title: item.title || "",
      year: item.year || "",
      poster: item.poster || "",
      description: item.description || "",
      isSeries: !!item.isSeries,
      movieLength: item.movieLength || null,
      rating: item.rating || undefined,
      kpId: item.kpId || undefined,
      ageRating: item.ageRating ?? undefined,
      ratingMpaa: item.ratingMpaa || undefined,
      genres: item.genres || [],
      countries: item.countries || [],
      directors: item.directors || [],
      cast: item.cast || [],
    };
  }
  // Fire-and-forget heal for a watch page that opened with rotted/partial meta.
  // Re-renders the sidebar, refreshes the meta cache, and writes the recovered
  // title/poster/year back into history so the entry stops being invisible to
  // Continue-watching and the recommender.
  function healWatchMeta(target, token, baseMeta, cacheNs, cacheKey, fallbackHead) {
    findCuratedMeta(keyFor(target)).then((curated) => {
      if (!curated || isStale(token) || state.currentTarget !== target) return;
      const merged = mergeMetadata(baseMeta || {}, curated);
      if (!merged.title && !merged.poster) return;
      cacheSet(cacheNs, cacheKey, merged, TTL.enriched);
      target.title = merged.title || target.title;
      target.poster = merged.poster || target.poster;
      target.year = merged.year || target.year;
      if (merged.isSeries) target.isSeries = true;
      setWatchHead(target.title || fallbackHead, target);
      renderMeta(merged, target);
      recordOpen(target);
    }).catch(() => {});
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
  function savedCollapsSelection(key) {
    return loadList(STORE_HISTORY).find((h) => h.key === key)?.collapsSelection || null;
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
  // Autoplay policy
  //
  // Opening a title must not start sound on its own. Our own players therefore
  // mount PAUSED with the stream already buffering (preload="auto"), so the first
  // press of play is instant but it is the viewer's press. Third-party embeds
  // (Ortified / Zenith srcdoc iframes) run their own player and cannot be told
  // this from here.
  //
  // Playback that RESUMES after a quality/episode/voice switch is a different
  // thing: it restores a state the viewer already chose, so those call sites keep
  // their `wasPlaying`-guarded play() and do not go through here.
  // =====================================================================
  const AUTOPLAY_ON_OPEN = false;

  function mountPaused(video) {
    video.autoplay = AUTOPLAY_ON_OPEN;
    video.preload = "auto";
    return video;
  }

  function startPlaybackIfAllowed(video) {
    if (!AUTOPLAY_ON_OPEN || !video) return;
    video.play().catch(() => { /* user gesture may be required */ });
  }

  function loadExternalScript(name, src, ready) {
    if (ready()) return Promise.resolve();
    if (externalScriptPromises.has(name)) return externalScriptPromises.get(name);
    const pending = new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = src;
      script.async = true;
      script.crossOrigin = "anonymous";
      script.dataset.alphyPlayer = name;
      script.addEventListener("load", () => {
        if (ready()) resolve();
        else reject(new Error(`${name} загрузился без ожидаемого API`));
      }, { once: true });
      script.addEventListener("error", () => reject(new Error(`Не удалось загрузить ${name}`)), { once: true });
      document.head.appendChild(script);
    }).catch((error) => {
      externalScriptPromises.delete(name);
      document.querySelector(`script[data-alphy-player="${name}"]`)?.remove();
      throw error;
    });
    externalScriptPromises.set(name, pending);
    return pending;
  }

  function ensureShaka() {
    return loadExternalScript("Shaka", SHAKA_SCRIPT_URL, () => !!window.shaka?.Player);
  }

  function ensureHls() {
    return loadExternalScript("hls.js", HLS_SCRIPT_URL, () => !!window.Hls);
  }

  // =====================================================================
  // Resolver client
  // =====================================================================
  async function resolverJson(path, { retries = 2, timeoutMs = 15000, fetchCache = "no-store" } = {}) {
    if (!state.resolverBaseUrl) throw new Error("Resolver URL не настроен");
    const url = /^https?:\/\//i.test(path) ? path : `${state.resolverBaseUrl}${path}`;
    let lastError;
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetch(url, { cache: fetchCache, credentials: "omit", signal: controller.signal });
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

  async function fetchCollapsJson(url, timeoutMs = 9000) {
    const response = await fetchWithTimeout(url, {
      headers: { Accept: "application/json" },
      credentials: "omit",
      mode: "cors",
      cache: "no-store",
      referrerPolicy: "no-referrer",
    }, timeoutMs);
    const text = await response.text();
    let data;
    try { data = JSON.parse(text); } catch { data = { raw: text.slice(0, 400) }; }
    if (!response.ok) {
      const error = new Error(`Collaps ${response.status}`);
      error.status = response.status;
      throw error;
    }
    return data;
  }

  async function fetchCollapsPlaylist(kpId) {
    const id = String(kpId || "").trim();
    if (!/^\d+$/.test(id)) throw new Error("Collaps: invalid kpId");
    const cached = cacheGet("clpsplaylist", id);
    if (cached?.items?.length) return cached;
    const url = `${COLLAPS_BASE_URL}/playlist?pub=1&aggr=kp&id=${encodeURIComponent(id)}`;
    const data = await fetchCollapsJson(url);
    const playlist = normalizeCollapsPlaylist(data, id);
    if (playlist.items.length) cacheSet("clpsplaylist", id, playlist, TTL.clpsplaylist);
    return playlist;
  }

  async function fetchCollapsVideo(vkId, { force = false } = {}) {
    const id = String(vkId || "").trim();
    if (!id) throw new Error("Collaps: missing vkId");
    if (!force) {
      const cached = cacheGet("clpsvideo", id);
      if (cached?.sources?.length) return cached;
    }
    if (collapsVideoInflight.has(id)) return collapsVideoInflight.get(id);
    const pending = (async () => {
      const data = await fetchCollapsJson(`${COLLAPS_BASE_URL}/video/${encodeURIComponent(id)}`);
      const value = { raw: data, sources: normalizeCollapsSources(data?.sources || {}) };
      if (value.sources.length) cacheSet("clpsvideo", id, value, TTL.clpsvideo);
      return value;
    })().finally(() => collapsVideoInflight.delete(id));
    collapsVideoInflight.set(id, pending);
    return pending;
  }

  function normalizeCollapsPlaylist(data, kpId) {
    const items = (Array.isArray(data?.items) ? data.items : [])
      .map((item, index) => {
        const vkId = compact(item?.vkId || item?.videoId || item?.id || "");
        if (!vkId) return null;
        const season = positiveInt(item?.season);
        const episode = positiveInt(item?.episode);
        return {
          index,
          cvhId: compact(item?.cvhId || ""),
          vkId,
          voiceStudio: compact(item?.voiceStudio || item?.translation || item?.voice || ""),
          voiceType: compact(item?.voiceType || ""),
          name: compact(item?.name || item?.title || ""),
          ...(season ? { season } : {}),
          ...(episode ? { episode } : {}),
        };
      })
      .filter(Boolean);
    const isSerial = !!data?.isSerial || items.some((item) => item.season || item.episode);
    return {
      kpId: String(kpId || ""),
      titleName: compact(data?.titleName || data?.title || ""),
      isSerial,
      items,
    };
  }

  function normalizeCollapsSources(sources) {
    return COLLAPS_QUALITY_FIELDS
      .map(([key, label, height]) => {
        const url = compact(sources?.[key] || "");
        if (!/^https:\/\//i.test(url)) return null;
        return { key, label, height, url };
      })
      .filter(Boolean);
  }

  async function probeCollapsSearch(movies, token) {
    if (collapsPreviewOnCooldown()) return [];
    const candidates = (movies || [])
      .filter((movie) => /^\d+$/.test(String(movie?.kpId || "")))
      .slice(0, COLLAPS_PREVIEW_LIMIT)
      .map((movie, rank) => ({ ...movie, rank }));
    const out = [];
    let cursor = 0;
    const worker = async () => {
      while (!isStale(token) && cursor < candidates.length) {
        const movie = candidates[cursor];
        cursor += 1;
        try {
          const hit = await probeCollapsMovie(movie);
          if (hit) out.push(hit);
        } catch (error) {
          if (shouldCooldownCollapsPreview(error)) {
            setCollapsPreviewCooldown(error);
            break;
          }
          log("collaps-probe-item-warn", { kpId: movie?.kpId, message: error.message });
        }
      }
    };
    await Promise.all([worker(), worker()]);
    return out.sort((a, b) =>
      (Number(b.qualityHeight) >= 1440) - (Number(a.qualityHeight) >= 1440) ||
      Number(b.qualityHeight || 0) - Number(a.qualityHeight || 0) ||
      Number(a.rank || 0) - Number(b.rank || 0)
    );
  }

  async function probeCollapsMovie(movie) {
    const kpId = String(movie?.kpId || "");
    const cached = cacheGet("clpsprobe", kpId);
    if (cached?.kpId) return { ...cached, rank: movie.rank ?? 0 };
    if (cacheGet("clpsmiss", kpId)) return null;
    const inflightKey = kpId;
    if (collapsProbeInflight.has(inflightKey)) return collapsProbeInflight.get(inflightKey);
    const pending = (async () => {
      const playlist = await fetchCollapsPlaylist(kpId);
      const item = chooseCollapsProbeItem(playlist.items, movie?.selection);
      if (!item) {
        cacheSet("clpsmiss", kpId, true, TTL.clpsmiss);
        return null;
      }
      const video = await fetchCollapsVideo(item.vkId);
      const best = video.sources[0];
      if (!best) {
        cacheSet("clpsmiss", kpId, true, TTL.clpsmiss);
        return null;
      }
      const hit = {
        kpId,
        title: movieTitle(movie) || playlist.titleName || `KP ${kpId}`,
        year: movie?.year || "",
        poster: movie?.poster || "",
        rating: movie?.rating || {},
        movieLength: movie?.movieLength || null,
        isSeries: !!(playlist.isSerial || movie?.isSeries),
        qualityLabel: best.label,
        qualityHeight: best.height,
        selection: {
          ...(item.season ? { season: item.season } : {}),
          ...(item.episode ? { episode: item.episode } : {}),
        },
        rank: Number(movie?.rank || 0),
      };
      cacheSet("clpsprobe", kpId, hit, TTL.clpsprobe);
      return hit;
    })().finally(() => collapsProbeInflight.delete(inflightKey));
    collapsProbeInflight.set(inflightKey, pending);
    return pending;
  }

  function chooseCollapsProbeItem(items, selection = {}) {
    const list = Array.isArray(items) ? items : [];
    const season = positiveInt(selection?.season);
    const episode = positiveInt(selection?.episode);
    const requested = list.find((item) =>
      (!season || item.season === season) && (!episode || item.episode === episode));
    if (requested) return requested;
    return list.find((item) => item.season === 1 && item.episode === 1) ||
      list.find((item) => item.episode === 1) ||
      list[0] ||
      null;
  }

  function collapsPreviewOnCooldown() {
    return !!cacheGet("clpspreview", "cooldown");
  }

  function shouldCooldownCollapsPreview(error) {
    const status = Number(error?.status || String(error?.message || "").match(/\b(401|403|429)\b/)?.[1] || 0);
    if ([401, 403, 429].includes(status)) return true;
    return /Failed to fetch|NetworkError|Load failed|CORS|blocked/i.test(String(error?.message || ""));
  }

  function setCollapsPreviewCooldown(error) {
    cacheSet("clpspreview", "cooldown", {
      at: Date.now(),
      message: String(error?.message || error || "").slice(0, 120),
    }, COLLAPS_PREVIEW_COOLDOWN_MS);
  }

  async function resolveZona(kpId) {
    const cached = cacheGet("zona", kpId);
    if (cached && cached.embedUrl) return cached;
    // Always resolve at the title level (no season/episode). mzona returns the
    // whole-series Zenith embed for a series; the episode is then chosen from
    // that embed's playlist client-side. Passing season/episode here makes
    // getVideoSources come back empty and breaks series that otherwise resolve.
    const path = `/resolve-zona?kpId=${encodeURIComponent(kpId)}`;
    const candidates = isLocal
      ? [{ url: path, timeoutMs: 6000 }]
      : [
          { url: new URL(`/api${path}`, location.origin).href, timeoutMs: 6500 },
          { url: path, timeoutMs: 6000 },
        ];
    let lastError;
    for (const candidate of candidates) {
      try {
        const data = await resolverJson(candidate.url, {
          retries: 0,
          timeoutMs: candidate.timeoutMs,
          fetchCache: "default",
        });
        if (!data.embedUrl) throw new Error("Zenith временно недоступен");
        const value = { zenithId: data.zenithId, embedUrl: data.embedUrl };
        cacheSet("zona", kpId, value, TTL.zona);
        return value;
      } catch (error) {
        lastError = error;
        log("zona-resolver-fallback", { candidate: candidate.url, message: error.message });
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
    const inflight = newdeafPageInflight.get(pageUrl);
    if (inflight) return inflight;
    const pending = fetchNewdeafPage(pageUrl).finally(() => newdeafPageInflight.delete(pageUrl));
    newdeafPageInflight.set(pageUrl, pending);
    return pending;
  }

  async function fetchNewdeafPage(pageUrl) {
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
  // Router (path-based; hash links remain readable legacy aliases)
  // =====================================================================
  function parseLocationRoute() {
    const legacy = parseLegacyHash(location.hash);
    if (legacy) return legacy;
    return parsePathRoute(location.pathname, location.search);
  }

  function parseLegacyHash(hash) {
    const h = String(hash || "").replace(/^#/, "");
    if (!h) return null;
    return parsePathRoute(h, "");
  }

  function parsePathRoute(pathname, search = "") {
    const segs = String(pathname || "/").split("/").filter(Boolean).map(safeDecode);
    if (!segs.length) return { view: "home" };
    if (segs[0] === "bookmarks") return { view: "bookmarks" };
    if (segs[0] === "search") return { view: "search", q: segs.slice(1).join("/") };
    if (segs[0] === "watch" && (segs[1] === "clps" || segs[1] === "collaps") && /^\d+$/.test(segs[2] || "")) {
      return { view: "watch", kind: "clps", raw: segs[2], selection: collapsSelectionFromEpisodeKey(segs[3]) };
    }
    if (segs[0] === "watch") return { view: "watch", kind: segs[1], raw: segs.slice(2).join("/") || "" };
    if (/^\d+$/.test(segs[0])) return { view: "watch", kind: "zen", raw: segs[0] };
    if (segs[0] === "k" && /^\d+$/.test(segs[1] || "")) return { view: "watch", kind: "kp", raw: segs[1] };
    if (segs[0] === "m" && /^\d+$/.test(segs[1] || "")) return { view: "watch", kind: "soap", raw: segs[1] };
    if (segs[0] === "c" && /^\d+$/.test(segs[1] || "")) {
      return { view: "watch", kind: "clps", raw: segs[1], selection: collapsSelectionFromEpisodeKey(segs[2]) };
    }
    if (segs[0] === "o" && /^\d+$/.test(segs[1] || "")) {
      return { view: "watch", kind: "ort", raw: ortifiedUrlFromShort(segs[1], segs[2]) };
    }
    if (segs[0] === "n") {
      const pageUrl = newdeafUrlFromShortPath(segs.slice(1));
      if (pageUrl) return { view: "watch", kind: "nd", raw: pageUrl };
    }
    return { view: "home" };
  }

  function routePath(input) {
    const value = String(input || "/");
    if (value.startsWith("/watch/")) {
      const route = parsePathRoute(value, "");
      const target = targetFromWatchRoute(route);
      if (target) return hashFor(target);
    }
    if (value.startsWith("/search/")) {
      const route = parsePathRoute(value, "");
      if (route.view === "search") return `/search/${encodeURIComponent(route.q)}`;
    }
    return value.startsWith("/") ? value : "/";
  }

  function targetFromWatchRoute(route) {
    if (route.view !== "watch") return null;
    if (route.kind === "kp") return { kind: "kp", kpId: route.raw };
    if (route.kind === "zen") return { kind: "zen", zenithId: route.raw };
    if (route.kind === "ort") return { kind: "ort", embedUrl: route.raw };
    if (route.kind === "opr") return { kind: "opr", playerUrl: route.raw };
    if (route.kind === "nd") return { kind: "nd", pageUrl: route.raw };
    if (route.kind === "soap") return { kind: "soap", soapId: route.raw };
    if (route.kind === "clps") return collapsTarget(route.raw, route.selection || {});
    return null;
  }

  function go(path) {
    const next = routePath(path);
    const current = new URL(location.href);
    const target = new URL(next, location.origin);
    if (`${current.pathname}${current.search}${current.hash}` === `${target.pathname}${target.search}${target.hash}`) { route(); return; }
    history.pushState(null, "", next);
    route();
  }
  function replaceHash(path) {
    history.replaceState(null, "", routePath(path)); // no popstate, no history entry
  }

  async function route() {
    const r = parseLocationRoute();
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
    el.soapView?.classList.toggle("hidden", name !== "soap");
    el.watchView.classList.toggle("hidden", name !== "watch");
    el.bookmarksToggle.classList.toggle("active", name === "bookmarks");
    window.dispatchEvent(new CustomEvent("alphy:view", { detail: { view: name } }));
  }

  // Shaka is ~400KB from jsdelivr and is on the critical path of essentially every
  // play. Fetching it while the homepage sits idle moves that download out of the
  // click and into dead time; afterwards it is an HTTP-cache hit forever. Skipped
  // on metered/slow links, where the spend would not be repaid.
  function preloadPlayerRuntime() {
    const connection = navigator.connection || {};
    if (connection.saveData) return;
    if (/^(slow-)?2g$/.test(String(connection.effectiveType || ""))) return;
    scheduleIdle(() => { ensureShaka().catch(() => {}); }, 4000);
  }

  function showHome() {
    setView("home");
    warmNewdeafConnections();
    warmCollapsConnections();
    preloadPlayerRuntime();
    document.title = SITE_TITLE;
    el.searchInput.value = "";
    const hist = loadList(STORE_HISTORY);
    renderContinueHeader(hist.length);
    renderHomeGrid(el.continueGrid, el.continueSection, hist, {
      withProgress: true,
      store: STORE_HISTORY,
      featureLatest: true,
    });
  }

  function showBookmarks() {
    setView("bookmarks");
    document.title = `Закладки — ${SITE_TITLE}`;
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
    const twoRows = cards.length > 4;
    const topCount = twoRows ? Math.ceil(cards.length / 2) : cards.length;
    grid.classList.toggle("mobile-two-row", twoRows);
    cards.forEach((card, index) => {
      const top = !twoRows || index < topCount;
      card.style.setProperty("--mobile-row", top ? "1" : "2");
      card.style.setProperty("--mobile-column", String(top ? index + 1 : index - topCount + 1));
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
    armCardIntent(card, entry.target, entry);
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
    const selection = entry?.serialSelection || entry?.opravarSelection || entry?.collapsSelection || null;
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
    warmNewdeafConnections();
    warmCollapsConnections();
    document.title = `${query} — ${SITE_TITLE}`;
    el.searchInput.value = query;
    el.resultsTitle.textContent = "Поиск…";
    el.resultsGrid.replaceChildren();

    // SOAP titles are overwhelmingly Latin. Avoid competing with PoiskKino,
    // Newdeaf and posters for a 600KB catalog on ordinary Russian searches.
    const wantsSoap = /[a-z]/i.test(query);
    if (wantsSoap) warmSoapConnections();
    const soapTask = wantsSoap ? loadSoapCatalog() : Promise.resolve([]);
    const poiskTask = searchPoiskkino(query)
      .then((results) => ({ results }))
      .catch((error) => {
        log("poisk-error", error.message);
        return { results: [] };
      });

    let pk = [];
    let nd = [];
    let clps = [];
    let newdeafUnavailable = false;
    let collapsProbeKey = "";
    let collapsScheduledKey = "";
    const startCollapsProbe = (movies) => {
      const ids = (movies || []).map((m) => m.kpId).filter(Boolean).slice(0, COLLAPS_PREVIEW_LIMIT).join(",");
      if (!ids || ids === collapsProbeKey || ids === collapsScheduledKey || collapsPreviewOnCooldown()) return;
      collapsScheduledKey = ids;
      scheduleIdle(() => {
        if (isStale(token) || collapsScheduledKey !== ids || collapsPreviewOnCooldown()) return;
        collapsScheduledKey = "";
        collapsProbeKey = ids;
        probeCollapsSearch(movies, token)
          .then((hits) => {
            clps = hits;
            if (!isStale(token)) renderResults(nd, pk, query, { newdeafUnavailable, collapsHits: clps });
          })
          .catch((error) => log("collaps-probe-warn", error.message));
      }, COLLAPS_PREVIEW_IDLE_TIMEOUT);
    };
    const canStartNewdeafNow = /[а-яё]/i.test(query);
    const newdeafTask = canStartNewdeafNow
      ? searchNewdeaf(query)
        .then((results) => ({ results, unavailable: false }))
        .catch((error) => {
          log("newdeaf-error", error.message);
          return { results: [], unavailable: true };
        })
      : null;

    if (newdeafTask) {
      const first = await Promise.race([
        poiskTask.then((value) => ({ source: "poisk", ...value })),
        newdeafTask.then((value) => ({ source: "newdeaf", ...value })),
      ]);
      if (isStale(token)) return;
      if (first.source === "poisk") pk = first.results;
      else {
        nd = first.results;
        newdeafUnavailable = first.unavailable;
      }
      if (pk.length) startCollapsProbe(pk);
      renderResults(nd, pk, query, { newdeafUnavailable, collapsHits: clps });

      const [poisk, newdeaf] = await Promise.all([poiskTask, newdeafTask]);
      pk = poisk.results;
      nd = newdeaf.results;
      newdeafUnavailable = newdeaf.unavailable;
      if (pk.length) startCollapsProbe(pk);
    } else {
      const poisk = await poiskTask;
      if (isStale(token)) return;
      pk = poisk.results;
      startCollapsProbe(pk);
      renderResults([], pk, query, { collapsHits: clps });

      // newdeaf indexes Russian titles only. If the query has no Cyrillic, search
      // newdeaf with the Russian name from the top PoiskKino hit so English queries
      // ("Scavengers Reign") still surface the newdeaf pages ("Царство падальщиков").
      const ndQuery = pickNewdeafQuery(query, pk);
      try {
        nd = await searchNewdeaf(ndQuery);
      } catch (error) {
        newdeafUnavailable = true;
        log("newdeaf-error", error.message);
      }
    }
    if (isStale(token)) return;
    await soapTask;
    if (isStale(token)) return;
    renderResults(nd, pk, query, { newdeafUnavailable, collapsHits: clps });
    if (!pk.length && !nd.length && !clps.length && !soapSearch(query, { limit: 1 }).length) {
      el.resultsTitle.textContent = "Ничего не найдено";
    }
  }

  function pickNewdeafQuery(query, pkResults) {
    if (/[а-яё]/i.test(query)) return query;
    const ru = (pkResults || []).map((m) => m.name).find((name) => /[а-яё]/i.test(name || ""));
    return ru || query;
  }

  function renderResults(ndCandidates, pkResults, query, options = {}) {
    // Build the whole grid in a detached fragment and swap it in once. Search may
    // render once for the race winner and again for the final merge, so appending
    // card-by-card to the live grid each time would thrash layout for no reason.
    const frag = document.createDocumentFragment();
    el.resultsTitle.textContent = "Результаты";
    if (ndCandidates.length) prefetchTopNewdeafPage(ndCandidates);
    const collapsHits = Array.isArray(options.collapsHits) ? options.collapsHits : [];
    const highCollapsHits = collapsHits.filter((hit) => Number(hit.qualityHeight) >= 1440);
    const regularCollapsHits = collapsHits.filter((hit) => Number(hit.qualityHeight) < 1440);
    for (const hit of highCollapsHits) frag.appendChild(makeCollapsCard(hit));
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
      // An already-curated title opens through its resolved list target
      // (instant Ortified/Zona) instead of re-running the newdeaf resolve.
      const ready = match
        ? window.alphyCatalog?.findReady?.(movieTitle(match), match.year, !!match.isSeries)
        : null;
      const card = makeCard({
        title,
        sub: [match?.year, match?.isSeries ? "сериал" : "Newdeaf"].filter(Boolean).join(" · "),
        poster: details.poster,
        rating: match?.rating,
        movieLength: match?.movieLength,
        isSeries: match?.isSeries,
        bookmark: { target, details },
        intent: { target: ready?.target || target, details },
        onClick: ready
          ? () => openCuratedItem({ ...ready, kpId: ready.kpId || (match?.kpId != null ? String(match.kpId) : "") })
          : () => go(`/watch/nd/${encodeURIComponent(item.url)}`),
      });
      frag.appendChild(card);
    }
    for (const hit of regularCollapsHits) frag.appendChild(makeCollapsCard(hit));
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
      const ready = window.alphyCatalog?.findReady?.(title, movie.year, !!movie.isSeries);
      const card = makeCard({
        title,
        sub: [movie.year, movie.isSeries ? "сериал" : "фильм"].filter(Boolean).join(" · "),
        poster: movie.poster,
        rating: movie.rating,
        movieLength: movie.movieLength,
        isSeries: movie.isSeries,
        bookmark: { target, details },
        intent: { target: ready?.target || target, details },
        onClick: ready
          ? () => openCuratedItem({ ...ready, kpId: ready.kpId || String(movie.kpId) })
          : () => go(`/watch/kp/${encodeURIComponent(movie.kpId)}`),
      });
      frag.appendChild(card);
    }
    // soap4you as a fallback source (client-side static catalog, account-free
    // playback). Titles are mostly English, so this mainly surfaces on Latin
    // queries; ranked last since Ortified/Zona are preferred when present.
    const soapHits = soapSearch(query, { limit: 12 });
    if (soapHits.length) prefetchTopSoapManifest(soapHits);
    for (const m of soapHits) {
      const target = { kind: "soap", soapId: String(m.id) };
      const details = { title: m.t, poster: soapPoster(m.id), year: "" };
      const card = makeCard({
        title: m.t,
        sub: [soapQualityLabel(m), "soap"].filter(Boolean).join(" · "),
        poster: soapPoster(m.id),
        bookmark: { target, details },
        onClick: () => go(`/m/${m.id}`),
        onAdd: () => window.alphyCatalog?.addToList?.(soapListItem(m)),
      });
      frag.appendChild(card);
    }
    if (options.newdeafUnavailable) {
      const note = document.createElement("p");
      note.className = "muted search-note";
      note.textContent = "Newdeaf не ответил этому браузеру — показаны остальные результаты.";
      frag.appendChild(note);
    }
    if (!pkResults.length && !ndCandidates.length && !collapsHits.length && !soapHits.length) {
      const p = document.createElement("p");
      p.className = "muted";
      p.textContent = `Ничего не найдено по «${query}».`;
      frag.appendChild(p);
    }
    el.resultsGrid.replaceChildren(frag);
    layoutMobileGrid(el.resultsGrid);
  }

  function makeCollapsCard(hit) {
    const target = collapsTarget(hit.kpId, hit.selection || {});
    const details = {
      title: hit.title || `KP ${hit.kpId}`,
      year: hit.year || "",
      poster: hit.poster || "",
      rating: hit.rating || {},
      movieLength: hit.movieLength || null,
      isSeries: !!hit.isSeries,
      kpId: String(hit.kpId || ""),
    };
    const quality = hit.qualityLabel || "MP4";
    return makeCard({
      title: details.title,
      sub: [quality, details.isSeries ? "сериал" : "фильм", "CLPS"].filter(Boolean).join(" · "),
      poster: details.poster,
      ratingPill: "CLPS",
      rating: details.rating,
      movieLength: details.movieLength,
      isSeries: details.isSeries,
      bookmark: { target, details },
      onClick: () => go(hashFor(target)),
      onAdd: () => window.alphyCatalog?.addToList?.(collapsListItem(hit, details)),
    });
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
    intent,
    onBookmarkChange,
    onClick,
    onRemove,
    onAdd,
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
      img.decoding = "async";
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
    if (onAdd) {
      // Admin-only "add to curated list" affordance (hidden unless body.admin-mode).
      const add = document.createElement("button");
      add.className = "card-add-list";
      add.type = "button";
      add.setAttribute("aria-label", "Добавить в подборку");
      add.textContent = "+";
      add.addEventListener("click", (event) => { event.stopPropagation(); onAdd(); });
      media.appendChild(add);
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
    const prep = intent || bookmark;
    if (prep?.target) armCardIntent(card, prep.target, prep.details || {});
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
    watchExtrasKey = "";
    hideSimilarRow();
    // Show the loading state immediately so the previous title's player is never
    // left on screen while the new one resolves (or fails to resolve).
    showPlayerLoading();
    if (r.kind === "kp") return playKp(r.raw, token);
    if (r.kind === "zen") return playZen(r.raw, token);
    if (r.kind === "ort") return playOrt(r.raw, token, null);
    if (r.kind === "opr") return playOpr(r.raw, token, null);
    if (r.kind === "nd") return playNd(r.raw, token);
    if (r.kind === "soap") return playSoap(r.raw, token);
    if (r.kind === "clps") return playCollaps(r.raw, token, { selection: r.selection });
    throw new Error("Неизвестный тип контента");
  }

  // soap4you movie playback is a plain HLS master with adaptive video, audio
  // tracks, and in-manifest subtitles. The stored URL is account-free once fresh:
  // no resolver, no backend, no soap session during playback.
  async function playSoap(soapId, token) {
    await loadSoapCatalog();
    if (isStale(token)) return;
    const movie = soapMovies.get(String(soapId));
    if (movie?.m) warmSoapConnections(movie.m);
    const cachedMeta = cacheGet("curatedmeta", `soap:${soapId}`) || storedMeta(`soap:${soapId}`);
    const title = movie?.t || cachedMeta?.title || `Movie ${soapId}`;
    const target = {
      kind: "soap",
      soapId: String(soapId),
      title,
      poster: cachedMeta?.poster || soapPoster(soapId),
      year: cachedMeta?.year || "",
      isSeries: false,
    };
    state.currentTarget = target;
    setWatchHead(title, target);
    renderMeta(
      {
        title,
        poster: target.poster,
        year: target.year,
        description: cachedMeta?.description || "",
        rating: cachedMeta?.rating || {},
        movieLength: cachedMeta?.movieLength || null,
      },
      target,
    );
    recordOpen(target);
    if (!movie || !movie.m) throw new Error("Фильм отсутствует в каталоге soap");
    // soap serves demuxed TS HLS which Shaka's transmuxer mishandles (Firefox
    // audio-decode errors, Chrome/Safari black HEVC video). hls.js is the proven
    // player for exactly this — same one soap's own player.js uses.
    await playSoapHls(movie.m, token, {
      resume: resumePosition(keyFor(target)),
      audioLang: savedAudioLang(keyFor(target)),
    });
    if (isStale(token)) return;
    startTracking(keyFor(target), target);
  }

  // Prefer H.264 (avc1) ladder; HEVC-in-TS via MSE renders black in Chrome, and
  // every sampled soap 4K title has a full avc1 ladder, so avc1 covers all resolutions.
  function soapAvcLevels(hls) {
    return (hls.levels || [])
      .map((l, i) => ({ ...l, _i: i }))
      .filter((l) => !/hvc1|hev1|hevc/i.test(l.videoCodec || ""))
      .sort((a, b) => (b.height || 0) - (a.height || 0) || (b.bitrate || 0) - (a.bitrate || 0));
  }
  function removeSoapHevcLevels(hls) {
    const levels = hls.levels || [];
    for (let i = levels.length - 1; i >= 0; i -= 1) {
      if (/hvc1|hev1|hevc/i.test(levels[i]?.videoCodec || "")) {
        try { hls.removeLevel(i); } catch (error) { log("soap-hevc-filter-warn", error.message); }
      }
    }
  }
  function soapAudioName(t, i) {
    return t?.name || t?.label || t?.lang || t?.language || `Дорожка ${i + 1}`;
  }
  function soapActiveAudioLang() {
    const hls = state.hls;
    const track = hls?.audioTracks?.[hls.audioTrack];
    return track?.lang || track?.name || track?.label || "";
  }
  function soapAutoQualityLabel(hls) {
    const index = hls?.loadLevel >= 0 ? hls.loadLevel : hls?.nextLevel >= 0 ? hls.nextLevel : hls?.currentLevel;
    const level = index >= 0 ? hls.levels?.[index] : null;
    return level?.height ? `Авто (${level.height}p)` : "Авто";
  }
  function soapHlsConfig() {
    return {
      enableWorker: true,
      lowLatencyMode: false,
      startLevel: -1,
      testBandwidth: true,
      capLevelToPlayerSize: true,
      capLevelOnFPSDrop: true,
      maxDevicePixelRatio: 2,
      maxBufferLength: 45,
      maxMaxBufferLength: 90,
      backBufferLength: 60,
      abrEwmaFastVoD: 3,
      abrEwmaSlowVoD: 9,
      abrEwmaDefaultEstimate: initialBandwidthEstimate(5_000_000),
      abrEwmaDefaultEstimateMax: 12_000_000,
      abrBandWidthFactor: 0.88,
      abrBandWidthUpFactor: 0.68,
      maxStarvationDelay: 4,
      maxLoadingDelay: 4,
      manifestLoadingTimeOut: 12_000,
      levelLoadingTimeOut: 12_000,
      fragLoadingTimeOut: 25_000,
      manifestLoadingMaxRetry: 2,
      levelLoadingMaxRetry: 3,
      fragLoadingMaxRetry: 4,
      manifestLoadingRetryDelay: 700,
      levelLoadingRetryDelay: 700,
      fragLoadingRetryDelay: 700,
      manifestLoadingMaxRetryTimeout: 5_000,
      levelLoadingMaxRetryTimeout: 8_000,
      fragLoadingMaxRetryTimeout: 8_000,
      appendErrorMaxRetry: 4,
      preserveManualLevelOnError: false,
    };
  }
  function isExpiredSoapHlsError(data) {
    const code = Number(data?.response?.code || data?.response?.status || data?.networkDetails?.status || 0);
    const details = String(data?.details || "");
    return code === 404 && /manifest|level|playlist/i.test(details);
  }
  function isSoapManifestHlsError(data) {
    return /manifest/i.test(String(data?.details || ""));
  }
  function soapHlsErrorMessage(data) {
    if (isExpiredSoapHlsError(data)) {
      return "SOAP master URL протух. Нужно обновить soap-movies.json свежим дампом.";
    }
    const code = data?.response?.code || data?.response?.status || data?.networkDetails?.status || "";
    if (isSoapManifestHlsError(data)) {
      return `SOAP master URL не загрузился${code ? ` (${code})` : ""}. Проверь свежесть soap-movies.json.`;
    }
    return `HLS: ${data?.details || data?.type || "fatal"}${code ? ` (${code})` : ""}`;
  }

  async function playSoapHls(url, token, opts = {}) {
    if (isStale(token)) return;
    await teardownPlayer();
    resetSubtitleRequest();
    const video = document.createElement("video");
    video.controls = true;
    video.playsInline = true;
    mountPaused(video);
    video.crossOrigin = "anonymous";
    video.playbackRate = state.playbackRate;
    if (isStale(token)) return;
    el.playerHost.replaceChildren(video);
    state.videoEl = video;

    const onReady = () => {
      if (isStale(token)) return;
      if (opts.resume > 5) { try { video.currentTime = opts.resume; } catch { /* ignore */ } }
      video.playbackRate = state.playbackRate;
      renderSoapTracks();
      markPlayerReady();
      const snap = () => {
        const target = state.currentTarget;
        if (target) setTimeout(() => captureVideoSnapshot(keyFor(target), target), 350);
      };
      video.addEventListener("loadeddata", snap, { once: true });
      video.addEventListener("playing", snap);
      video.addEventListener("pause", snap);
      video.addEventListener("seeked", snap);
      setTimeout(snap, 2200);
      startPlaybackIfAllowed(video);
    };

    const nativeHls = !!video.canPlayType("application/vnd.apple.mpegurl");
    // iOS has native HLS and no MSE, so downloading hls.js there is pure latency.
    if (!window.MediaSource && nativeHls) {
      video.src = url;
      video.addEventListener("loadedmetadata", onReady, { once: true });
      return;
    }

    // hls.js (Chrome/Firefox/desktop Safari via MSE) — full custom track UI.
    try {
      await ensureHls();
    } catch (error) {
      if (!nativeHls) throw error;
    }
    if (isStale(token)) return;
    if (window.Hls && window.Hls.isSupported()) {
      const hls = new Hls(soapHlsConfig());
      let networkRecoveries = 0;
      let mediaRecoveries = 0;
      state.hls = hls;
      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        if (isStale(token)) return;
        removeSoapHevcLevels(hls);
        hls.currentLevel = -1;
        hls.loadLevel = -1;
        hls.nextLevel = -1;
        if (opts.audioLang && (hls.audioTracks || []).length) {
          const want = String(opts.audioLang).toLowerCase();
          const idx = hls.audioTracks.findIndex((t) => String(t.lang || t.name || "").toLowerCase().startsWith(want));
          if (idx >= 0) {
            if ("nextAudioTrack" in hls) hls.nextAudioTrack = idx;
            hls.audioTrack = idx;
          }
        }
        hls.subtitleDisplay = false;
        hls.subtitleTrack = -1;
        onReady();
      });
      hls.on(Hls.Events.LEVELS_UPDATED, renderSoapTracks);
      hls.on(Hls.Events.LEVEL_SWITCHED, renderSoapTracks);
      hls.on(Hls.Events.AUDIO_TRACKS_UPDATED, renderSoapTracks);
      hls.on(Hls.Events.AUDIO_TRACK_SWITCHED, renderSoapTracks);
      hls.on(Hls.Events.SUBTITLE_TRACKS_UPDATED, renderSoapTracks);
      hls.on(Hls.Events.SUBTITLE_TRACK_SWITCHED, renderSoapTracks);
      hls.on(Hls.Events.ERROR, (_evt, data) => {
        if (!data?.fatal) return;
        log("soap-hls-error", data.type, data.details);
        if (isExpiredSoapHlsError(data) || isSoapManifestHlsError(data)) {
          if (!isStale(token)) showError(new Error(soapHlsErrorMessage(data)));
          return;
        }
        if (data.type === Hls.ErrorTypes.NETWORK_ERROR && networkRecoveries < 3) {
          networkRecoveries += 1;
          setTimeout(() => { if (!isStale(token)) hls.startLoad(-1); }, networkRecoveries * 650);
          return;
        }
        if (data.type === Hls.ErrorTypes.MEDIA_ERROR && mediaRecoveries < 2) {
          mediaRecoveries += 1;
          hls.recoverMediaError();
          return;
        }
        if (!isStale(token)) showError(new Error(soapHlsErrorMessage(data)));
      });
      hls.loadSource(url);
      hls.attachMedia(video);
      return;
    }

    // Native HLS (iOS Safari, no MSE) — plays demuxed TS directly; the media
    // element exposes audio/text tracks, quality is auto-managed by the OS.
    if (nativeHls) {
      video.src = url;
      video.addEventListener("loadedmetadata", onReady, { once: true });
      return;
    }
    throw new Error("Браузер не поддерживает HLS");
  }

  function renderSoapTracks() {
    const video = state.videoEl;
    if (!video) return;
    const hls = state.hls;
    el.serialPanel.replaceChildren();
    el.serialPanel.classList.add("hidden");
    el.trackPanel.replaceChildren();
    el.trackPanel.classList.remove("hidden");

    if (hls) {
      const audio = hls.audioTracks || [];
      if (audio.length > 1) {
        addTrackGroup("Озвучка", audio, (t, i) => {
          const btn = document.createElement("button");
          btn.textContent = soapAudioName(t, i);
          if (i === hls.audioTrack) btn.className = "active";
          btn.addEventListener("click", () => {
            if ("nextAudioTrack" in hls) hls.nextAudioTrack = i;
            hls.audioTrack = i;
            const lang = t.lang || t.name || "";
            if (lang) persistAudio(lang);
            setTimeout(renderSoapTracks, 150);
          });
          return btn;
        });
      }
      const seen = new Set();
      const levels = soapAvcLevels(hls).filter((l) => (seen.has(l.height) ? false : seen.add(l.height)));
      addTrackGroup("Качество", [{ auto: true }, ...levels], (l) => {
        const btn = document.createElement("button");
        if (l.auto) {
          btn.textContent = soapAutoQualityLabel(hls);
          if (hls.autoLevelEnabled) btn.className = "active";
          btn.addEventListener("click", () => {
            hls.capLevelToPlayerSize = true;
            hls.currentLevel = -1;
            hls.loadLevel = -1;
            hls.nextLevel = -1;
            setTimeout(renderSoapTracks, 150);
          });
          return btn;
        }
        btn.textContent = `${l.height ? `${l.height}p` : "auto"} ${(l.bitrate / 1e6).toFixed(1)} Mbps`;
        if (!hls.autoLevelEnabled && l._i === hls.currentLevel) btn.className = "active";
        btn.addEventListener("click", () => {
          hls.capLevelToPlayerSize = false;
          hls.currentLevel = l._i;
          setTimeout(renderSoapTracks, 150);
        });
        return btn;
      });
      const subs = hls.subtitleTracks || [];
      addTrackGroup("Субтитры", [{ off: true }, ...subs.map((t, i) => ({ t, i }))], (it) => {
        const btn = document.createElement("button");
        if (it.off) {
          btn.textContent = "Выкл";
          if (!hls.subtitleDisplay || hls.subtitleTrack < 0) btn.className = "active";
          btn.addEventListener("click", () => {
            hls.subtitleDisplay = false; hls.subtitleTrack = -1; setTimeout(renderSoapTracks, 100);
          });
          return btn;
        }
        btn.textContent = it.t.name || it.t.lang || `sub ${it.i + 1}`;
        if (hls.subtitleDisplay && it.i === hls.subtitleTrack) btn.className = "active";
        btn.addEventListener("click", () => {
          hls.subtitleTrack = it.i; hls.subtitleDisplay = true; setTimeout(renderSoapTracks, 100);
        });
        return btn;
      });
    } else {
      const atracks = video.audioTracks ? Array.from(video.audioTracks) : [];
      if (atracks.length > 1) {
        addTrackGroup("Озвучка", atracks, (t, i) => {
          const btn = document.createElement("button");
          btn.textContent = soapAudioName(t, i);
          if (t.enabled) btn.className = "active";
          btn.addEventListener("click", () => {
            atracks.forEach((x) => { x.enabled = false; });
            t.enabled = true;
            setTimeout(renderSoapTracks, 100);
          });
          return btn;
        });
      }
      const ttracks = video.textTracks ? Array.from(video.textTracks) : [];
      if (ttracks.length) {
        addTrackGroup("Субтитры", [{ off: true }, ...ttracks.map((t, i) => ({ t, i }))], (it) => {
          const btn = document.createElement("button");
          if (it.off) {
            btn.textContent = "Выкл";
            if (![...ttracks].some((x) => x.mode === "showing")) btn.className = "active";
            btn.addEventListener("click", () => { ttracks.forEach((x) => { x.mode = "disabled"; }); setTimeout(renderSoapTracks, 100); });
            return btn;
          }
          btn.textContent = it.t.label || it.t.language || `sub ${it.i + 1}`;
          if (it.t.mode === "showing") btn.className = "active";
          btn.addEventListener("click", () => {
            ttracks.forEach((x) => { x.mode = "disabled"; });
            it.t.mode = "showing";
            setTimeout(renderSoapTracks, 100);
          });
          return btn;
        });
      }
    }

    addTrackGroup("Скорость", [0.5, 1, 1.25, 1.5, 1.75, 2].map((s) => ({ speed: s })), (item) => {
      const btn = document.createElement("button");
      btn.textContent = `${item.speed}×`;
      if (item.speed === state.playbackRate) btn.className = "active";
      btn.addEventListener("click", () => {
        state.playbackRate = item.speed;
        try { localStorage.setItem("alphy.playbackRate", String(item.speed)); } catch { /* ignore */ }
        if (state.videoEl) state.videoEl.playbackRate = item.speed;
        setTimeout(renderSoapTracks, 50);
      });
      return btn;
    });
  }

  async function playCollaps(kpId, token, opts = {}) {
    const id = String(kpId || "").trim();
    if (!/^\d+$/.test(id)) throw new Error("Collaps: неверный KP id");

    const cachedMeta = opts.meta || cacheGet("meta", id);
    const metaTask = cachedMeta ? Promise.resolve(cachedMeta) : fetchMovieMeta(id).catch(() => null);
    const playlist = await fetchCollapsPlaylist(id);
    if (isStale(token)) return;
    let meta = cachedMeta || await settleWithin(metaTask, 200);
    if (isStale(token)) return;
    if (meta) cacheSet("meta", id, meta, TTL.meta);

    const requested =
      normalizeCollapsSelection(opts.selection) ||
      normalizeCollapsSelection(savedCollapsSelection(`clps:${id}`));
    const title = movieTitle(meta) || playlist.titleName || `KP ${id}`;
    const target = {
      kind: "clps",
      kpId: id,
      title,
      poster: meta?.poster || "",
      year: meta?.year || "",
      isSeries: !!(playlist.isSerial || meta?.isSeries || requested?.season || requested?.episode),
      ...(requested?.season ? { season: requested.season } : {}),
      ...(requested?.episode ? { episode: requested.episode } : {}),
    };
    state.currentTarget = target;
    setWatchHead(title, target);
    renderMeta(mergeMetadata({ title, isSeries: target.isSeries }, meta || {}), target);
    recordOpen(target);

    if (!meta) {
      metaTask.then((fresh) => {
        const current = state.currentTarget;
        if (!fresh || isStale(token) || current?.kind !== "clps" || String(current.kpId || "") !== id) return;
        meta = fresh;
        cacheSet("meta", id, fresh, TTL.meta);
        current.title = movieTitle(fresh) || current.title;
        current.poster = fresh.poster || current.poster;
        current.year = fresh.year || current.year;
        current.isSeries = !!(playlist.isSerial || fresh.isSeries || current.isSeries);
        setWatchHead(current.title || `KP ${id}`, current);
        renderMeta(mergeMetadata({ title: current.title, isSeries: current.isSeries }, fresh), current);
        recordOpen(current);
      }).catch(() => {});
    }

    const context = buildCollapsContext(playlist);
    const selection = chooseCollapsSelection(context, requested);
    if (!selection) throw new Error("Collaps не вернул озвучки/серии для этого KP");
    await playCollapsSelection(context, selection, token, resumePosition(keyFor(target)), {
      qualityKey: requested?.qualityKey,
    });
  }

  async function playCollapsSelection(context, selection, token, resume = 0, opts = {}) {
    const target = state.currentTarget;
    if (!target || target.kind !== "clps") return;
    const picked = chooseCollapsSelection(context, selection);
    const item = picked?.item;
    if (!item?.vkId) throw new Error("Collaps: не выбрана озвучка");

    const resolved = await fetchCollapsVideo(item.vkId);
    if (isStale(token)) return;
    if (!resolved.sources.length) throw new Error("Collaps не отдал progressive MP4");

    const stored = normalizeCollapsSelection(savedCollapsSelection(keyFor(target))) || {};
    const source = chooseCollapsSource(
      resolved.sources,
      opts.qualityKey || selection?.qualityKey || stored.qualityKey,
    );
    if (!source?.url) throw new Error("Collaps: нет выбранного качества");

    const nextSelection = cleanCollapsSelection({
      ...picked,
      qualityKey: source.key,
    });
    if (nextSelection.season) target.season = nextSelection.season;
    if (nextSelection.episode) target.episode = nextSelection.episode;

    const previous = state.collaps || {};
    const playback = {
      context,
      selection: nextSelection,
      item,
      sources: resolved.sources,
      videoMeta: resolved.raw || {},
      qualityKey: source.key,
      autoRefresh: opts.autoRefresh ?? previous.autoRefresh ?? true,
      refreshSec: opts.refreshSec || previous.refreshSec || COLLAPS_REFRESH_SEC,
      activeIndex: 0,
      videos: [],
      refreshTimer: null,
      uiTimer: null,
      watchdog: null,
      lastAdvanceWall: Date.now(),
      nextAt: 0,
      pendingRefresh: false,
      refreshing: false,
      status: "",
    };
    state.collaps = playback;
    persistCollapsSelection(target, nextSelection, resume);
    await mountCollapsMp4(source.url, token, resume);
    if (state.collaps !== playback) return;
    if (isStale(token)) return;
    renderCollapsControls();
    startTracking(keyFor(target), target);
  }

  async function mountCollapsMp4(url, token, resume = 0) {
    const c = state.collaps;
    if (!c || isStale(token)) return;
    stopCollapsTimers();
    warmCollapsConnections(url);

    const active = createCollapsVideo();
    const buffer = createCollapsVideo();
    buffer.style.display = "none";
    c.videos = [active, buffer];
    c.activeIndex = 0;
    state.videoEl = active;
    el.playerHost.replaceChildren(active, buffer);

    await new Promise((resolve) => {
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        active.removeEventListener("canplay", done);
        active.removeEventListener("loadedmetadata", onMeta);
        if (!isStale(token) && state.collaps === c) markPlayerReady();
        resolve();
      };
      const onMeta = () => {
        if (resume > 5) { try { active.currentTime = resume; } catch { /* ignore */ } }
      };
      active.addEventListener("loadedmetadata", onMeta);
      active.addEventListener("canplay", done);
      active.src = url;
      active.load();
      startPlaybackIfAllowed(active);
      setTimeout(done, 2500);
    });
    bindCollapsActive();
    armCollapsTimers();
  }

  function createCollapsVideo() {
    const video = document.createElement("video");
    video.controls = true;
    video.playsInline = true;
    mountPaused(video);
    video.playbackRate = state.playbackRate;
    return video;
  }

  function activeCollapsVideo() {
    const c = state.collaps;
    return c?.videos?.[c.activeIndex] || state.videoEl;
  }

  function bufferCollapsVideo() {
    const c = state.collaps;
    if (!c?.videos?.length) return null;
    return c.videos[c.activeIndex === 0 ? 1 : 0];
  }

  function bindCollapsActive() {
    const c = state.collaps;
    const active = activeCollapsVideo();
    const buffer = bufferCollapsVideo();
    if (!c || !active) return;
    if (buffer) {
      buffer.onerror = null;
      buffer.ontimeupdate = null;
      buffer.oncanplay = null;
      buffer.onplay = null;
    }
    active.ontimeupdate = () => { c.lastAdvanceWall = Date.now(); };
    active.onplay = () => {
      if (c.pendingRefresh && !c.refreshing) {
        c.pendingRefresh = false;
        refreshCollapsNow("возобновление").catch((error) => log("collaps-refresh-warn", error.message));
      }
    };
    active.onerror = () => {
      if (!c.refreshing) {
        refreshCollapsNow("error").catch((error) => showError(new Error(`Collaps: ${error.message}`)));
      }
    };
  }

  async function resolveFreshCollapsSource(qualityKey = "") {
    const c = state.collaps;
    if (!c?.item?.vkId) return null;
    const resolved = await fetchCollapsVideo(c.item.vkId, { force: true });
    if (state.collaps !== c) return null;
    if (!resolved.sources.length) return null;
    const source = chooseCollapsSource(resolved.sources, qualityKey || c.qualityKey);
    c.sources = resolved.sources;
    c.videoMeta = resolved.raw || {};
    c.qualityKey = source.key;
    c.selection = cleanCollapsSelection({ ...c.selection, qualityKey: source.key });
    if (state.currentTarget) persistCollapsSelection(state.currentTarget, c.selection, activeCollapsVideo()?.currentTime || 0);
    return source.url;
  }

  async function refreshCollapsNow(reason, qualityKey = "") {
    const c = state.collaps;
    if (!c || c.refreshing) return;
    c.refreshing = true;
    stopCollapsSchedule();
    try {
      const url = await resolveFreshCollapsSource(qualityKey);
      if (!url) throw new Error("не удалось получить свежий MP4");
      warmCollapsConnections(url);
      const ok = await swapCollapsVideo(url);
      if (!ok) hardReloadCollapsVideo(url);
      c.lastAdvanceWall = Date.now();
    } finally {
      c.refreshing = false;
      armCollapsTimers();
      renderCollapsControls();
      log("collaps-refresh", reason);
    }
  }

  function swapCollapsVideo(url) {
    const c = state.collaps;
    const cur = activeCollapsVideo();
    const next = bufferCollapsVideo();
    if (!c || !cur || !next) return Promise.resolve(false);
    return new Promise((resolve) => {
      const wasPlaying = !cur.paused && !cur.ended;
      let done = false;
      const cleanup = () => {
        next.removeEventListener("loadedmetadata", onMeta);
        next.removeEventListener("canplay", onCan);
        next.removeEventListener("error", onErr);
      };
      const finish = (ok) => {
        if (done) return;
        done = true;
        cleanup();
        resolve(ok);
      };
      const onMeta = () => { try { next.currentTime = cur.currentTime; } catch { /* ignore */ } };
      const onCan = () => {
        if (state.collaps !== c) { finish(false); return; }
        const drift = cur.currentTime - next.currentTime;
        if (Math.abs(drift) > 0.5) { try { next.currentTime = cur.currentTime; } catch { /* ignore */ } }
        next.volume = cur.volume;
        next.muted = cur.muted;
        next.playbackRate = cur.playbackRate;
        if (wasPlaying) next.play().catch(() => {});
        next.style.display = "block";
        cur.style.display = "none";
        try { cur.pause(); } catch { /* ignore */ }
        c.activeIndex = c.activeIndex === 0 ? 1 : 0;
        state.videoEl = next;
        bindCollapsActive();
        setTimeout(() => { try { cur.removeAttribute("src"); cur.load(); } catch { /* ignore */ } }, 250);
        finish(true);
      };
      const onErr = () => finish(false);
      next.muted = true;
      next.addEventListener("loadedmetadata", onMeta);
      next.addEventListener("canplay", onCan);
      next.addEventListener("error", onErr);
      next.src = url;
      next.load();
      setTimeout(() => finish(false), 12000);
    });
  }

  function hardReloadCollapsVideo(url) {
    const video = activeCollapsVideo();
    if (!video) return;
    const position = video.currentTime || 0;
    const wasPlaying = !video.paused && !video.ended;
    video.src = url;
    video.load();
    video.addEventListener("loadedmetadata", function once() {
      video.removeEventListener("loadedmetadata", once);
      if (position > 0) { try { video.currentTime = position; } catch { /* ignore */ } }
      if (wasPlaying) video.play().catch(() => {});
    });
  }

  function stopCollapsSchedule() {
    const c = state.collaps;
    if (!c) return;
    clearTimeout(c.refreshTimer);
    clearInterval(c.uiTimer);
    c.refreshTimer = null;
    c.uiTimer = null;
  }

  function stopCollapsTimers() {
    const c = state.collaps;
    if (!c) return;
    stopCollapsSchedule();
    clearInterval(c.watchdog);
    c.watchdog = null;
  }

  function armCollapsTimers() {
    const c = state.collaps;
    if (!c) return;
    stopCollapsSchedule();
    if (!c.autoRefresh) {
      ensureCollapsWatchdog();
      return;
    }
    const delay = Math.round(c.refreshSec * 1000 * (0.85 + Math.random() * 0.3));
    c.nextAt = Date.now() + delay;
    c.refreshTimer = setTimeout(() => {
      const video = activeCollapsVideo();
      if (video && !video.paused && !video.ended) {
        refreshCollapsNow("таймер").catch((error) => log("collaps-refresh-warn", error.message));
      } else {
        c.pendingRefresh = true;
        armCollapsTimers();
      }
    }, delay);
    ensureCollapsWatchdog();
  }

  function ensureCollapsWatchdog() {
    const c = state.collaps;
    if (!c || c.watchdog) return;
    c.watchdog = setInterval(() => {
      if (!c.autoRefresh || c.refreshing) return;
      const video = activeCollapsVideo();
      if (!video || video.paused || video.ended || video.readyState < 2) return;
      if (Date.now() - (c.lastAdvanceWall || 0) > 8000) {
        refreshCollapsNow("зависание").catch((error) => log("collaps-refresh-warn", error.message));
      }
    }, 2000);
  }

  function teardownCollapsPlayer() {
    const c = state.collaps;
    if (!c) return;
    stopCollapsTimers();
    for (const video of c.videos || []) {
      try {
        video.pause();
        video.removeAttribute("src");
        video.load();
      } catch {
        /* ignore */
      }
    }
    state.collaps = null;
  }

  function renderCollapsControls() {
    const c = state.collaps;
    if (!c) return;
    el.serialPanel.replaceChildren();
    el.serialPanel.classList.add("hidden");
    el.trackPanel.replaceChildren();
    el.trackPanel.classList.remove("hidden");

    if (c.context.isSerial) renderCollapsSerialControls(c.context, c.selection);

    const voices = collapsVoicesForSelection(c.context, c.selection);
    addTrackGroup("Озвучка", voices, (item, index) => {
      const btn = document.createElement("button");
      btn.textContent = collapsVoiceLabel(item, index);
      if (item.vkId === c.selection.vkId) btn.className = "active";
      btn.addEventListener("click", () => switchCollapsSelection({ ...c.selection, voiceIndex: index, vkId: item.vkId }));
      return btn;
    });

    addTrackGroup("Качество", c.sources || [], (source) => {
      const btn = document.createElement("button");
      btn.textContent = source.label;
      if (source.key === c.qualityKey) btn.className = "active";
      btn.addEventListener("click", () => refreshCollapsNow("качество", source.key).catch((error) => showError(error)));
      return btn;
    });

    addTrackGroup("Сессия", [{ refresh: true }, { auto: true }], (item) => {
      const btn = document.createElement("button");
      if (item.refresh) {
        btn.textContent = "обновить";
        btn.addEventListener("click", () => refreshCollapsNow("вручную").catch((error) => showError(error)));
        return btn;
      }
      btn.textContent = c.autoRefresh ? "авто вкл" : "авто выкл";
      if (c.autoRefresh) btn.className = "active";
      btn.addEventListener("click", () => {
        c.autoRefresh = !c.autoRefresh;
        armCollapsTimers();
        renderCollapsControls();
      });
      return btn;
    });

    addTrackGroup("Скорость", [0.5, 1, 1.25, 1.5, 1.75, 2].map((speed) => ({ speed })), (item) => {
      const btn = document.createElement("button");
      btn.textContent = `${item.speed}×`;
      if (item.speed === state.playbackRate) btn.className = "active";
      btn.addEventListener("click", () => {
        state.playbackRate = item.speed;
        try { localStorage.setItem("alphy.playbackRate", String(item.speed)); } catch { /* ignore */ }
        for (const video of c.videos || []) video.playbackRate = item.speed;
        setTimeout(renderCollapsControls, 50);
      });
      return btn;
    });
  }

  function renderCollapsSerialControls(context, selection) {
    const current = chooseCollapsSelection(context, selection);
    const season = context.seasons.find((item) => item.season === current?.season);

    addTrackGroup("", context.seasons, (item) => {
      const btn = document.createElement("button");
      btn.textContent = `Сезон ${item.season}`;
      if (item.season === current?.season) btn.className = "active";
      btn.addEventListener("click", () => {
        const preferred = item.episodes.find((episode) => episode.episode === current?.episode) || item.episodes[0];
        switchCollapsSelection({ season: item.season, episode: preferred?.episode, vkId: current?.vkId, qualityKey: current?.qualityKey });
      });
      return btn;
    }, { panel: el.serialPanel, hideLabel: true, className: "serial-seasons" });

    addTrackGroup("", season?.episodes || [], (item) => {
      const btn = document.createElement("button");
      btn.textContent = String(item.episode);
      if (item.episode === current?.episode) btn.className = "active";
      btn.addEventListener("click", () => {
        switchCollapsSelection({ season: current?.season, episode: item.episode, vkId: current?.vkId, qualityKey: current?.qualityKey });
      });
      return btn;
    }, { panel: el.serialPanel, hideLabel: true, className: "serial-episodes" });
  }

  async function switchCollapsSelection(nextSelection) {
    const c = state.collaps;
    const target = state.currentTarget;
    if (!c || !target || target.kind !== "clps") return;
    const next = chooseCollapsSelection(c.context, nextSelection);
    if (!next || sameCollapsSelection(c.selection, next)) return;
    const token = resolveToken;
    const context = c.context;
    const autoRefresh = c.autoRefresh;
    const refreshSec = c.refreshSec;
    const qualityKey = c.qualityKey;
    teardownCollapsPlayer();
    showPlayerLoading();
    try {
      await playCollapsSelection(context, next, token, 0, { qualityKey, autoRefresh, refreshSec });
    } catch (error) {
      if (!isStale(token)) showError(new Error(`Collaps: ${error.message}`));
    }
  }

  function persistCollapsSelection(target, selection, position = 0) {
    if (!target || target.kind !== "clps") return;
    recordHistory({
      key: keyFor(target),
      kind: target.kind,
      target: cleanTarget(target),
      title: target.title || "",
      poster: target.poster || "",
      year: target.year || "",
      collapsSelection: cleanCollapsSelection(selection),
      position,
      duration: 0,
      progress: 0,
    });
  }

  function settleWithin(promise, timeoutMs) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => resolve(null), timeoutMs);
      promise.then(
        (value) => { clearTimeout(timer); resolve(value); },
        (error) => { clearTimeout(timer); reject(error); },
      );
    });
  }

  async function resolveKpPlaybackSource(kpId, meta, selection) {
    const cachedZona = cacheGet("zona", kpId);
    // A mid-watch Zenith title keeps its player: resume position and озвучка
    // live under the kp: history key and do not transfer to Collaps.
    if (cachedZona?.embedUrl && resumePosition(`kp:${kpId}`) > 0) {
      return { kind: "zen", resolved: cachedZona };
    }
    const cachedCollaps = cacheGet("clpsprobe", kpId);
    if (cachedCollaps?.kpId) return { kind: "clps", hit: cachedCollaps };
    if (cachedZona?.embedUrl) return { kind: "zen", resolved: cachedZona };

    if (!collapsPreviewOnCooldown()) {
      try {
        const hit = await settleWithin(probeCollapsMovie({
          ...(meta || {}),
          kpId: String(kpId),
          title: movieTitle(meta),
          selection,
          rank: 0,
        }), COLLAPS_FAST_PATH_TIMEOUT_MS);
        if (hit?.kpId) return { kind: "clps", hit };
      } catch (error) {
        if (shouldCooldownCollapsPreview(error)) setCollapsPreviewCooldown(error);
        log("collaps-fast-path-warn", { kpId, message: error.message });
      }
    }

    // Loading the player library overlaps the only server-side stage. If Zona is
    // cold, its several seconds are now useful work instead of dead spinner time.
    ensureShaka().catch((error) => log("shaka-preload-warn", error.message));
    return { kind: "zen", resolved: await resolveZona(kpId) };
  }

  async function playKp(kpId, token, opts = {}) {
    const id = String(kpId || "");
    let meta = opts.meta || cacheGet("meta", id);
    const metaTask = meta ? Promise.resolve(meta) : fetchMovieMeta(id).catch(() => null);
    const requestedSelection = normalizeSerialHint(opts.serialSelection)
      || normalizeSerialHint(savedSerialSelection(`kp:${id}`));
    const sourceTask = resolveKpPlaybackSource(id, meta, requestedSelection);
    sourceTask.catch(() => {});

    // Metadata must never serialize in front of source resolution. Give a cold
    // direct link a tiny window for a real title, then let playback continue and
    // paint metadata whenever it arrives.
    if (!meta) meta = await settleWithin(metaTask, 250);
    if (isStale(token)) return;
    if (meta) cacheSet("meta", id, meta, TTL.meta);
    const isSeries = !!(opts.forceSeries || meta?.isSeries || requestedSelection);
    const target = {
      kind: "kp",
      kpId: id,
      title: movieTitle(meta),
      poster: meta?.poster,
      year: meta?.year,
      isSeries,
    };
    state.currentTarget = target;
    setWatchHead(target.title || `kpId ${kpId}`, target);
    renderMeta(meta, target);
    recordOpen(target);

    if (!meta) {
      metaTask.then((fresh) => {
        const current = state.currentTarget;
        if (!fresh || isStale(token) || String(current?.kpId || "") !== id) return;
        meta = fresh;
        cacheSet("meta", id, fresh, TTL.meta);
        current.title = movieTitle(fresh) || current.title;
        current.poster = fresh.poster || current.poster;
        current.year = fresh.year || current.year;
        current.isSeries = !!(opts.forceSeries || fresh.isSeries || requestedSelection || current.isSeries);
        setWatchHead(current.title || `kpId ${id}`, current);
        renderMeta(fresh, current);
        recordOpen(current);
      }).catch(() => {});
    }

    // Collaps -> Zona/Zenith, then HDRezka as the last resort. Any failure in the
    // whole chain (cold Zona resolve, Collaps play error whose Zona fallback also
    // failed, or a Zenith embed with no sources) drops into the catch, which tries
    // HDRezka before letting the original, more familiar error surface.
    try {
      let source = await sourceTask;
      if (isStale(token)) return;
      if (source.kind === "clps") {
        try {
          await playCollaps(id, token, { meta, selection: requestedSelection || source.hit.selection });
          if (!isStale(token)) replaceHash(hashFor(state.currentTarget));
          return;
        } catch (error) {
          if (isStale(token)) return;
          log("collaps-fast-path-fallback", { kpId: id, message: error.message });
          showPlayerLoading();
          state.currentTarget = target;
          setWatchHead(target.title || `kpId ${id}`, target);
          if (meta) renderMeta(meta, target);
          ensureShaka().catch(() => {});
          source = { kind: "zen", resolved: await resolveZona(id) };
          if (isStale(token)) return;
        }
      }

      const resolved = source.resolved;
      if (resolved.zenithId) {
        cacheSet("curatedmeta", `zen:${resolved.zenithId}`, {
          ...(meta || {}),
          title: target.title,
          poster: target.poster,
          year: target.year,
          isSeries: target.isSeries,
          kpId: id,
        }, TTL.enriched);
        replaceHash(`/watch/zen/${encodeURIComponent(resolved.zenithId)}`);
      }
      await playZenithEmbed(resolved.embedUrl, target, token, {
        histKey: `kp:${id}`,
        resume: resumePosition(`kp:${id}`),
        audioLang: savedAudioLang(`kp:${id}`),
        serialSelection: requestedSelection,
        forceSeries: target.isSeries,
      });
    } catch (error) {
      if (isStale(token)) return;
      log("kp-sources-exhausted", { kpId: id, message: error.message });
      showPlayerLoading();
      state.currentTarget = target;
      setWatchHead(target.title || `kpId ${id}`, target);
      if (meta) renderMeta(meta, target);
      replaceHash(`/watch/kp/${encodeURIComponent(id)}`);
      const played = await tryRezkaLastResort(target, meta, token, {
        kpId: id,
        histKey: `kp:${id}`,
        resume: resumePosition(`kp:${id}`),
        serialSelection: requestedSelection,
      });
      if (!played && !isStale(token)) throw error;
    }
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
    // A deep link to a curated zen: title (a shared URL, a bookmark, a reopened
    // tab) arrives with no cached meta, and used to render as a bare
    // "Zenith <id>" with no sidebar — and therefore no credits and no «Похожее».
    // ort:/opr: already healed from the catalog; zen: was simply missing it.
    if (!cachedMeta?.title || !cachedMeta?.poster) {
      healWatchMeta(target, token, cachedMeta, "curatedmeta", `zen:${zenithId}`, `Zenith ${zenithId}`);
    }
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
    if (!meta || !meta.title || !meta.description || !meta.rating) {
      healWatchMeta(target, token, meta, "ortmeta", embedUrl, "Ortified");
    }
    await playOrtifiedCleanroom(embedUrl, target, token);
  }

  async function playOpr(playerUrl, token, ndMeta) {
    const shakaTask = ensureShaka();
    shakaTask.catch(() => {});
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
    if (!meta || !meta.title || !meta.description || !meta.rating) {
      healWatchMeta(target, token, meta, "oprmeta", playerUrl, "Opravar");
    }

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

  // Smart-TV / projector browsers (Samsung Tizen, WebOS, generic SMART-TV, etc.)
  // composite an iframe-embedded <video> without the hardware overlay a top-level
  // player gets, so it micro-stutters whenever the shared main thread is busy.
  // We use this to shed the periodic work we inject into the Ortified srcdoc
  // (see progressHook) on exactly those devices.
  function weakVideoDevice() {
    const ua = (typeof navigator !== "undefined" && navigator.userAgent) || "";
    if (/\bTizen\b|SMART-?TV|SmartTV|\bWebOS\b|Web0S|\bNetCast\b|\bBRAVIA\b|CrKey|AFT[A-Z]|\bHbbTV\b|\bVIDAA\b/i.test(ua)) return true;
    const cores = (typeof navigator !== "undefined" && navigator.hardwareConcurrency) || 0;
    return cores > 0 && cores <= 2;
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
    if (!movie) {
      // No kpId means Collaps/Zona/Zenith can't even be tried — but HDRezka
      // resolves by title, so give the last resort a chance before failing.
      const target = state.currentTarget || { kind: "kp", title, year };
      const played = await tryRezkaLastResort(target, opts.meta || null, token, {
        title, year,
        histKey: keyFor(target),
        resume: resumePosition(keyFor(target)),
        serialSelection: opts.serialSelection,
      });
      if (played || isStale(token)) return;
      throw new Error("PoiskKino не вернул kpId для Zona fallback");
    }
    const meta = mergeMetadata(opts.meta || {}, movie);
    cacheSet("meta", movie.kpId, meta, TTL.meta);
    replaceHash(`/watch/kp/${encodeURIComponent(movie.kpId)}`);
    return playKp(String(movie.kpId), token, {
      meta,
      serialSelection: opts.serialSelection,
      forceSeries: !!(opts.forceSeries || meta.isSeries || opts.serialSelection),
    });
  }

  // =====================================================================
  // Playback — HDRezka (the LAST-RESORT source)
  //
  // Only reached when Collaps AND Zona/Zenith all fail for a title. The resolver
  // relays short-lived signed Voidboost MP4/VTT URLs (a few KB); the video bytes
  // stream browser -> Voidboost directly, so this never loads the resolver with
  // video. It is NEVER prefetched speculatively — the resolver call happens only
  // on a real failed-through click. A localStorage kill switch (alphy.rezka.off)
  // lets it be disabled without a redeploy if the upstream misbehaves.
  // =====================================================================
  const rezkaResolveCache = new Map();
  const REZKA_RESOLVE_TTL_MS = 8 * 60e3;

  function rezkaLastResortEnabled() {
    try { return localStorage.getItem("alphy.rezka.off") !== "1"; } catch { return true; }
  }

  function rezkaTranslatorName(t) {
    const base = t?.name || `Озвучка ${t?.id}`;
    const tags = [t?.director ? "реж." : "", t?.camrip ? "camrip" : ""].filter(Boolean).join(", ");
    return tags ? `${base} (${tags})` : base;
  }

  function savedRezkaPref(key, field) {
    return loadList(STORE_HISTORY).find((h) => h.key === key)?.[field] || null;
  }
  function persistRezkaPref(key, patch) {
    const t = state.currentTarget;
    if (!t || !key) return;
    recordHistory({
      key, kind: t.kind, target: cleanTarget(t),
      title: t.title || "", poster: t.poster || "", year: t.year || "", ...patch,
    });
  }

  async function resolveRezka({ kpId = null, title = null, year = null, rezkaId = null, translator = null } = {}) {
    const params = new URLSearchParams();
    if (rezkaId) params.set("id", String(rezkaId));
    else if (title) { params.set("title", title); if (year) params.set("year", String(year)); }
    else if (kpId) params.set("kp", String(kpId));
    else throw new Error("HDRezka: не задан фильм");
    if (translator) params.set("translator", String(translator));
    const path = `/resolve-rezka?${params}`;
    const cached = rezkaResolveCache.get(path);
    if (cached && cached.expiresAt > Date.now()) return cached.value;
    const data = await resolverJson(path, { retries: 0, timeoutMs: 20000 });
    if (!data.ok || !data.best?.url) throw new Error(data.message || "HDRezka не вернул поток");
    rezkaResolveCache.set(path, { value: data, expiresAt: Date.now() + REZKA_RESOLVE_TTL_MS });
    return data;
  }

  function chooseRezkaStream(streams, wantLabel) {
    const sorted = [...streams].sort((a, b) => (b.quality || 0) - (a.quality || 0));
    if (wantLabel) {
      const match = sorted.find((s) => s.label === wantLabel);
      if (match) return match;
    }
    return sorted[0];
  }

  async function playRezka(resolved, target, token, opts = {}) {
    if (isStale(token)) return;
    await teardownPlayer();
    resetSubtitleRequest();
    const histKey = opts.histKey || keyFor(target);
    const streams = (resolved.streams || []).filter((s) => s.url);
    if (!streams.length) throw new Error("HDRezka не вернул качество");
    const pick = chooseRezkaStream(streams, opts.qualityKey || savedRezkaPref(histKey, "rezkaQuality"));

    state.rezka = {
      streams: [...streams].sort((a, b) => (b.quality || 0) - (a.quality || 0)),
      subtitles: resolved.subtitles || [],
      translators: resolved.translators || [],
      translatorId: resolved.translatorId,
      movie: resolved.movie || {},
      target,
      histKey,
      qualityLabel: pick.label,
    };

    const video = document.createElement("video");
    video.controls = true;
    video.playsInline = true;
    mountPaused(video);
    video.playbackRate = state.playbackRate;
    // Deliberately NO crossOrigin: the Voidboost MP4 host sends no CORS headers,
    // and native <video> playback of a cross-origin source does not need them.
    // Subtitles are attached as same-origin blob <track>s instead (see below), so
    // we never force the media element into a CORS check the CDN would fail.
    if (isStale(token)) return;
    el.playerHost.replaceChildren(video);
    state.videoEl = video;

    const resume = opts.resume || 0;
    video.addEventListener("loadedmetadata", () => {
      if (resume > 5) { try { video.currentTime = resume; } catch { /* ignore */ } }
    }, { once: true });

    let ready = false;
    const onReady = () => {
      if (ready || isStale(token) || state.videoEl !== video) return;
      ready = true;
      video.playbackRate = state.playbackRate;
      renderRezkaControls();
      markPlayerReady();
      const snap = () => {
        const t = state.currentTarget;
        if (t) setTimeout(() => captureVideoSnapshot(histKey, t), 350);
      };
      video.addEventListener("loadeddata", snap, { once: true });
      video.addEventListener("playing", snap);
      video.addEventListener("pause", snap);
      video.addEventListener("seeked", snap);
      setTimeout(snap, 2200);
      startTracking(histKey, target);
      startPlaybackIfAllowed(video);
    };
    video.addEventListener("canplay", onReady, { once: true });
    video.addEventListener("error", () => {
      if (isStale(token) || state.videoEl !== video) return;
      log("rezka-video-error", { code: video.error?.code, histKey });
      // If it never produced a decodable frame, every source is now exhausted, so
      // surface a clear error rather than leaving a silent black player.
      if (video.readyState < 2) {
        showError(new Error("HDRezka: поток не открылся (ссылка истекла или недоступна из вашей сети). Откройте заново."));
      }
    });
    // Start loading the MP4 immediately — do not block first bytes on the subtitle
    // fetch below.
    video.src = pick.url;
    video.load();

    // Subtitles come straight from the resolve. Fetch each VTT client-side (the
    // Voidboost subtitle host sends Access-Control-Allow-Origin: *) and attach it
    // as a same-origin blob <track> so it works without crossOrigin on the video.
    // Runs alongside playback; controls re-render once tracks land.
    attachRezkaSubtitles(video, state.rezka.subtitles, token).then(() => {
      if (!isStale(token) && state.videoEl === video && ready) renderRezkaControls();
    });

    // If canplay is slow (cold CDN), still reveal controls so the user isn't stuck
    // on a spinner over an already-loading <video>.
    setTimeout(onReady, 2600);
  }

  async function attachRezkaSubtitles(video, subs, token) {
    for (const sub of subs || []) {
      if (isStale(token)) return;
      try {
        const res = await fetch(sub.url, { cache: "no-store" });
        if (!res.ok) continue;
        const raw = (await res.text()).replace(/^﻿/, "");
        if (!raw.trim()) continue;
        const vtt = /^WEBVTT/i.test(raw.trim()) ? raw : subtitleTextToVtt(raw, "srt");
        const blobUrl = URL.createObjectURL(new Blob([vtt], { type: "text/vtt;charset=utf-8" }));
        state.subtitleObjectUrls.push(blobUrl);
        const track = document.createElement("track");
        track.kind = "subtitles";
        track.label = sub.label || sub.lang || "Субтитры";
        track.srclang = sub.lang || "und";
        track.src = blobUrl;
        video.appendChild(track);
      } catch (error) {
        log("rezka-subtitle-warn", { url: sub.url, message: error.message });
      }
    }
  }

  function renderRezkaControls() {
    const r = state.rezka;
    const video = state.videoEl;
    if (!r || !video) return;
    el.serialPanel.replaceChildren();
    el.serialPanel.classList.add("hidden");
    el.trackPanel.replaceChildren();
    el.trackPanel.classList.remove("hidden");

    // Audio track (dub) — only when the film page yielded more than one translator.
    if (r.translators.length > 1) {
      addTrackGroup("Озвучка", r.translators, (t) => {
        const btn = document.createElement("button");
        btn.textContent = rezkaTranslatorName(t);
        if (Number(t.id) === Number(r.translatorId)) btn.className = "active";
        btn.addEventListener("click", () => { switchRezkaTranslator(t.id).catch((e) => showError(e)); });
        return btn;
      });
    }

    // Quality — the label is HDRezka's; the active button also shows the real
    // decoded resolution so a "720p" that is physically 480p is never disguised.
    addTrackGroup("Качество", r.streams, (s) => {
      const btn = document.createElement("button");
      const real = (s.label === r.qualityLabel && video.videoWidth)
        ? ` · ${video.videoWidth}×${video.videoHeight}` : "";
      btn.textContent = `${s.label}${real}`;
      if (s.label === r.qualityLabel) btn.className = "active";
      btn.addEventListener("click", () => switchRezkaQuality(s.label));
      return btn;
    });

    // Subtitles — native text tracks (from the blob <track>s), off by default.
    const tracks = [...video.textTracks];
    if (tracks.length) {
      const anyShowing = tracks.some((t) => t.mode === "showing");
      addTrackGroup("Субтитры", [{ off: true }, ...tracks], (item) => {
        const btn = document.createElement("button");
        if (item.off) {
          btn.textContent = "Выкл";
          if (!anyShowing) btn.className = "active";
          btn.addEventListener("click", () => {
            for (const t of video.textTracks) t.mode = "disabled";
            setTimeout(renderRezkaControls, 40);
          });
        } else {
          btn.textContent = item.label || item.language || "Субтитры";
          if (item.mode === "showing") btn.className = "active";
          btn.addEventListener("click", () => {
            for (const t of video.textTracks) t.mode = (t === item ? "showing" : "disabled");
            setTimeout(renderRezkaControls, 40);
          });
        }
        return btn;
      });
    }

    const note = document.createElement("div");
    note.className = "track-note muted";
    note.textContent = "Резервный источник (HDRezka), без рекламы. Ярлык качества — от источника; фактическое разрешение показано на активной кнопке.";
    el.trackPanel.appendChild(note);
  }

  function switchRezkaQuality(label) {
    const r = state.rezka;
    const video = state.videoEl;
    if (!r || !video || label === r.qualityLabel) return;
    const stream = r.streams.find((s) => s.label === label);
    if (!stream?.url) return;
    const at = video.currentTime || 0;
    const wasPlaying = !video.paused;
    r.qualityLabel = label;
    persistRezkaPref(r.histKey, { rezkaQuality: label });
    video.addEventListener("loadedmetadata", () => {
      try { video.currentTime = at; } catch { /* ignore */ }
      if (wasPlaying) video.play().catch(() => { /* ignore */ });
    }, { once: true });
    video.src = stream.url;
    video.load();
    renderRezkaControls();
  }

  async function switchRezkaTranslator(translatorId) {
    const r = state.rezka;
    if (!r || Number(translatorId) === Number(r.translatorId)) return;
    if (!r.movie?.rezkaId) return;
    const token = resolveToken;
    const at = state.videoEl?.currentTime || 0;
    const resolved = await resolveRezka({ rezkaId: r.movie.rezkaId, translator: translatorId });
    if (isStale(token)) return;
    persistRezkaPref(r.histKey, { rezkaTranslator: String(translatorId) });
    await playRezka(resolved, r.target, token, {
      histKey: r.histKey,
      resume: at,
      qualityKey: r.qualityLabel,
    });
  }

  // The last-resort entry point: resolve HDRezka for a title and play it. Returns
  // true if playback started, false if HDRezka could not deliver (so the caller
  // surfaces the ORIGINAL, more familiar error instead of a Rezka-specific one).
  async function tryRezkaLastResort(target, meta, token, opts = {}) {
    if (!rezkaLastResortEnabled()) return false;
    const kpId = opts.kpId || (target?.kind === "kp" ? target.kpId : null) || meta?.kpId || null;
    const title = cleanMovieTitle(opts.title || movieTitle(meta) || target?.title || "");
    const year = opts.year || meta?.year || target?.year || null;
    if (!kpId && !title) return false;
    // A series episode picker is out of scope for the fallback — HDRezka series
    // need per-episode get_stream calls the resolver does not yet make.
    if (target?.isSeries || meta?.isSeries || opts.serialSelection) return false;
    try {
      const savedDub = opts.histKey ? savedRezkaPref(opts.histKey, "rezkaTranslator") : null;
      // Title+year is the resolver's fast path (no KinoPoisk->title lookup).
      const resolved = await resolveRezka({
        title: title || null,
        year: title ? year : null,
        kpId: title ? null : kpId,
        translator: savedDub,
      });
      if (isStale(token)) return true;
      log("rezka-last-resort", { title: resolved.movie?.title, best: resolved.best?.label });
      await playRezka(resolved, target, token, {
        histKey: opts.histKey || keyFor(target),
        resume: opts.resume || 0,
      });
      return true;
    } catch (error) {
      if (isStale(token)) return true;
      log("rezka-last-resort-fail", { message: error.message });
      return false;
    }
  }

  // Descriptive list fields (жанры, страны, режиссёры, актёры). An empty array is
  // truthy, so a plain {...right, ...left} spread would let an empty left-hand
  // list mask a populated right-hand one — the exact case where a partial cached
  // entry would wipe out freshly fetched credits.
  const META_LIST_FIELDS = ["genres", "countries", "directors", "cast"];

  function pickList(left, right, field) {
    const a = Array.isArray(left?.[field]) ? left[field] : [];
    const b = Array.isArray(right?.[field]) ? right[field] : [];
    return a.length ? a : b;
  }

  function mergeMetadata(base, enriched) {
    const left = base && typeof base === "object" ? base : {};
    const right = enriched && typeof enriched === "object" ? enriched : {};
    const merged = {
      ...right,
      ...left,
      title: left.title || movieTitle(left) || right.title || movieTitle(right) || "",
      year: left.year || right.year || "",
      poster: left.poster || right.poster || "",
      backdrop: left.backdrop || right.backdrop || "",
      description: left.description || left.shortDescription || right.description || right.shortDescription || "",
      isSeries: left.isSeries ?? right.isSeries ?? false,
      movieLength: left.movieLength || right.movieLength || null,
      ageRating: left.ageRating ?? right.ageRating ?? null,
      ratingMpaa: left.ratingMpaa || right.ratingMpaa || null,
      rating: {
        ...(right.rating || {}),
        ...(left.rating || {}),
      },
    };
    for (const field of META_LIST_FIELDS) merged[field] = pickList(left, right, field);
    return merged;
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
    document.title = `${title} — ${SITE_TITLE}`;
    updateBookmarkBtn(target);
  }

  // MPAA is stored as a bare code ("r", "pg13"); Kinopoisk's own age limit is the
  // number Russian viewers actually recognise, so it leads and MPAA follows.
  function ageBadge(meta) {
    const age = Number(meta?.ageRating);
    if (Number.isFinite(age) && age >= 0) return `${age}+`;
    const mpaa = String(meta?.ratingMpaa || "").trim();
    return mpaa ? mpaa.toUpperCase().replace(/^NC17$/, "NC-17").replace(/^PG13$/, "PG-13") : "";
  }

  function metaFactRow(label, value) {
    if (!value) return "";
    return `<div class="mf-row"><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></div>`;
  }

  function renderMeta(meta, target) {
    if (!meta) {
      el.metaPanel.classList.add("hidden");
      el.metaPanel.replaceChildren();
      return;
    }
    const title = movieTitle(meta) || target.title || "";
    const year = meta.year || target.year || "";
    const poster = meta.poster || target.poster || "";
    const desc = meta.description || meta.shortDescription || "";
    state.currentMeta = mergeMetadata(state.currentMeta || {}, {
      ...meta,
      title,
      year,
      poster,
      description: desc,
      isSeries: meta.isSeries ?? target?.isSeries,
    });
    // Render from the MERGED view, not the incoming fragment: a later partial
    // update (say a bare title from the resolver) must not blank out credits that
    // an earlier, richer payload already delivered.
    const view = state.currentMeta;
    if (view?.kpId && target) attachHistoryKpId(keyFor(target), view.kpId);

    const kp = view.rating?.kp;
    const imdb = view.rating?.imdb;
    const isSeries = view.isSeries ?? target?.isSeries ?? false;
    const age = ageBadge(view);
    const sub = [
      year,
      isSeries ? "сериал" : "фильм",
      view.movieLength ? formatDuration(view.movieLength, isSeries) : "",
    ].filter(Boolean).join(" · ");

    // Two children only — poster and body. Narrow layouts put them side by side,
    // and a fixed pair survives the fact that ratings/description/credits are each
    // individually optional (a grid row-span over a variable number of implicit
    // rows does not, which is how the two columns used to overlap on phones).
    let body = `<div class="meta-headline">`;
    body += `<div class="mp-title">${escapeHtml(title)}</div>`;
    body += `<div class="mp-sub">${escapeHtml(sub)}${age ? `<span class="mp-age">${escapeHtml(age)}</span>` : ""}</div>`;
    body += `</div>`;
    if (kp || imdb) {
      body += `<div class="meta-ratings">`;
      if (kp) body += `<div class="rt"><b>${escapeHtml(Number(kp).toFixed(1))}</b><span>Кинопоиск</span></div>`;
      if (imdb) body += `<div class="rt"><b>${escapeHtml(Number(imdb).toFixed(1))}</b><span>IMDb</span></div>`;
      body += `</div>`;
    }
    if (desc) {
      body += `<div class="meta-desc">${escapeHtml(desc)}</div>`;
      body += `<button class="meta-desc-toggle hidden" type="button">ещё</button>`;
    }

    const facts =
      metaFactRow("Жанр", (view.genres || []).slice(0, 3).join(", ")) +
      metaFactRow("Страна", (view.countries || []).slice(0, 2).join(", ")) +
      metaFactRow(
        (view.directors || []).length > 1 ? "Режиссёры" : "Режиссёр",
        (view.directors || []).slice(0, 2).join(", "),
      ) +
      metaFactRow("В ролях", (view.cast || []).slice(0, 5).join(", "));
    if (facts) body += `<dl class="meta-facts">${facts}</dl>`;

    const posterHtml = poster
      ? `<div class="meta-poster"><img src="${escapeAttr(poster)}" alt=""></div>`
      : "";
    el.metaPanel.innerHTML = `${posterHtml}<div class="meta-body">${body}</div>`;
    const posterHost = el.metaPanel.querySelector(".meta-poster");
    if (posterHost) {
      addCardBookmark(posterHost, target, {
        title,
        year,
        poster,
        rating: view.rating || {},
        movieLength: view.movieLength || null,
        isSeries,
      });
    }
    // The synopsis is clamped rather than scrolled: a scroll region inside a
    // sidebar hides that there is more text and clips the last line mid-height.
    // The toggle only appears when the text is actually longer than the clamp.
    const descNode = el.metaPanel.querySelector(".meta-desc");
    const toggle = el.metaPanel.querySelector(".meta-desc-toggle");
    if (descNode && toggle && descNode.scrollHeight > descNode.clientHeight + 2) {
      toggle.classList.remove("hidden");
      toggle.addEventListener("click", () => {
        const open = descNode.classList.toggle("open");
        toggle.textContent = open ? "свернуть" : "ещё";
      });
    }
    el.metaPanel.classList.remove("hidden");
    scheduleWatchExtras(target);
  }

  // =====================================================================
  // Watch-page enrichment: credits backfill + «Похожее»
  //
  // Both are deliberately post-playback and deduped per navigation. Neither is
  // allowed to delay the player, and neither re-requests anything the caches
  // already answer — opening the same title twice costs nothing.
  // =====================================================================
  let watchExtrasKey = "";

  function scheduleWatchExtras(target) {
    const kpId = String(state.currentMeta?.kpId || target?.kpId || "");
    const key = `${keyFor(target)}|${kpId}`;
    if (!target || watchExtrasKey === key) return;
    watchExtrasKey = key;
    const token = resolveToken;
    scheduleIdle(() => {
      if (isStale(token)) return;
      runWatchExtras(target, kpId, token).catch((error) => log("watch-extras-warn", error.message));
    }, 1200);
  }

  async function runWatchExtras(target, knownKpId, token) {
    let kpId = knownKpId;
    if (!/^\d+$/.test(kpId)) {
      // Curated zen:/ort: items carry no Kinopoisk id until an admin fills their
      // metadata in. Resolving it by title once (cached 30 days) is what lets
      // those titles show credits and «Похожее» at all.
      const title = state.currentMeta?.title || target?.title || "";
      kpId = String(await window.alphyForYou?.resolveKpId?.(title, state.currentMeta?.year || target?.year) || "");
      if (isStale(token) || !/^\d+$/.test(kpId)) return;
      attachHistoryKpId(keyFor(target), kpId);
      if (state.currentMeta) state.currentMeta.kpId = kpId;
    }
    await Promise.all([
      backfillCredits(target, kpId, token).catch((error) => log("credits-warn", error.message)),
      renderSimilarRow(kpId, token).catch((error) => log("similar-warn", error.message)),
    ]);
  }

  // Only ever runs for titles the resolver could not describe (zen:/ort:/nd:
  // targets carry no kinopoisk.dev document). kp: titles already arrived complete
  // from /movie, so this costs nothing for them.
  async function backfillCredits(target, kpId, token) {
    if (!/^\d+$/.test(kpId)) return;
    const current = state.currentMeta || {};
    if ((current.genres || []).length && (current.directors || []).length) return;
    const extras = await window.alphyForYou?.filmExtras?.(kpId);
    if (!extras || isStale(token) || !state.currentTarget) return;
    if (keyFor(state.currentTarget) !== keyFor(target)) return;
    const merged = mergeMetadata(state.currentMeta || {}, extras);
    state.currentMeta = merged;
    cacheSet("meta", kpId, mergeMetadata(cacheGet("meta", kpId) || {}, extras), TTL.meta);
    renderMeta(merged, state.currentTarget);
  }

  async function renderSimilarRow(kpId, token) {
    if (!el.similarSection || !el.similarRow) return;
    hideSimilarRow();
    if (!/^\d+$/.test(kpId)) return;
    const items = await window.alphyForYou?.similarRow?.(kpId);
    if (!items?.length || isStale(token)) return;
    const frag = document.createDocumentFragment();
    for (const item of items) {
      // A recommendation that is already curated opens through its resolved
      // target — instant playback instead of a fresh kp resolve.
      const ready = window.alphyCatalog?.findReady?.(item.title, item.year, item.isSeries);
      const entry = ready ? { ...ready, kpId: ready.kpId || String(item.target?.kpId || "") } : item;
      frag.appendChild(makeCard({
        title: entry.title,
        sub: [entry.year, entry.isSeries ? "сериал" : "фильм"].filter(Boolean).join(" · "),
        poster: entry.poster,
        rating: entry.rating,
        movieLength: entry.movieLength,
        isSeries: entry.isSeries,
        bookmark: { target: entry.target, details: entry },
        onClick: () => openCuratedItem(entry),
      }));
    }
    el.similarRow.replaceChildren(frag);
    el.similarSection.classList.remove("hidden");
  }

  function hideSimilarRow() {
    el.similarSection?.classList.add("hidden");
    el.similarRow?.replaceChildren();
  }

  // =====================================================================
  // Playback — Ortified cleanroom iframe
  // =====================================================================
  async function playOrtifiedCleanroom(embedUrl, target, token) {
    if (isStale(token)) return;
    showPlayerLoading();
    let html;
    try {
      html = await fetchCachedEmbedText(embedUrl, { preferSandbox: true, label: "ortified" });
    } catch (error) {
      // api.ortified.ws answers 422 to any request from a non-Russian IP — for a
      // user who normally streams from RU that means a VPN was left on. Surface the
      // actionable hint instead of the raw "XHR 422".
      if (/\b422\b/.test(String(error?.message || error))) {
        throw new Error("Попробуйте выключить VPN");
      }
      throw error;
    }
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
  function zenithBrowserFetchBlocked() {
    try { return Number(localStorage.getItem("alphy.zenithBrowserBlockedUntil") || 0) > Date.now(); }
    catch { return false; }
  }

  function rememberZenithBrowserFetch(blocked) {
    try {
      if (blocked) localStorage.setItem("alphy.zenithBrowserBlockedUntil", String(Date.now() + ZENITH_DIRECT_BLOCK_MS));
      else localStorage.removeItem("alphy.zenithBrowserBlockedUntil");
    } catch { /* best-effort optimization */ }
  }

  function zenithIdOf(embedUrl) {
    return String(embedUrl || "").match(/\/movie\/(\d+)/i)?.[1] || "";
  }

  // A parse is usable when it can actually start playback. A series additionally
  // needs its season list, otherwise the episode picker would come up empty and
  // the cheap cached copy would be worse than a fresh resolve.
  function zenithParsedUsable(value, wantSeasons) {
    if (!value) return false;
    const hasSource = !!(value.sources?.dash || value.sources?.hls || value.sources?.dasha);
    const hasSeasons = !!value.playlist?.seasons?.length;
    if (!hasSource && !hasSeasons) return false;
    return wantSeasons ? hasSeasons : true;
  }

  function readZenithParsed(id, wantSeasons) {
    const memo = zenithParsedCache.get(id);
    if (memo?.expiresAt > Date.now() && zenithParsedUsable(memo.value, wantSeasons)) return memo.value;
    const stored = cacheGet("zenith", id);
    if (zenithParsedUsable(stored, wantSeasons)) {
      zenithParsedCache.set(id, { value: stored, expiresAt: Date.now() + ZENITH_PARSED_CACHE_MS });
      return stored;
    }
    return null;
  }

  function writeZenithParsed(id, value) {
    if (!id || !zenithParsedUsable(value, false)) return value;
    zenithParsedCache.set(id, { value, expiresAt: Date.now() + ZENITH_PARSED_CACHE_MS });
    if (zenithParsedCache.size > 12) zenithParsedCache.delete(zenithParsedCache.keys().next().value);
    cacheSet("zenith", id, value, TTL.zenith);
    return value;
  }

  function dropZenithParsed(embedUrl) {
    const id = zenithIdOf(embedUrl);
    if (!id) return;
    zenithParsedCache.delete(id);
    try { localStorage.removeItem(`${CACHE_PREFIX}zenith:${id}`); } catch { /* ignore */ }
  }

  // Single entry point for "give me this embed's sources": memory -> localStorage
  // -> one direct browser attempt -> resolver. In-flight requests are shared, so a
  // hover prefetch that is still running is JOINED by the click instead of being
  // raced by a second identical resolve.
  async function resolveZenithParsed(embedUrl, { force = false, wantSeasons = false } = {}) {
    const id = zenithIdOf(embedUrl);
    if (!id) throw new Error("Не удалось извлечь Zenith id");
    if (!force) {
      const cached = readZenithParsed(id, wantSeasons);
      if (cached) return cached;
    }
    const inflightKey = `${id}|${wantSeasons ? "s" : "-"}|${force ? "f" : "-"}`;
    const existing = zenithParsedInflight.get(inflightKey);
    if (existing) return existing;
    const pending = (async () => {
      let parsed = null;
      if (!force && !zenithBrowserFetchBlocked()) {
        try {
          // A browser that can reach Zenith directly normally answers quickly. Do
          // one abortable CORS attempt; XHR/sandbox retries can each hang for tens
          // of seconds and the resolver is both faster and more reliable here.
          const html = await fetchThirdPartyText(embedUrl, {
            directOnly: true,
            timeoutMs: ZENITH_BROWSER_FAST_WINDOW_MS,
            label: "zenith",
          });
          const value = parseZenithEmbed(html);
          rememberZenithBrowserFetch(false);
          if (zenithParsedUsable(value, wantSeasons)) parsed = value;
        } catch (error) {
          rememberZenithBrowserFetch(true);
          log("zenith-browser-fallback", { message: error.message });
        }
      }
      if (!parsed) parsed = await fetchZenithFromResolver(id, force);
      return writeZenithParsed(id, parsed);
    })().finally(() => zenithParsedInflight.delete(inflightKey));
    zenithParsedInflight.set(inflightKey, pending);
    return pending;
  }

  async function fetchZenithFromResolver(id, force = false) {
    // The resolver answers cached hits with `public, max-age=300`; letting the
    // browser honour that (instead of no-store) makes a re-open free. A forced
    // refresh exists precisely to defeat every cache, so it reloads.
    const data = await resolverJson(`/zenith?id=${encodeURIComponent(id)}`, {
      fetchCache: force ? "reload" : "default",
    });
    if (!data.hasSources) throw new Error("Worker Zenith fallback не отдал источники");
    return {
      sources: data.sources || {},
      meta: data.meta || {},
      playlist: data.playlist || { current: null, seasons: [] },
    };
  }

  async function playZenithEmbed(embedUrl, target, token, opts = {}) {
    if (isStale(token)) return;
    showPlayerLoading();
    state.zenithEmbedUrl = embedUrl;
    const shakaTask = ensureShaka();
    shakaTask.catch(() => {});
    const parsed = await resolveZenithParsed(embedUrl, {
      force: !!opts.forceWorker,
      wantSeasons: !!(opts.forceSeries || target?.isSeries || opts.serialSelection),
    });
    if (isStale(token)) return;

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
    await shakaTask;
    if (isStale(token)) return;
    try {
      await playShaka(media.url, media.kind, token, {
        resume: opts.resume || 0,
        audioLang: opts.audioLang,
        serial,
      });
    } catch (error) {
      // The only way a cached parse can hurt is a signature that expired between
      // the resolve and the click. Re-mint once, then let the error stand.
      if (opts.forceWorker || isStale(token)) throw error;
      log("zenith-source-refresh", { message: error.message });
      dropZenithParsed(embedUrl);
      await playZenithEmbed(embedUrl, target, token, { ...opts, forceWorker: true });
      return;
    }
    if (isStale(token)) return;
    if (opts.histKey) startTracking(opts.histKey, target);
  }

  async function playShaka(url, kind, token, opts = {}) {
    if (isStale(token)) return;
    await ensureShaka();
    if (isStale(token)) return;
    await teardownPlayer();
    state.opravar = opts.opravar || null;
    state.serial = opts.serial || null;
    resetSubtitleRequest();
    const video = document.createElement("video");
    video.controls = true;
    video.playsInline = true;
    mountPaused(video);
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
      streaming: {
        bufferingGoal: 20,
        rebufferingGoal: 2,
        bufferBehind: 30,
        retryParameters: { maxAttempts: 3, baseDelay: 450, backoffFactor: 1.5 },
      },
      manifest: { dash: { ignoreMinBufferTime: true } },
      abr: {
        enabled: true,
        defaultBandwidthEstimate: initialBandwidthEstimate(4_000_000),
        switchInterval: 4,
        bandwidthUpgradeTarget: 0.8,
        bandwidthDowngradeTarget: 0.95,
      },
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
    startPlaybackIfAllowed(video);
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

  function shakaAbrEnabled(player) {
    try { return player?.getConfiguration?.().abr?.enabled !== false; }
    catch { return true; }
  }

  function startTracking(histKey, target) {
    stopTracking();
    state.trackInterval = setInterval(() => {
      const v = state.videoEl;
      if (!v) return;
      const dur = v.duration;
      const cur = v.currentTime;
      if (!dur || !isFinite(dur) || dur <= 0) return;
      const audioLang = state.player?.getVariantTracks?.().find((t) => t.active)?.language || soapActiveAudioLang();
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
      if (state.collaps?.selection) entry.collapsSelection = cleanCollapsSelection(state.collaps.selection);
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
    const hasSnapshot = typeof snapshot === "string" && snapshot.startsWith("data:image/jpeg");
    state.pendingOrtEntry = {
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
      ...(hasSnapshot ? { snapshot } : {}),
    };
    // recordHistory is a synchronous parse+stringify+localStorage write of the
    // whole list. The srcdoc player shares this event loop, so doing it on every
    // ~4s report visibly freezes the video on weak TV browsers. Coalesce to ~15s
    // (snapshot-bearing ticks always land so the continue-card thumbnail refreshes)
    // and flush the newest on teardown so the last position still persists.
    if (!hasSnapshot && Date.now() - state.lastOrtWriteAt < 15000) return;
    flushOrtProgress();
  }

  function flushOrtProgress() {
    const entry = state.pendingOrtEntry;
    if (!entry) return;
    state.pendingOrtEntry = null;
    state.lastOrtWriteAt = Date.now();
    recordHistory(entry);
  }

  async function teardownPlayer() {
    stopTracking();
    flushOrtProgress();
    teardownCollapsPlayer();
    if (state.player) {
      await state.player.destroy().catch(() => {});
      state.player = null;
    }
    if (state.hls) {
      try { state.hls.destroy(); } catch { /* ignore */ }
      state.hls = null;
    }
    revokeSubtitleObjectUrls();
    resetSubtitleRequest();
    state.videoEl = null;
    state.opravar = null;
    state.serial = null;
    state.rezka = null;
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
          const keepAuto = shakaAbrEnabled(player);
          player.selectAudioLanguage(track.language, (track.roles || [])[0]);
          if (!keepAuto) selectHighestShakaVariant(player, track.language);
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
    const abrEnabled = shakaAbrEnabled(player);
    addTrackGroup("Качество", [{ auto: true }, ...qualityChoices], (track) => {
      const btn = document.createElement("button");
      if (track.auto) {
        const active = variants.find((item) => item.active);
        btn.textContent = active?.height ? `Авто (${active.height}p)` : "Авто";
        if (abrEnabled) btn.className = "active";
        btn.addEventListener("click", () => {
          player.configure({ abr: { enabled: true } });
          setTimeout(renderTracks, 250);
        });
        return btn;
      }
      btn.textContent = `${track.height ? `${track.height}p` : "auto"} ${bitrateLabel(track)}`.trim();
      if (!abrEnabled && track.active) btn.className = "active";
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
  function fetchCachedEmbedText(url, options = {}, ttlMs = 2 * 60e3) {
    const cached = embedTextCache.get(url);
    if (cached?.text && cached.expiresAt > Date.now()) return Promise.resolve(cached.text);
    if (embedTextInflight.has(url)) return embedTextInflight.get(url);
    const pending = fetchThirdPartyText(url, options)
      .then((text) => {
        embedTextCache.set(url, { text, expiresAt: Date.now() + ttlMs });
        return text;
      })
      .finally(() => embedTextInflight.delete(url));
    embedTextInflight.set(url, pending);
    return pending;
  }

  function progressHook() {
    // We build the Ortified cleanroom srcdoc ourselves, so a script we inject runs
    // in the SAME document as the player's <video> and can read its position even
    // though the parent page can't reach a cross-origin iframe. We can't stop the
    // player resetting on reload, but we can report where the viewer stopped so the
    // homepage shows progress. Posts {alphyOrtProgress, position, duration} out.
    //
    // On smart-TV/projector browsers the iframe <video> has no hardware overlay, so
    // it micro-stutters whenever this shared main thread is busy. There we drop the
    // canvas snapshot entirely (drawImage+toDataURL forces a synchronous GPU frame
    // readback — the single most expensive thing we run) and report position less
    // often. The continue-card just loses its thumbnail on those devices.
    const weak = weakVideoDevice();
    const snapshotEnabled = weak ? "false" : "true";
    const sendMs = weak ? 10000 : 4000;
    return `<script data-cleanroom="progress-hook">
(() => {
  const SNAPSHOT = ${snapshotEnabled};
  const SEND_MS = ${sendMs};
  const hooked = new WeakSet();
  let lastSent = 0;
  let lastShot = 0;
  const send = (v) => {
    const now = Date.now();
    if (now - lastSent < SEND_MS) return;
    if (!v.duration || !isFinite(v.duration) || v.duration <= 0) return;
    lastSent = now;
    let snapshot = '';
    if (SNAPSHOT && now - lastShot > 20000 && v.videoWidth && v.videoHeight) {
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
    if (options.directOnly) return directFetchText(url, timeoutMs);
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

  function warmNewdeafConnections() {
    for (const origin of unique([dailyMirrorCandidates()[0], "https://newdeaf.co"])) {
      if (!origin || newdeafWarmOrigins.has(origin)) continue;
      newdeafWarmOrigins.add(origin);
      const link = document.createElement("link");
      link.rel = "preconnect";
      link.href = origin;
      link.crossOrigin = "anonymous";
      document.head.appendChild(link);
    }
  }

  function warmSoapConnections(masterUrl = "") {
    const origins = ["https://soap4youand.me", SOAP_CDN_ORIGIN];
    try {
      if (masterUrl) origins.push(new URL(masterUrl).origin);
    } catch { /* ignore malformed catalog entries */ }
    for (const origin of unique(origins)) {
      if (!origin || soapWarmOrigins.has(origin)) continue;
      soapWarmOrigins.add(origin);
      const link = document.createElement("link");
      link.rel = "preconnect";
      link.href = origin;
      link.crossOrigin = "anonymous";
      document.head.appendChild(link);
    }
  }

  function warmCollapsConnections(mediaUrl = "") {
    const origins = [new URL(COLLAPS_BASE_URL).origin];
    try {
      if (mediaUrl) origins.push(new URL(mediaUrl).origin);
    } catch {
      /* ignore signed URL parse failures */
    }
    for (const origin of unique(origins)) {
      if (!origin || collapsWarmOrigins.has(origin)) continue;
      collapsWarmOrigins.add(origin);
      const link = document.createElement("link");
      link.rel = "preconnect";
      link.href = origin;
      link.crossOrigin = "anonymous";
      document.head.appendChild(link);
    }
  }

  function scheduleIdle(callback, timeout = 2500) {
    if (typeof requestIdleCallback === "function") {
      return requestIdleCallback(callback, { timeout });
    }
    return setTimeout(callback, Math.min(timeout, 1000));
  }

  function prefetchTopNewdeafPage(candidates) {
    const pageUrl = candidates?.[0]?.url;
    if (!pageUrl || newdeafPagePrefetches.has(pageUrl)) return;
    const warmPlayer = (parsed) => {
      const embedUrl = parsed?.ortified?.[0];
      if (embedUrl) return fetchCachedEmbedText(embedUrl, { preferSandbox: true, label: "ortified-prefetch" });
      return null;
    };
    const cached = cacheGet("ndpage", pageUrl);
    if (cached) {
      scheduleIdle(() => warmPlayer(cached)?.catch((error) => log("ortified-prefetch-warn", error.message)));
      return;
    }
    newdeafPagePrefetches.add(pageUrl);
    scheduleIdle(() => {
      resolveNewdeafPage(pageUrl)
        .then((parsed) => warmPlayer(parsed))
        .catch((error) => {
          newdeafPagePrefetches.delete(pageUrl);
          log("newdeaf-prefetch-warn", error.message);
        });
    });
  }

  function prefetchTopSoapManifest(movies) {
    const movie = (movies || []).find((m) => m?.m);
    const url = movie?.m;
    if (!url || soapManifestPrefetches.has(url)) return;
    soapManifestPrefetches.add(url);
    warmSoapConnections(url);
    scheduleIdle(() => {
      fetch(url, {
        cache: "force-cache",
        credentials: "omit",
        mode: "cors",
        referrerPolicy: "no-referrer",
      })
        .then(async (response) => {
          const text = await response.text();
          if (!response.ok || !/#EXTM3U/i.test(text)) throw new Error(`manifest ${response.status}`);
        })
        .catch((error) => {
          soapManifestPrefetches.delete(url);
          log("soap-prefetch-warn", error.message);
        });
    }, 1800);
  }

  // Intent-time Zenith warm. Cheap by construction: a cached parse short-circuits
  // before any request, the resolver answers warm hits from its own edge cache,
  // and the hover token bucket caps how many of these a browsing burst can start.
  async function warmZenithParsed(embedUrl, details = {}) {
    if (!zenithIdOf(embedUrl)) return;
    await resolveZenithParsed(embedUrl, { wantSeasons: !!details?.isSeries });
  }

  async function prepareTarget(target, details = {}) {
    if (!target?.kind) return;
    const prepKey = keyFor(target);
    if (preparedTargets.has(prepKey)) return;
    preparedTargets.add(prepKey);
    try {
      if (target.kind === "kp") {
        const zonaEmbedUrl = cacheGet("zona", target.kpId)?.embedUrl || "";
        if (zonaEmbedUrl) ensureShaka().catch(() => {});
        if (!collapsPreviewOnCooldown()) {
          warmCollapsConnections();
          try {
            await probeCollapsMovie({ ...details, kpId: String(target.kpId), rank: 0 });
          } catch (error) {
            if (shouldCooldownCollapsPreview(error)) setCollapsPreviewCooldown(error);
            throw error;
          }
        } else if (zonaEmbedUrl) {
          await ensureShaka();
          await warmZenithParsed(zonaEmbedUrl, details);
        }
      } else if (target.kind === "clps") {
        warmCollapsConnections();
        const playlist = await fetchCollapsPlaylist(target.kpId);
        const item = playlist.items.find((entry) =>
          (!target.season || entry.season === target.season) &&
          (!target.episode || entry.episode === target.episode)) || chooseCollapsProbeItem(playlist.items);
        if (item?.vkId) await fetchCollapsVideo(item.vkId);
      } else if (target.kind === "soap") {
        if (window.MediaSource) ensureHls().catch(() => {});
        const movies = await loadSoapCatalog();
        const movie = movies.find((entry) => String(entry.id) === String(target.soapId));
        if (movie) prefetchTopSoapManifest([movie]);
      } else if (target.kind === "zen") {
        // Curated shelves are mostly zen: items, and their whole click-to-play
        // cost is "load Shaka" + "resolve this embed". Warming both on intent is
        // what turns a click into an immediate player instead of a spinner.
        await ensureShaka();
        await warmZenithParsed(`https://api.zenithjs.ws/embed/movie/${encodeURIComponent(target.zenithId)}`, details);
      } else if (target.kind === "opr") {
        await ensureShaka();
      } else if (target.kind === "ort") {
        await fetchCachedEmbedText(target.embedUrl, { preferSandbox: true, label: "ortified-intent" });
      } else if (target.kind === "nd") {
        const parsed = await resolveNewdeafPage(target.pageUrl);
        const embedUrl = parsed?.ortified?.[0];
        if (embedUrl) await fetchCachedEmbedText(embedUrl, { preferSandbox: true, label: "ortified-intent" });
      }
    } catch (error) {
      preparedTargets.delete(prepKey);
      throw error;
    }
  }

  function armCardIntent(card, target, details = {}) {
    if (!card || !target?.kind) return;
    let timer = null;
    let claimedSpeculativeSlot = false;
    const run = (speculative) => {
      if (speculative) {
        if (claimedSpeculativeSlot) return;
        if (!claimSpeculativeIntent()) return;
        claimedSpeculativeSlot = true;
      }
      prepareTarget(target, details).catch((error) => log("intent-prefetch-warn", error.message));
    };
    const schedule = () => {
      clearTimeout(timer);
      timer = setTimeout(() => run(true), 220);
    };
    const cancel = () => { clearTimeout(timer); timer = null; };
    card.addEventListener("pointerenter", schedule, { passive: true });
    card.addEventListener("pointerleave", cancel, { passive: true });
    card.addEventListener("focus", schedule);
    card.addEventListener("blur", cancel);
    card.addEventListener("pointerdown", () => run(false), { passive: true });
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
  function buildCollapsContext(playlist) {
    const items = Array.isArray(playlist?.items) ? playlist.items : [];
    if (!playlist?.isSerial) {
      return {
        provider: "collaps",
        kpId: playlist?.kpId || "",
        titleName: playlist?.titleName || "",
        isSerial: false,
        voices: items,
        seasons: [],
      };
    }

    const seasonMap = new Map();
    for (const item of items) {
      const seasonNumber = positiveInt(item.season) || 1;
      const episodeNumber = positiveInt(item.episode) || 1;
      if (!seasonMap.has(seasonNumber)) seasonMap.set(seasonNumber, new Map());
      const episodeMap = seasonMap.get(seasonNumber);
      if (!episodeMap.has(episodeNumber)) episodeMap.set(episodeNumber, []);
      episodeMap.get(episodeNumber).push(item);
    }
    const seasons = [...seasonMap.entries()]
      .map(([season, episodeMap]) => ({
        season,
        episodes: [...episodeMap.entries()]
          .map(([episode, voices]) => ({ episode, voices }))
          .sort((a, b) => a.episode - b.episode),
      }))
      .filter((season) => season.episodes.length)
      .sort((a, b) => a.season - b.season);
    return {
      provider: "collaps",
      kpId: playlist?.kpId || "",
      titleName: playlist?.titleName || "",
      isSerial: true,
      voices: [],
      seasons,
    };
  }

  function collapsVoicesForSelection(context, selection) {
    if (!context?.isSerial) return context?.voices || [];
    const picked = chooseCollapsSelection(context, selection);
    const season = context.seasons.find((item) => item.season === picked?.season);
    const episode = season?.episodes.find((item) => item.episode === picked?.episode);
    return episode?.voices || [];
  }

  function chooseCollapsSelection(context, requested = {}) {
    if (!context) return null;
    const req = normalizeCollapsSelection(requested) || {};
    if (!context.isSerial) {
      const voices = context.voices || [];
      const indexByVk = voices.findIndex((item) => req.vkId && item.vkId === req.vkId);
      const indexByNumber = Number.isInteger(req.voiceIndex) && voices[req.voiceIndex] ? req.voiceIndex : -1;
      const voiceIndex = indexByVk >= 0 ? indexByVk : indexByNumber >= 0 ? indexByNumber : 0;
      const item = voices[voiceIndex];
      return item ? {
        voiceIndex,
        vkId: item.vkId,
        voiceName: collapsVoiceLabel(item, voiceIndex),
        item,
        ...(req.qualityKey ? { qualityKey: req.qualityKey } : {}),
      } : null;
    }

    const seasons = context.seasons || [];
    const season = seasons.find((item) => item.season === req.season) || seasons[0];
    const episode =
      season?.episodes.find((item) => item.episode === req.episode) ||
      season?.episodes[0];
    const voices = episode?.voices || [];
    const indexByVk = voices.findIndex((item) => req.vkId && item.vkId === req.vkId);
    const indexByNumber = Number.isInteger(req.voiceIndex) && voices[req.voiceIndex] ? req.voiceIndex : -1;
    const voiceIndex = indexByVk >= 0 ? indexByVk : indexByNumber >= 0 ? indexByNumber : 0;
    const item = voices[voiceIndex];
    return item ? {
      season: season.season,
      episode: episode.episode,
      voiceIndex,
      vkId: item.vkId,
      voiceName: collapsVoiceLabel(item, voiceIndex),
      item,
      ...(req.qualityKey ? { qualityKey: req.qualityKey } : {}),
    } : null;
  }

  function sameCollapsSelection(a, b) {
    return !!a && !!b &&
      Number(a.season || 0) === Number(b.season || 0) &&
      Number(a.episode || 0) === Number(b.episode || 0) &&
      String(a.vkId || "") === String(b.vkId || "") &&
      String(a.qualityKey || "") === String(b.qualityKey || "");
  }

  function cleanCollapsSelection(value = {}) {
    const out = {};
    const season = positiveInt(value.season);
    const episode = positiveInt(value.episode);
    const voiceIndex = Number.parseInt(String(value.voiceIndex ?? ""), 10);
    if (season) out.season = season;
    if (episode) out.episode = episode;
    if (Number.isInteger(voiceIndex) && voiceIndex >= 0) out.voiceIndex = voiceIndex;
    if (value.vkId) out.vkId = String(value.vkId);
    if (value.voiceName) out.voiceName = String(value.voiceName).slice(0, 120);
    if (collapsQualityByKey(value.qualityKey)) out.qualityKey = String(value.qualityKey);
    return out;
  }

  function normalizeCollapsSelection(value = {}) {
    if (!value || typeof value !== "object") return null;
    const selection = cleanCollapsSelection(value);
    return Object.keys(selection).length ? selection : null;
  }

  function collapsSelectionFromEpisodeKey(value) {
    const match = String(value || "").match(/^s(\d+)e(\d+)$/i);
    return match ? { season: Number(match[1]), episode: Number(match[2]) } : null;
  }

  function collapsQualityByKey(key) {
    return COLLAPS_QUALITY_FIELDS.find(([field]) => field === key) || null;
  }

  function chooseCollapsSource(sources, qualityKey = "") {
    const list = Array.isArray(sources) ? sources : [];
    const explicit = list.find((source) => source.key === qualityKey);
    if (explicit) return explicit;
    const connection = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
    const effective = String(connection?.effectiveType || "").toLowerCase();
    const downlink = Number(connection?.downlink || 0);
    const cap = connection?.saveData || /(^|-)2g$/.test(effective)
      ? 480
      : effective === "3g" || (downlink > 0 && downlink < 5)
        ? 720
        : 1080;
    // Progressive MP4 cannot adapt after startup. Begin at a quality that reaches
    // first frame quickly; 2K/4K remain one tap away and an explicit saved choice
    // always wins on the next open.
    return list.find((source) => Number(source.height || 0) <= cap) || list[list.length - 1] || null;
  }

  function initialBandwidthEstimate(fallback) {
    const nav = globalThis.navigator || {};
    const connection = nav.connection || nav.mozConnection || nav.webkitConnection;
    const effective = String(connection?.effectiveType || "").toLowerCase();
    const downlink = Number(connection?.downlink || 0);
    if (connection?.saveData || /(^|-)2g$/.test(effective)) return 700_000;
    if (effective === "3g") return 1_800_000;
    if (downlink > 0) return Math.max(900_000, Math.min(10_000_000, downlink * 650_000));
    return fallback;
  }

  function collapsVoiceLabel(item, index = 0) {
    return [item?.voiceStudio, item?.voiceType].filter(Boolean).join(" · ") ||
      item?.name ||
      `Озвучка ${index + 1}`;
  }

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
  function safeDecode(value) {
    try { return decodeURIComponent(String(value || "")); }
    catch { return String(value || ""); }
  }
  function legacyHashPath(path) {
    return `/#${path.startsWith("/") ? path : `/${path}`}`;
  }
  function shortOrtifiedPath(embedUrl) {
    try {
      const url = new URL(String(embedUrl || ""));
      const id = url.pathname.match(/^\/embed\/movie\/(\d+)/i)?.[1];
      if (!/^api\.ortified\.ws$/i.test(url.host) || !id) return "";
      const season = positiveInt(url.searchParams.get("season"));
      const episode = positiveInt(url.searchParams.get("episode"));
      return season && episode ? `/o/${id}/s${season}e${episode}` : `/o/${id}`;
    } catch {
      return "";
    }
  }
  function ortifiedUrlFromShort(id, episodeKey) {
    const url = new URL(`https://api.ortified.ws/embed/movie/${encodeURIComponent(id)}`);
    const match = String(episodeKey || "").match(/^s(\d+)e(\d+)$/i);
    if (match) {
      url.searchParams.set("season", match[1]);
      url.searchParams.set("episode", match[2]);
    }
    return url.href;
  }
  // The watch route keeps only {id, season, episode}, so playOrt always receives the
  // rebuilt clean URL. Meta handoffs must be keyed by that same form — catalog items
  // store whatever embed the admin added (including duplicated ?episode params).
  function canonicalOrtEmbedUrl(embedUrl) {
    const short = shortOrtifiedPath(embedUrl);
    if (!short) return String(embedUrl || "");
    const segs = short.split("/").filter(Boolean);
    return ortifiedUrlFromShort(segs[1], segs[2]);
  }
  function shortNewdeafPath(pageUrl) {
    try {
      const url = new URL(String(pageUrl || ""));
      if (!/(^|\.)newdeaf\.co$/i.test(url.host)) return "";
      const path = url.pathname.split("/").filter(Boolean).map(safeDecode).join("/").replace(/\.html$/i, "");
      if (!/^(film|serial|multfilm|anime|multserial|multserialy)\//i.test(path)) return "";
      return `/n/${path.split("/").map(encodeURIComponent).join("/")}`;
    } catch {
      return "";
    }
  }
  function newdeafUrlFromShortPath(parts) {
    const path = (parts || []).join("/").replace(/^\/+/, "").replace(/\.html$/i, "");
    if (!/^(film|serial|multfilm|anime|multserial|multserialy)\//i.test(path)) return "";
    const origin = dailyMirrorCandidates()[0] || "https://newdeaf.co";
    return `${origin}/${path.split("/").map(encodeURIComponent).join("/")}.html`;
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
        if (/^plapi\.cdnvideohub\.com$/i.test(url.host) && /\/playlist$/i.test(url.pathname)) {
          const id = url.searchParams.get("id");
          if (/^\d+$/.test(id || "")) return go(`/c/${id}`);
        }
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
      ageRating: Number.isFinite(Number(meta.ageRating)) ? Number(meta.ageRating) : null,
      ratingMpaa: meta.ratingMpaa || "",
      genres: Array.isArray(meta.genres) ? meta.genres : [],
      countries: Array.isArray(meta.countries) ? meta.countries : [],
      directors: Array.isArray(meta.directors) ? meta.directors : [],
      cast: Array.isArray(meta.cast) ? meta.cast : [],
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
      // Whatever the curator stored is served straight from the snapshot, so a
      // listed title opens with full metadata and zero API calls.
      ageRating: item.ageRating,
      ratingMpaa: item.ratingMpaa,
      genres: item.genres,
      countries: item.countries,
      directors: item.directors,
      cast: item.cast,
    };
    cacheSet("curatedmeta", keyFor(target), meta, TTL.enriched);
    if (target.kind === "ort") cacheSet("ortmeta", canonicalOrtEmbedUrl(target.embedUrl), meta, TTL.enriched);
    if (target.kind === "opr") {
      cacheSet("oprmeta", target.playerUrl, { ...meta, pageUrl: target.pageUrl || "" }, TTL.enriched);
    }
    if (target.kind === "kp") cacheSet("meta", target.kpId, { ...meta, kpId: target.kpId }, TTL.enriched);
    if (target.kind === "clps") cacheSet("meta", target.kpId, { ...meta, kpId: target.kpId }, TTL.enriched);
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
    dropExpiredCache();
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
    el.searchInput.addEventListener("focus", () => {
      warmNewdeafConnections();
      warmCollapsConnections();
    });
    el.searchInput.addEventListener("keydown", (e) => { if (e.key === "Enter") onSearchSubmit(); });
    el.bookmarksToggle.addEventListener("click", () => go("/bookmarks"));
    el.soapBrowseBtn?.addEventListener("click", showSoapBrowser);
    el.soapFilter?.addEventListener("input", renderSoapBrowser);
    el.soapToggle?.addEventListener("click", () => {
      state.soapFourKOnly = !(state.soapFourKOnly !== false);
      renderSoapBrowser();
    });
    el.saveResolverBtn.addEventListener("click", saveResolver);
    el.healthBtn.addEventListener("click", () => testResolver());
    window.addEventListener("hashchange", route);
    window.addEventListener("popstate", route);
    window.addEventListener("storage", (event) => {
      if (event.key !== STORE_BOOKMARKS) return;
      updateBookmarksNav();
      syncBookmarkControls();
      if (parseLocationRoute().view === "bookmarks") showBookmarks();
    });
    window.addEventListener("message", onOrtProgress);
    bindKeyboard();

    // Migrate legacy hash/query-param deep links to path routes.
    if (location.hash) {
      const legacyPath = location.hash.replace(/^#/, "") || "/";
      if (parseLegacyHash(location.hash)) replaceHash(legacyPath);
    } else {
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
      const list = (v) => (Array.isArray(v) ? v.filter(Boolean).map(String) : []);
      return {
        ok: true,
        kpId: hit.kpId,
        poster: kinopoiskPosterUrl(m, hit),
        rating: { kp: num(m.rating?.kp) ?? num(hit.rating?.kp), imdb: num(m.rating?.imdb) ?? num(hit.rating?.imdb) },
        imdbId: m.externalId?.imdb || hit.externalId?.imdb || "",
        name: movieTitle(m) || title,
        year: m.year || hit.year || year || "",
        // Descriptive metadata rides along on the /movie call the refresh already
        // makes, so baking it into the curated snapshot is free. Once stored, the
        // watch page renders жанр/страна/режиссёр/актёры for that title with no
        // request at all — that is the whole point of curating it here.
        isSeries: m.isSeries ?? hit.isSeries ?? false,
        movieLength: num(m.movieLength) ?? num(hit.movieLength),
        description: m.description || m.shortDescription || "",
        ageRating: num(m.ageRating),
        ratingMpaa: m.ratingMpaa || "",
        genres: list(m.genres),
        countries: list(m.countries),
        directors: list(m.directors),
        cast: list(m.cast),
      };
    } catch {
      return { ok: false };
    }
  }

  window.alphyBridge = {
    getCurrentCuratedItem: currentCuratedItem,
    openCuratedItem,
    addCardBookmark,
    armCardIntent,
    prepareTarget,
    resolveKpPlaybackSource,
    resolveZenithParsed,
    layoutMobileGrid,
    resolvePosterByTitle,
    resolveCardMeta,
  };

  boot();
})();
