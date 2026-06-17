(() => {
  "use strict";

  const STORE_RESOLVER = "alphy.resolverBaseUrl";
  const params = new URLSearchParams(location.search);
  const isLocal = /^(127\.0\.0\.1|localhost)$/i.test(location.hostname);

  const el = {
    statusLine: document.getElementById("statusLine"),
    settingsToggle: document.getElementById("settingsToggle"),
    diagToggle: document.getElementById("diagToggle"),
    settingsPanel: document.getElementById("settingsPanel"),
    resolverInput: document.getElementById("resolverInput"),
    saveResolverBtn: document.getElementById("saveResolverBtn"),
    healthBtn: document.getElementById("healthBtn"),
    resolverState: document.getElementById("resolverState"),
    searchForm: document.getElementById("searchForm"),
    queryInput: document.getElementById("queryInput"),
    goBtn: document.getElementById("goBtn"),
    zonaOnlyBtn: document.getElementById("zonaOnlyBtn"),
    metaTitle: document.getElementById("metaTitle"),
    metaSubtitle: document.getElementById("metaSubtitle"),
    providerBadge: document.getElementById("providerBadge"),
    playerHost: document.getElementById("playerHost"),
    trackPanel: document.getElementById("trackPanel"),
    sourcePanel: document.getElementById("sourcePanel"),
    resultsPanel: document.getElementById("resultsPanel"),
    diagnostics: document.getElementById("diagnostics"),
    facts: document.getElementById("facts"),
    log: document.getElementById("log"),
    copyReportBtn: document.getElementById("copyReportBtn"),
  };

  const state = {
    resolverBaseUrl: "",
    playerPlaceholder: "",
    logs: [],
    facts: {},
    player: null,
    activeProvider: "idle",
    selectedMovie: null,
    selectedNewdeaf: null,
    zenith: null,
    sources: {},
    audioNames: [],
  };

  // Monotonic token for user-initiated resolves. Every fresh user action bumps
  // it; any async chain whose token is no longer the active one must bail out
  // before mounting a player, tearing one down, or rewriting meta, so a slow
  // earlier request can never stomp a newer one (the "плеер не туда" bug).
  let resolveToken = 0;
  const nextToken = () => (resolveToken += 1);
  const isStale = (token) => token !== resolveToken;

  function boot() {
    state.playerPlaceholder = el.playerHost.innerHTML;
    const resolverFromUrl = params.get("resolver");
    if (resolverFromUrl) localStorage.setItem(STORE_RESOLVER, cleanBaseUrl(resolverFromUrl));
    // The resolver moved off Cloudflare (workers.dev is rate-limited/empty from
    // Russia) to Deno Deploy. Migrate any saved legacy Worker URL to the new
    // default so returning visitors stop hitting the dead Cloudflare endpoint.
    const defaultResolver = isLocal ? "http://127.0.0.1:8787" : "https://alphytv.alphy.deno.net";
    const legacyResolvers = ["https://alphy-resolver.p-tikhonin.workers.dev"];
    let storedResolver = cleanBaseUrl(localStorage.getItem(STORE_RESOLVER) || "");
    if (!storedResolver || legacyResolvers.includes(storedResolver)) {
      storedResolver = defaultResolver;
      localStorage.setItem(STORE_RESOLVER, storedResolver);
    }
    state.resolverBaseUrl = storedResolver;
    el.resolverInput.value = state.resolverBaseUrl;
    updateResolverState();
    bindEvents();
    log("boot", "app ready", { origin: location.origin, resolver: state.resolverBaseUrl || null });
    if (params.get("q")) {
      el.queryInput.value = params.get("q");
      resolveInput(false).catch(showError);
    } else if (params.get("url")) {
      el.queryInput.value = params.get("url");
      resolveInput(false).catch(showError);
    } else if (params.get("kpId")) {
      playZonaMovie({ kpId: params.get("kpId"), name: params.get("title") || `kpId ${params.get("kpId")}` }).catch(showError);
    } else if (params.get("zenith")) {
      playZenithEmbed(`https://api.zenithjs.ws/embed/movie/${encodeURIComponent(params.get("zenith"))}`, { name: `Zenith ${params.get("zenith")}` }).catch(showError);
    }
  }

  function bindEvents() {
    el.settingsToggle.addEventListener("click", () => el.settingsPanel.classList.toggle("hidden"));
    el.diagToggle.addEventListener("click", () => el.diagnostics.classList.toggle("hidden"));
    el.saveResolverBtn.addEventListener("click", saveResolver);
    el.healthBtn.addEventListener("click", () => testResolver().catch(showError));
    el.searchForm.addEventListener("submit", (event) => {
      event.preventDefault();
      resolveInput(false).catch(showError);
    });
    el.zonaOnlyBtn.addEventListener("click", () => resolveInput(true).catch(showError));
    el.copyReportBtn.addEventListener("click", copyReport);
  }

  function saveResolver() {
    state.resolverBaseUrl = cleanBaseUrl(el.resolverInput.value);
    if (state.resolverBaseUrl) localStorage.setItem(STORE_RESOLVER, state.resolverBaseUrl);
    else localStorage.removeItem(STORE_RESOLVER);
    updateResolverState();
    log("config", "resolver saved", { resolver: state.resolverBaseUrl || null });
  }

  function cleanBaseUrl(value) {
    return String(value || "").trim().replace(/\/+$/, "");
  }

  function updateResolverState() {
    el.resolverState.textContent = state.resolverBaseUrl ? "configured" : "missing";
    state.facts.resolver = state.resolverBaseUrl || "missing";
    renderFacts();
  }

  async function testResolver() {
    saveResolver();
    const data = await resolverJson("/health");
    log("worker", "health ok", data);
    el.resolverState.textContent = data.ok ? "ok" : "unexpected";
  }

  async function resolveInput(forceZona) {
    const value = el.queryInput.value.trim();
    if (!value) throw new Error("Введите название или URL");
    // Supersede any resolve already in flight; its chain will see a stale token
    // and bail before touching the UI.
    const token = nextToken();
    clearResults();
    // Any new resolve immediately clears the previous player so the user never
    // sees stale content while the new lookup (or a failing one) is in flight.
    await destroyPlayer();
    setBusy(true);
    try {
      if (forceZona) {
        await searchByTitle(value, { autoZona: false, skipNewdeaf: true }, token);
        return;
      }
      if (/^https?:\/\//i.test(value)) {
        const url = new URL(value);
        if (/api\.ortified\.ws$/i.test(url.host)) {
          await playOrtifiedCleanroom(url.href, { title: "Ortified direct" }, token);
          return;
        }
        if (/api\.zenithjs\.ws$/i.test(url.host)) {
          await playZenithEmbed(url.href, { name: "Zenith direct" }, {}, token);
          return;
        }
        if (/newdeaf\.co$/i.test(url.host)) {
          await resolveNewdeafUrl(url.href, token);
          return;
        }
      }
      await searchByTitle(value, { autoZona: false, skipNewdeaf: false }, token);
    } finally {
      // Only the still-current resolve may release the busy state; a newer one
      // owns it now.
      if (!isStale(token)) setBusy(false);
    }
  }

  async function searchByTitle(query, options = {}, token = nextToken()) {
    setMeta("Поиск", query, "warn");
    setBadge("Search", "warn");
    // Run both lookups in parallel but do NOT wait for the slowest. PoiskKino
    // (via the Worker) is fast and reliable, so render it the moment it lands;
    // the Newdeaf scrape — which can hang up to its timeout on a slow/blocked
    // mirror — merges in afterwards instead of blocking the whole result list.
    const poiskPromise = searchPoiskkino(query).catch((error) => ({ error }));
    const newdeafPromise = options.skipNewdeaf
      ? Promise.resolve({ candidates: [] })
      : searchNewdeaf(query).catch((error) => ({ error }));

    const poisk = await poiskPromise;
    if (isStale(token)) return;
    if (poisk?.error) log("poisk-error", poisk.error.message);
    const pkResults = poisk?.results || [];
    renderSearchResults([], pkResults, query);

    const newdeaf = await newdeafPromise;
    if (isStale(token)) return;
    if (newdeaf?.error) log("newdeaf-error", newdeaf.error.message);
    const ndCandidates = newdeaf?.candidates || [];
    renderSearchResults(ndCandidates, pkResults, query);
    log("search", "search complete", { newdeaf: ndCandidates.length, poiskkino: pkResults.length });
    if (!ndCandidates.length && !pkResults.length) throw new Error("Ничего не найдено");
  }

  async function searchPoiskkino(query, year) {
    const path = `/search?q=${encodeURIComponent(query)}&limit=10${year ? `&year=${encodeURIComponent(year)}` : ""}`;
    log("poisk", "searching title", { query, year: year || null });
    return resolverJson(path);
  }

  async function searchNewdeaf(query) {
    const mirrors = dailyMirrorCandidates();
    log("newdeaf", "searching daily mirrors", { query, mirrors });
    for (const mirror of mirrors) {
      const searchUrl = `${mirror}/index.php?do=search&subaction=search&story=${encodeURIComponent(query)}`;
      try {
        const html = await fetchThirdPartyText(searchUrl, { preferSandbox: true, directFallback: false, label: "newdeaf-search", timeoutMs: 12000 });
        const candidates = parseNewdeafSearch(html, searchUrl);
        log("newdeaf", "mirror parsed", { mirror, candidates: candidates.length });
        if (candidates.length) return { mirror, candidates };
      } catch (error) {
        log("newdeaf-warn", "mirror failed", { mirror, message: error.message });
      }
    }
    return { mirror: mirrors[0], candidates: [] };
  }

  async function resolveNewdeafUrl(pageUrl, token = nextToken()) {
    setMeta("Newdeaf", pageUrl, "warn");
    setBadge("Newdeaf", "warn");
    const candidates = pageUrlCandidates(pageUrl);
    let parsed = null;
    let resolvedUrl = pageUrl;
    for (const candidate of candidates) {
      try {
        log("newdeaf", "fetching page", { pageUrl: candidate });
        const html = await fetchThirdPartyText(candidate, { preferSandbox: true, directFallback: false, label: "newdeaf-page" });
        parsed = parseNewdeafPage(html, candidate);
        resolvedUrl = candidate;
        log("newdeaf", "page parsed", {
          title: parsed.title,
          ortified: parsed.ortified.length,
          allo: parsed.allo.length,
        });
        if (parsed.ortified.length || parsed.allo.length) break;
      } catch (error) {
        log("newdeaf-warn", "page candidate failed", { pageUrl: candidate, message: error.message });
      }
    }
    if (!parsed) throw new Error("Newdeaf page fetch failed");
    if (isStale(token)) return;
    state.selectedNewdeaf = { pageUrl: resolvedUrl, ...parsed };
    state.facts.newdeaf = {
      pageUrl: resolvedUrl,
      title: parsed.title,
      ortified: parsed.ortified.length,
      allo: parsed.allo.length,
    };
    renderFacts();

    if (parsed.ortified.length) {
      await playOrtifiedCleanroom(parsed.ortified[0], parsed, token);
      return;
    }

    if (parsed.allo.length) {
      log("decision", "Newdeaf only exposed Allo; using Zona fallback", {
        title: parsed.title,
        alloUrl: parsed.allo[0],
      });
      await fallbackZonaFromNewdeaf(parsed, token);
      return;
    }

    log("decision", "Newdeaf page has no supported player; using Zona fallback", { title: parsed.title });
    await fallbackZonaFromNewdeaf(parsed, token);
  }

  async function fallbackZonaFromNewdeaf(parsed, token = nextToken()) {
    const title = cleanMovieTitle(parsed.title || "");
    if (!title) throw new Error("Не удалось извлечь название для Zona fallback");
    const found = await searchPoiskkino(title, parsed.year);
    if (isStale(token)) return;
    const movie = chooseMovie(found.results || [], title, parsed.year);
    if (!movie) throw new Error("PoiskKino did not return a kpId for Zona fallback");
    await playZonaMovie(movie, { reason: "newdeaf-allo-only", newdeafTitle: parsed.title }, token);
  }

  async function playZonaMovie(movie, context = {}, token = nextToken()) {
    if (!movie?.kpId) throw new Error("Missing kpId for Zona resolver");
    state.activeProvider = "zona";
    state.selectedMovie = movie;
    setMeta(movieTitle(movie), `kpId ${movie.kpId} · Zona/Zenith`, "warn");
    setBadge("Zona resolve", "warn");
    log("zona", "resolving kpId to Zenith", { kpId: movie.kpId, context });
    const resolved = await resolverJson(`/resolve-zona?kpId=${encodeURIComponent(movie.kpId)}`);
    if (isStale(token)) return;
    if (!resolved.embedUrl) throw new Error("Zona resolver did not return a Zenith embed");
    state.facts.zona = {
      kpId: movie.kpId,
      zenithId: resolved.zenithId,
      embedUrl: resolved.embedUrl,
      requestCount: (resolved.requests || []).length,
    };
    renderFacts();
    await playZenithEmbed(resolved.embedUrl, movie, resolved, token);
  }

  async function playZenithEmbed(embedUrl, movie = {}, resolved = {}, token = nextToken()) {
    if (isStale(token)) return;
    await destroyPlayer();
    state.activeProvider = "zona";
    state.zenith = { embedUrl, resolved };
    setMeta(movieTitle(movie) || "Zenith", "Custom Shaka player · ads config ignored · subtitles absent", "ok");
    setBadge("Zona/Zenith", "ok");
    log("zenith", "fetching embed", { embedUrl });
    const html = await fetchThirdPartyText(embedUrl, { preferSandbox: false, label: "zenith" });
    if (isStale(token)) return;
    let parsed = parseZenithEmbed(html);
    if (!parsed.sources.dash && !parsed.sources.hls && !parsed.sources.dasha) {
      log("zenith-warn", "browser embed fetch returned no sources; trying Worker metadata fallback");
      parsed = await resolveZenithThroughWorker(embedUrl);
    }
    state.sources = parsed.sources;
    state.audioNames = parsed.meta.audioNames || [];
    state.facts.zenith = {
      title: parsed.meta.title || movieTitle(movie),
      dash: !!parsed.sources.dash,
      dasha: !!parsed.sources.dasha,
      hls: !!parsed.sources.hls,
      adsConfig: /adsConfig/i.test(html),
      audio: state.audioNames,
      subtitles: "none from Zona",
    };
    renderFacts();
    renderSources();
    const bestUrl = parsed.sources.dash || parsed.sources.hls || parsed.sources.dasha;
    const kind = parsed.sources.dash ? "dash" : parsed.sources.hls ? "hls" : "dasha";
    if (!bestUrl) throw new Error("Zenith embed did not expose dash/hls");
    await playShaka(bestUrl, kind, token);
  }

  async function resolveZenithThroughWorker(embedUrl) {
    const id = embedUrl.match(/\/movie\/(\d+)/i)?.[1] || "";
    if (!id) throw new Error("Cannot parse Zenith id for Worker fallback");
    const data = await resolverJson(`/zenith?id=${encodeURIComponent(id)}`);
    if (!data.hasSources) throw new Error("Worker Zenith fallback returned no sources");
    log("zenith", "Worker metadata fallback extracted sources", {
      id,
      dash: !!data.sources?.dash,
      hls: !!data.sources?.hls,
      bytes: data.bytes,
    });
    return { sources: data.sources || {}, meta: data.meta || {} };
  }

  async function playOrtifiedCleanroom(embedUrl, meta = {}, token = nextToken()) {
    if (isStale(token)) return;
    await destroyPlayer();
    state.activeProvider = "ortified";
    setMeta(meta.title || "Ortified", "Cleanroom iframe · ad config stripped before player init", "ok");
    setBadge("Ortified Cleanroom", "ok");
    log("ortified", "fetching embed HTML", { embedUrl, mode: "cleanroom-block" });
    const html = await fetchThirdPartyText(embedUrl, { preferSandbox: true, label: "ortified" });
    if (isStale(token)) return;
    const sanitized = sanitizeOrtifiedHtml(html, embedUrl, "cleanroom-block");
    state.facts.ortified = sanitized.stats;
    state.facts.ortified.embedUrl = embedUrl;
    renderFacts();
    if (!sanitized.stats.ok) throw new Error("Ortified HTML did not contain makePlayer");
    const iframe = document.createElement("iframe");
    iframe.allow = "autoplay; fullscreen; encrypted-media; picture-in-picture";
    iframe.allowFullscreen = true;
    iframe.referrerPolicy = "no-referrer";
    iframe.srcdoc = sanitized.html;
    el.playerHost.replaceChildren(iframe);
    el.trackPanel.classList.add("hidden");
    el.sourcePanel.classList.add("hidden");
    log("ortified", "cleanroom loaded", sanitized.stats);
  }

  async function playShaka(url, kind, token = nextToken()) {
    if (isStale(token)) return;
    if (state.player) {
      await state.player.destroy().catch(() => {});
      state.player = null;
      el.trackPanel.replaceChildren();
      el.trackPanel.classList.add("hidden");
    }
    const video = document.createElement("video");
    video.controls = true;
    video.playsInline = true;
    video.autoplay = true;
    video.crossOrigin = "anonymous";
    if (isStale(token)) return;
    el.playerHost.replaceChildren(video);

    if (!window.shaka) throw new Error("Shaka did not load");
    shaka.polyfill.installAll();
    if (!shaka.Player.isBrowserSupported()) throw new Error("Shaka says browser is unsupported");

    const player = new shaka.Player();
    state.player = player;
    await player.attach(video);
    player.configure({
      streaming: { retryParameters: { maxAttempts: 2, baseDelay: 500, backoffFactor: 1.4 } },
      manifest: { dash: { ignoreMinBufferTime: true } },
    });
    player.addEventListener("error", (event) => log("shaka-error", "player error", event.detail || null));
    player.addEventListener("trackschanged", renderTracks);
    player.addEventListener("variantchanged", renderTracks);
    player.addEventListener("textchanged", renderTracks);
    log("play", `loading ${kind}`, { url });
    await player.load(url);
    if (isStale(token)) {
      // A newer resolve took over while this manifest was loading; tear our
      // player down so it never plays audio behind the new content.
      log("stale", "shaka load superseded; tearing down", { url });
      await player.destroy().catch(() => {});
      if (state.player === player) state.player = null;
      return;
    }
    renderTracks();
    try {
      await video.play();
      log("play", "video.play ok");
    } catch (error) {
      log("play", "manual click may be required", { message: error.message });
    }
  }

  async function destroyPlayer() {
    if (state.player) {
      await state.player.destroy().catch(() => {});
      state.player = null;
    }
    el.trackPanel.replaceChildren();
    el.trackPanel.classList.add("hidden");
    el.sourcePanel.replaceChildren();
    el.sourcePanel.classList.add("hidden");
    // Reset the player area to its idle placeholder so a torn-down player never
    // leaves stale content (e.g. an old iframe) visible during the next resolve.
    if (state.playerPlaceholder) el.playerHost.innerHTML = state.playerPlaceholder;
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
        log("track", "selected audio", { language: track.language, label: btn.textContent });
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
        log("track", "selected quality", { height: track.height, bandwidth: track.bandwidth, language: track.language });
        setTimeout(renderTracks, 250);
      });
      return btn;
    });

    addTrackGroup("Субтитры", [{ off: true }, ...texts], (track) => {
      const btn = document.createElement("button");
      if (track.off) {
        btn.textContent = texts.length ? "Off" : "нет в Zona";
        if (!texts.length || !player.isTextTrackVisible || !player.isTextTrackVisible()) btn.className = "active";
        btn.addEventListener("click", () => player.setTextTrackVisibility(false));
        return btn;
      }
      btn.textContent = track.label || track.language || "subs";
      if (track.active && player.isTextTrackVisible && player.isTextTrackVisible()) btn.className = "active";
      btn.addEventListener("click", () => {
        player.selectTextTrack(track);
        player.setTextTrackVisibility(true);
        log("track", "selected subtitles", { language: track.language, label: track.label });
        setTimeout(renderTracks, 250);
      });
      return btn;
    });
  }

  function renderSources() {
    el.sourcePanel.replaceChildren();
    el.sourcePanel.classList.remove("hidden");
    const grid = document.createElement("div");
    grid.className = "source-grid";
    for (const kind of ["dash", "dasha", "hls"]) {
      const card = document.createElement("div");
      card.className = "source-card";
      const url = state.sources[kind] || "";
      card.innerHTML = `<b>${escapeHtml(kind.toUpperCase())}</b><code>${escapeHtml(url || "missing")}</code>`;
      const btn = document.createElement("button");
      btn.type = "button";
      btn.disabled = !url;
      btn.textContent = url ? `Play ${kind}` : "missing";
      btn.addEventListener("click", () => playShaka(url, kind).catch(showError));
      card.appendChild(btn);
      grid.appendChild(card);
    }
    el.sourcePanel.appendChild(grid);
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
      span.textContent = "none";
      buttons.appendChild(span);
    } else {
      items.forEach((item, index) => buttons.appendChild(renderButton(item, index)));
    }
    group.append(label, buttons);
    el.trackPanel.appendChild(group);
  }

  function renderSearchResults(newdeaf, poisk, originalQuery) {
    clearResults();
    const grid = document.createElement("div");
    grid.className = "result-grid";

    for (const item of newdeaf) {
      const card = resultCard(item.title, "Newdeaf page", item.poster);
      const btn = document.createElement("button");
      btn.className = "primary";
      btn.textContent = "Resolve Newdeaf";
      btn.addEventListener("click", () => resolveNewdeafUrl(item.url).catch(showError));
      const small = document.createElement("small");
      small.textContent = item.url;
      card.append(small, btn);
      grid.appendChild(card);
    }

    for (const movie of poisk) {
      const card = resultCard(movieTitle(movie), `kpId ${movie.kpId || "-"} · ${movie.year || "no year"}`, movie.poster);
      const btn = document.createElement("button");
      btn.textContent = "Play via Zona";
      btn.disabled = !movie.kpId;
      btn.addEventListener("click", () => playZonaMovie(movie, { reason: "manual-search", originalQuery }).catch(showError));
      card.appendChild(btn);
      grid.appendChild(card);
    }

    if (!newdeaf.length && !poisk.length) {
      grid.innerHTML = '<p class="muted">Ничего не найдено.</p>';
    }
    el.resultsPanel.appendChild(grid);
  }

  function resultCard(title, subtitle, poster) {
    const card = document.createElement("article");
    card.className = "result-card";
    const top = document.createElement("div");
    if (poster) {
      const img = document.createElement("img");
      img.src = poster;
      img.alt = "";
      top.appendChild(img);
    }
    top.insertAdjacentHTML("beforeend", `<b>${escapeHtml(title || "untitled")}</b><small>${escapeHtml(subtitle || "")}</small>`);
    card.appendChild(top);
    return card;
  }

  function clearResults() {
    el.resultsPanel.replaceChildren();
  }

  function parseNewdeafSearch(html, base) {
    const doc = new DOMParser().parseFromString(html, "text/html");
    const seen = new Set();
    const out = [];
    for (const a of doc.querySelectorAll("a[href]")) {
      const href = isNewdeafPage(a.getAttribute("href"), base);
      if (!href || seen.has(href)) continue;
      seen.add(href);
      const card = a.closest("article, .short, .shortstory, .story, .item, .th-item, .movie-item") || a.parentElement;
      const title = compact(a.textContent) || compact(card && card.textContent).slice(0, 140) || new URL(href).pathname.split("/").pop();
      const img = card && card.querySelector && card.querySelector("img[src], img[data-src], img[data-original]");
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
      inputBytes: out.length,
      adScriptBlocks: (out.match(/<script\s+data-name=["']ad["'][\s\S]*?<\/script>/gi) || []).length,
      adsConfigRefs: (out.match(/ads:\s*adsConfig\s*,/g) || []).length,
      makePlayerRefs: (out.match(/makePlayer\s*\(/g) || []).length,
      preludeInjected: true,
    };
    out = out.replace(/<script\s+data-name=["']ad["'][\s\S]*?<\/script>/i, '<script data-name="ad">var middleCount = 0, adsConfig = {};</' + "script>");
    out = out.replace(/ads:\s*adsConfig\s*,/g, "ads: {},");
    if (!/<base\s/i.test(out) && /<head([^>]*)>/i.test(out)) out = out.replace(/<head([^>]*)>/i, `<head$1><base href="${escapeAttr(baseHref)}">`);
    if (!/<base\s/i.test(out)) out = out.replace(/<html([^>]*)>/i, `<html$1><head><base href="${escapeAttr(baseHref)}"></head>`);
    out = out.replace(/<head([^>]*)>/i, `<head$1>${adBlockPrelude()}<style>html,body{margin:0;background:#000;min-height:100%;height:100%;overflow:hidden;}</style>`);
    stats.outputBytes = out.length;
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
      log("fetch", "browser fetch start", { url, mode: "cors", label: options.label || null, origin: location.origin });
      const response = await fetch(url, {
        cache: "no-store",
        credentials: "omit",
        mode: "cors",
        referrerPolicy: "no-referrer",
      });
      const text = await response.text();
      log(response.ok ? "fetch" : "fetch-error", "browser fetch done", {
        url,
        ok: response.ok,
        status: response.status,
        bytes: text.length,
        contentType: response.headers.get("content-type"),
        acao: response.headers.get("access-control-allow-origin"),
      });
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
        if (!data.ok) {
          cleanup(new Error(data.error || `Sandbox fetch failed for ${url}`));
          return;
        }
        log("fetch", "sandbox fetch done", {
          url,
          label: label || null,
          status: data.status,
          bytes: data.text.length,
          contentType: data.contentType,
          sandboxOrigin: "null",
        });
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
      log("fetch", "sandbox fetch start", { url, label: label || null, sandboxOrigin: "null" });
    });
  }

  async function resolverJson(path, { retries = 2, timeoutMs = 15000 } = {}) {
    if (!state.resolverBaseUrl) throw new Error("Cloudflare Worker URL is not configured");
    const url = `${state.resolverBaseUrl}${path}`;
    let lastError;
    // The Worker lives on Cloudflare (*.workers.dev), whose path from Russia is
    // flaky and can silently drop a long-held connection. Bound each attempt
    // with an abort timeout and retry transient transport failures on a fresh
    // connection so one dropped request no longer kills the whole resolve.
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        log("worker", attempt ? `fetch retry ${attempt}` : "fetch", { url: redact(url) });
        const response = await fetch(url, { cache: "no-store", credentials: "omit", signal: controller.signal });
        const text = await response.text();
        let data;
        try { data = JSON.parse(text); } catch { data = { ok: false, raw: text.slice(0, 500) }; }
        if (!response.ok || data.ok === false) {
          throw new Error(data.message || data.error || `Worker ${response.status}`);
        }
        return data;
      } catch (error) {
        lastError = error;
        const aborted = error?.name === "AbortError";
        const transient = aborted || /NetworkError|Failed to fetch|load failed|terminated|network/i.test(String(error?.message || ""));
        log("worker-warn", aborted ? "request timed out" : "request failed", {
          url: redact(url),
          attempt,
          transient,
          message: String(error?.message || error),
        });
        // Only retry transport-level failures; a real 4xx/5xx from a reachable
        // Worker (e.g. no Zenith mapping) is a genuine answer, not worth retrying.
        if (!transient || attempt === retries) break;
        await new Promise((resolve) => setTimeout(resolve, 600 * (attempt + 1)));
      } finally {
        clearTimeout(timer);
      }
    }
    throw lastError || new Error("Worker request failed");
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
    // Newdeaf rolls its {DD}{mon}.newdeaf.co mirror over during ~02:00-05:00
    // Moscow time. From 02:00 MSK we try the new day's mirror first (it may
    // already be up) and fall back to the previous day's; the first that parses
    // wins, so once the new one is live the old one is no longer hit. Read
    // Moscow wall-clock (UTC+3, no DST) shifted back past the 02:00 threshold,
    // then probe only [effective day, day before]. Never probe a future date.
    const MSK_OFFSET_MS = 3 * 3600000;
    const ROLLOVER_MS = 2 * 3600000;
    const effective = Date.now() + MSK_OFFSET_MS - ROLLOVER_MS;
    const slug = (offsetDays) => {
      const date = new Date(effective + offsetDays * 86400000);
      return `https://${date.getUTCDate()}${monthSlug(date)}.newdeaf.co`;
    };
    const generated = [slug(0), slug(-1)];
    return unique([explicitOrigin, ...generated].filter(Boolean).map((value) => cleanBaseUrl(value)));
  }

  function monthSlug(date) {
    return ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"][date.getUTCMonth()];
  }

  function isNewdeafPage(href, base) {
    const url = cleanUrl(href, base);
    if (!url) return null;
    const parsed = new URL(url);
    const baseHost = new URL(base).host;
    if (parsed.host !== baseHost) return null;
    if (!/\.html(?:$|[?#])/i.test(parsed.href)) return null;
    if (!/(\/film\/|\/serial\/|\/multfilm\/|\/anime\/|\/multserial\/|\/multserialy\/)/i.test(parsed.pathname)) return null;
    return parsed.href;
  }

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
    try {
      return Function(`"use strict"; return (${raw});`)();
    } catch {
      return String(raw || "").slice(1, -1);
    }
  }

  function cleanUrl(value, base) {
    try {
      return new URL(String(value || "").replace(/&amp;/g, "&"), base).href;
    } catch {
      return null;
    }
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

  function redact(value) {
    return String(value || "").replace(/([?&](?:token|key|X-API-KEY|api_key)=)[^&]+/gi, "$1<redacted>");
  }

  function setBusy(busy) {
    el.goBtn.disabled = busy;
    el.zonaOnlyBtn.disabled = busy;
  }

  function setMeta(title, subtitle, tone) {
    el.metaTitle.textContent = title || "AlphyTV";
    el.metaSubtitle.textContent = subtitle || "";
    setBadge(el.providerBadge.textContent, tone || "");
  }

  function setBadge(text, tone) {
    el.providerBadge.textContent = text || "idle";
    el.providerBadge.className = `badge ${tone || ""}`.trim();
  }

  function showError(error) {
    const message = String(error?.message || error);
    setMeta("Ошибка", message, "bad");
    setBadge("error", "bad");
    log("error", message, { stack: String(error?.stack || "") });
  }

  function log(type, message, data) {
    const entry = {
      at: new Date().toISOString(),
      type,
      message,
      data: data === undefined ? null : data,
    };
    state.logs.push(entry);
    if (state.logs.length > 500) state.logs.shift();
    const line = `[${entry.at.slice(11, 19)}] ${type}: ${message}${data === undefined ? "" : ` ${JSON.stringify(data)}`}`;
    el.log.textContent += `${line}\n`;
    el.log.scrollTop = el.log.scrollHeight;
    console.log(line);
  }

  function renderFacts() {
    const rows = [
      ["provider", state.activeProvider],
      ["resolver", state.facts.resolver],
      ["newdeaf", state.facts.newdeaf ? `${state.facts.newdeaf.ortified} Ortified / ${state.facts.newdeaf.allo} Allo` : ""],
      ["zona", state.facts.zona ? `kpId ${state.facts.zona.kpId}, zenith ${state.facts.zona.zenithId}` : ""],
      ["zenith", state.facts.zenith ? `dash=${state.facts.zenith.dash} hls=${state.facts.zenith.hls}` : ""],
      ["ortified", state.facts.ortified ? `ok=${state.facts.ortified.ok} adScripts=${state.facts.ortified.adScriptBlocks}` : ""],
    ].filter(([, value]) => value);
    el.facts.innerHTML = rows.map(([key, value]) => `<div><b>${escapeHtml(key)}</b> ${escapeHtml(String(value))}</div>`).join("");
  }

  function copyReport() {
    const report = {
      origin: location.origin,
      href: location.href,
      resolverBaseUrl: state.resolverBaseUrl,
      activeProvider: state.activeProvider,
      selectedMovie: state.selectedMovie,
      selectedNewdeaf: state.selectedNewdeaf,
      facts: state.facts,
      logs: state.logs,
      userAgent: navigator.userAgent,
    };
    navigator.clipboard.writeText(`ALPHYTV_MVP_REPORT\n${JSON.stringify(report, null, 2)}`).then(
      () => log("report", "copied"),
      (error) => log("report-error", error.message)
    );
  }

  boot();
})();
