(() => {
  "use strict";

  const CATALOG_CACHE_VERSION = "20260625-r70";
  const CONFIG_URL = `/curated-config.json?v=${CATALOG_CACHE_VERSION}`;
  const ADMIN_CHECK_URL = "/api/admin/check";
  const ADMIN_CATALOG_URL = "/api/admin/catalog";
  const AUTH_KEY = "alphy.admin.auth.v1";
  const DRAFT_KEY = "alphy.curated.draft.v1";
  const SAVE_DELAY_MS = 1200;

  const state = {
    catalog: { schema: 1, revision: 0, updatedAt: null, lists: [] },
    blobUrl: "",
    fallbackUrl: `/curated-fallback.json?v=${CATALOG_CACHE_VERSION}`,
    admin: false,
    dirty: false,
    saving: false,
    queued: false,
    saveTimer: null,
    pendingItem: null,
  };

  const el = {
    section: document.getElementById("curatedSection"),
    lists: document.getElementById("curatedLists"),
    state: document.getElementById("catalogState"),
    actions: document.getElementById("adminCatalogActions"),
    create: document.getElementById("createListBtn"),
    save: document.getElementById("saveCatalogBtn"),
    addCurrent: document.getElementById("addToListBtn"),
    entry: document.getElementById("adminEntry"),
    adminDialog: document.getElementById("adminDialog"),
    loginForm: document.getElementById("adminLoginForm"),
    user: document.getElementById("adminUserInput"),
    password: document.getElementById("adminPasswordInput"),
    loginError: document.getElementById("adminLoginError"),
    loginButton: document.getElementById("adminLoginBtn"),
    picker: document.getElementById("listPickerDialog"),
    pickerOptions: document.getElementById("listPickerOptions"),
  };

  function uid() {
    return crypto?.randomUUID?.() || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  }

  function loadAuth() {
    try {
      const auth = JSON.parse(sessionStorage.getItem(AUTH_KEY) || "null");
      return auth?.user && auth?.password ? auth : null;
    } catch {
      return null;
    }
  }

  function saveAuth(auth) {
    try {
      if (auth) sessionStorage.setItem(AUTH_KEY, JSON.stringify(auth));
      else sessionStorage.removeItem(AUTH_KEY);
    } catch {
      // Session persistence is a convenience, not a requirement.
    }
  }

  function adminHeaders(extra = {}) {
    const auth = loadAuth();
    if (!auth) return extra;
    return {
      ...extra,
      Authorization: `Basic ${btoa(`${auth.user}:${auth.password}`)}`,
    };
  }

  function normalizeTarget(value) {
    const kind = String(value?.kind || "");
    if (kind === "zen" && /^\d+$/.test(String(value?.zenithId || ""))) {
      return { kind, zenithId: String(value.zenithId) };
    }
    if (kind === "kp" && /^\d+$/.test(String(value?.kpId || ""))) {
      return { kind, kpId: String(value.kpId) };
    }
    if (kind === "ort" && value?.embedUrl) return { kind, embedUrl: String(value.embedUrl) };
    if (kind === "opr" && value?.playerUrl) {
      return { kind, playerUrl: String(value.playerUrl), pageUrl: String(value.pageUrl || "") };
    }
    if (kind === "nd" && value?.pageUrl) return { kind, pageUrl: String(value.pageUrl) };
    return null;
  }

  function normalizeItem(value) {
    const target = normalizeTarget(value?.target);
    const title = String(value?.title || "").trim();
    if (!target || !title) return null;
    const rating = {};
    if (Number.isFinite(Number(value?.rating?.kp))) rating.kp = Number(value.rating.kp);
    if (Number.isFinite(Number(value?.rating?.imdb))) rating.imdb = Number(value.rating.imdb);
    return {
      id: String(value?.id || uid()),
      key: String(value?.key || JSON.stringify(target)),
      title,
      year: String(value?.year || ""),
      poster: String(value?.poster || ""),
      backdrop: String(value?.backdrop || ""),
      description: String(value?.description || ""),
      isSeries: !!value?.isSeries,
      movieLength: Number.isFinite(Number(value?.movieLength)) ? Number(value.movieLength) : null,
      rating,
      target,
      cachedAt: String(value?.cachedAt || new Date().toISOString()),
    };
  }

  function normalizeCatalog(value) {
    const lists = [];
    for (const rawList of Array.isArray(value?.lists) ? value.lists : []) {
      const seen = new Set();
      const items = [];
      for (const rawItem of Array.isArray(rawList?.items) ? rawList.items : []) {
        const item = normalizeItem(rawItem);
        if (!item || seen.has(item.key)) continue;
        seen.add(item.key);
        items.push(item);
      }
      lists.push({
        id: String(rawList?.id || uid()),
        title: String(rawList?.title || "").trim() || "Новый список",
        items,
      });
    }
    return {
      schema: 1,
      revision: Math.max(0, Number(value?.revision) || 0),
      updatedAt: value?.updatedAt || null,
      lists,
    };
  }

  function setStatus(text, mode = "") {
    if (!el.state) return;
    el.state.textContent = text;
    el.state.dataset.mode = mode;
  }

  function showDialog(dialog) {
    if (!dialog) return;
    if (typeof dialog.showModal === "function") dialog.showModal();
    else dialog.setAttribute("open", "");
  }

  function closeDialog(dialog) {
    if (!dialog) return;
    if (typeof dialog.close === "function") dialog.close();
    else dialog.removeAttribute("open");
  }

  async function fetchJson(url, options = {}) {
    const response = await fetch(url, options);
    const text = await response.text();
    let payload;
    try {
      payload = JSON.parse(text);
    } catch {
      payload = { ok: false, error: text.slice(0, 200) };
    }
    if (!response.ok || payload?.ok === false) {
      const error = new Error(payload?.error || `HTTP ${response.status}`);
      error.status = response.status;
      error.payload = payload;
      throw error;
    }
    return payload;
  }

  async function loadPublicCatalog() {
    let config = {};
    try {
      config = await fetchJson(CONFIG_URL, { cache: "no-cache" });
    } catch {
      // The baked fallback below keeps the homepage usable.
    }
    state.blobUrl = String(config.blobUrl || "");
    state.fallbackUrl = String(config.fallbackUrl || state.fallbackUrl);

    let payload = null;
    if (state.blobUrl) {
      try {
        payload = await fetchJson(state.blobUrl, {
          cache: "no-cache",
          credentials: "omit",
        });
      } catch {
        // Fall through to the deployment-baked snapshot.
      }
    }
    if (!payload) payload = await fetchJson(state.fallbackUrl, { cache: "no-cache" });
    state.catalog = normalizeCatalog(payload);
    render();
  }

  async function loadAdminCatalog() {
    const payload = await fetchJson(ADMIN_CATALOG_URL, {
      headers: adminHeaders(),
      cache: "no-store",
    });
    state.catalog = normalizeCatalog(payload.catalog);
    if (payload.blobUrl) state.blobUrl = payload.blobUrl;
    state.dirty = false;
    render();
    setStatus("синхронизировано", "ok");
  }

  function saveDraft(active = true) {
    try {
      if (!active) localStorage.removeItem(DRAFT_KEY);
      else localStorage.setItem(DRAFT_KEY, JSON.stringify({
        revision: state.catalog.revision,
        savedAt: Date.now(),
        catalog: state.catalog,
      }));
    } catch {
      // A server save is still authoritative.
    }
  }

  function restoreDraft() {
    if (!state.admin) return false;
    try {
      const draft = JSON.parse(localStorage.getItem(DRAFT_KEY) || "null");
      if (!draft?.catalog || Number(draft.revision) !== Number(state.catalog.revision)) return false;
      state.catalog = normalizeCatalog(draft.catalog);
      state.dirty = true;
      setStatus("локальный черновик", "dirty");
      return true;
    } catch {
      return false;
    }
  }

  function markDirty() {
    if (!state.admin) return;
    state.dirty = true;
    saveDraft(true);
    setStatus("не сохранено", "dirty");
    if (state.saveTimer) clearTimeout(state.saveTimer);
    state.saveTimer = setTimeout(() => {
      state.saveTimer = null;
      saveCatalog();
    }, SAVE_DELAY_MS);
  }

  async function saveCatalog() {
    if (!state.admin || !state.dirty) return;
    if (state.saving) {
      state.queued = true;
      return;
    }
    state.saving = true;
    setStatus("сохранение…", "saving");
    if (el.save) el.save.disabled = true;
    try {
      let baseRevision = state.catalog.revision;
      let payload;
      try {
        payload = await fetchJson(ADMIN_CATALOG_URL, {
          method: "PUT",
          headers: adminHeaders({ "Content-Type": "application/json" }),
          body: JSON.stringify({ catalog: state.catalog, baseRevision }),
        });
      } catch (error) {
        if (error.status !== 409 || !error.payload?.catalog) throw error;
        baseRevision = Number(error.payload.catalog.revision) || 0;
        payload = await fetchJson(ADMIN_CATALOG_URL, {
          method: "PUT",
          headers: adminHeaders({ "Content-Type": "application/json" }),
          body: JSON.stringify({ catalog: state.catalog, baseRevision }),
        });
      }
      state.catalog = normalizeCatalog(payload.catalog);
      if (payload.blobUrl) state.blobUrl = payload.blobUrl;
      state.dirty = false;
      saveDraft(false);
      render();
      setStatus("сохранено", "ok");
    } catch (error) {
      if (error.status === 401) setAdminMode(false);
      setStatus("ошибка сохранения", "error");
    } finally {
      state.saving = false;
      if (el.save) el.save.disabled = false;
      if (state.queued) {
        state.queued = false;
        saveCatalog();
      }
    }
  }

  function setAdminMode(enabled) {
    state.admin = !!enabled;
    document.body.classList.toggle("admin-mode", state.admin);
    el.actions?.classList.toggle("hidden", !state.admin);
    if (el.entry) el.entry.textContent = state.admin ? "admin · выход" : "admin entry";
    updateAddButton();
    render();
    window.dispatchEvent(new CustomEvent("alphy:admin", { detail: { active: state.admin } }));
  }

  async function verifyStoredAdmin() {
    if (!loadAuth()) return false;
    try {
      await fetchJson(ADMIN_CHECK_URL, { headers: adminHeaders(), cache: "no-store" });
      await loadAdminCatalog();
      setAdminMode(true);
      if (restoreDraft()) render();
      return true;
    } catch (error) {
      if (error.status === 401) saveAuth(null);
      setAdminMode(false);
      if (error.status !== 401) setStatus("админ-каталог временно недоступен", "error");
      return false;
    }
  }

  async function login(user, password) {
    saveAuth({ user, password });
    let authenticated = false;
    try {
      await fetchJson(ADMIN_CHECK_URL, { headers: adminHeaders(), cache: "no-store" });
      authenticated = true;
      await loadAdminCatalog();
      setAdminMode(true);
      if (restoreDraft()) render();
      return { ok: true };
    } catch (error) {
      if (!authenticated || error.status === 401) saveAuth(null);
      setAdminMode(false);
      if (error.status === 401) return { ok: false, reason: "credentials" };
      return {
        ok: false,
        reason: authenticated ? "catalog" : "network",
      };
    }
  }

  function logout() {
    if (state.saveTimer) clearTimeout(state.saveTimer);
    saveAuth(null);
    state.dirty = false;
    saveDraft(false);
    setAdminMode(false);
    setStatus("", "");
    loadPublicCatalog().catch(() => {});
  }

  function ratingLabel(value) {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? number.toFixed(1) : "—";
  }

  function durationLabel(item) {
    const minutes = Math.round(Number(item.movieLength));
    if (Number.isFinite(minutes) && minutes > 0) {
      if (minutes >= 60) {
        const hours = Math.floor(minutes / 60);
        const rest = minutes % 60;
        return `${hours} ч${rest ? ` ${rest} м` : ""}`;
      }
      return `${minutes} мин`;
    }
    return item.isSeries ? "СЕРИАЛ" : "—";
  }

  // --- Poster RU-reachability -------------------------------------------
  // Posters scraped from newdeaf live on static.cdnlbox.club, which RU ISPs
  // block, so those items show no cover in Russia while Kinopoisk-sourced ones
  // (avatars.mds.yandex.net) always load. When such a poster fails to load we
  // resolve the CORRECT Kinopoisk poster by title+year through the resolver and
  // cache the resulting URL. The item key's number is a zona id, NOT a Kinopoisk
  // id, so it must never be used to build a poster.

  function posterUrlCacheGet(id) {
    try { return localStorage.getItem(`alphy.posterurl.${id}`) || ""; } catch { return ""; }
  }
  function posterUrlCacheSet(id, url) {
    try { localStorage.setItem(`alphy.posterurl.${id}`, String(url)); } catch { /* ignore */ }
  }
  function posterUrlCacheClear(id) {
    try { localStorage.removeItem(`alphy.posterurl.${id}`); } catch { /* ignore */ }
  }

  // The poster failed to load — on RU devices that is the blocked cdnlbox CDN.
  // Resolve the correct poster by title (cached), and only fall back to the empty
  // placeholder when nothing is recoverable. Guarded so it resolves at most once.
  async function handlePosterError(image, item) {
    const stage = image.dataset.posterStage;
    if (stage !== "primary") {
      // A resolved/placeholder poster also failed, or a resolve is in flight.
      image.removeAttribute("src");
      image.classList.add("poster-empty");
      image.dataset.posterStage = "done";
      return;
    }
    image.dataset.posterStage = "resolving";
    let poster = posterUrlCacheGet(item.id);
    if (!poster && item.title) {
      poster = (await window.alphyBridge?.resolvePosterByTitle?.(item.title, item.year)) || "";
      if (poster) posterUrlCacheSet(item.id, poster);
    }
    if (poster) {
      image.dataset.posterStage = "resolved";
      image.classList.remove("poster-empty");
      image.src = poster;
      return;
    }
    image.removeAttribute("src");
    image.classList.add("poster-empty");
    image.dataset.posterStage = "done";
  }

  function makePublicCard(item) {
    const card = document.createElement("article");
    card.className = "card curated-card";
    card.tabIndex = 0;
    card.setAttribute("role", "button");
    card.dataset.key = item.key;

    const media = document.createElement("div");
    media.className = "card-media";
    const image = document.createElement("img");
    image.className = "poster";
    image.loading = "lazy";
    const cachedPoster = posterUrlCacheGet(item.id);
    image.src = cachedPoster || item.poster || item.backdrop || "";
    // "resolved" => a known RU-reachable poster; "primary" => may be the blocked
    // cdnlbox original, so an onerror triggers a one-time title resolve.
    image.dataset.posterStage = cachedPoster ? "resolved" : "primary";
    image.alt = "";
    image.addEventListener("error", () => handlePosterError(image, item));
    media.appendChild(image);
    const overlay = document.createElement("div");
    overlay.className = "card-hover-meta";
    overlay.setAttribute("aria-hidden", "true");
    overlay.innerHTML = `
      <div class="hover-ratings">
        <div class="hover-rating">
          <span class="hover-rating-name">IMDb</span>
          <b class="hover-rating-value">${ratingLabel(item.rating?.imdb)}</b>
        </div>
        <i class="hover-rating-divider"></i>
        <div class="hover-rating">
          <span class="hover-rating-name">КП</span>
          <b class="hover-rating-value">${ratingLabel(item.rating?.kp)}</b>
        </div>
      </div>
      <div class="hover-duration">${durationLabel(item)}</div>
    `;
    media.appendChild(overlay);
    window.alphyBridge?.addCardBookmark?.(media, item.target, item);
    card.appendChild(media);

    const title = document.createElement("div");
    title.className = "ctitle";
    title.textContent = item.title;
    card.appendChild(title);
    const sub = document.createElement("div");
    sub.className = "cmeta";
    sub.textContent = [item.year, item.isSeries ? "сериал" : "фильм"].filter(Boolean).join(" · ");
    card.appendChild(sub);

    const open = () => window.alphyBridge?.openCuratedItem?.(item);
    card.addEventListener("click", (event) => {
      if (event.target.closest(".admin-item-controls")) return;
      open();
    });
    card.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        open();
      }
    });
    return card;
  }

  function moveItem(fromListIndex, itemIndex, direction) {
    const items = state.catalog.lists[fromListIndex]?.items;
    const targetIndex = itemIndex + direction;
    if (!items || targetIndex < 0 || targetIndex >= items.length) return;
    [items[itemIndex], items[targetIndex]] = [items[targetIndex], items[itemIndex]];
    markDirty();
    render();
  }

  function moveItemToList(fromListIndex, itemIndex, toListIndex) {
    if (fromListIndex === toListIndex) return;
    const source = state.catalog.lists[fromListIndex];
    const destination = state.catalog.lists[toListIndex];
    if (!source || !destination) return;
    const [item] = source.items.splice(itemIndex, 1);
    if (!item) return;
    if (!destination.items.some((entry) => entry.key === item.key)) destination.items.push(item);
    markDirty();
    render();
  }

  // Force update: re-resolve cover + rating for an existing item by title via the
  // resolver, WITHOUT touching its target (player/links). Useful when an item was
  // added from newdeaf (cdnlbox cover, blocked in RU) or when search fell back to
  // the unofficial API (no IMDb). Only an exact-title match is applied.
  async function forceUpdateItem(listIndex, itemIndex, button) {
    if (!state.admin) return;
    const item = state.catalog.lists[listIndex]?.items?.[itemIndex];
    if (!item?.title) return;
    if (button) { button.disabled = true; button.textContent = "…"; }
    setStatus(`обновляю «${item.title}»…`, "saving");
    try {
      const meta = await window.alphyBridge?.resolveCardMeta?.(item.title, item.year);
      const rating = {};
      if (Number.isFinite(Number(meta?.rating?.kp))) rating.kp = Number(meta.rating.kp);
      if (Number.isFinite(Number(meta?.rating?.imdb))) rating.imdb = Number(meta.rating.imdb);
      if (!meta?.ok || (!meta.poster && !Object.keys(rating).length)) {
        setStatus(`не найдено на Кинопоиске: «${item.title}»`, "error");
        if (button) { button.disabled = false; button.textContent = "⟳"; }
        return;
      }
      if (meta.poster) {
        item.poster = meta.poster;
        item.backdrop = "";
        posterUrlCacheClear(item.id); // drop any stale RU onerror override
      }
      if (Object.keys(rating).length) item.rating = rating;
      markDirty(); // queues the autosave PUT; target/key/links untouched
      render();    // rebuilds the card (this button element is replaced)
      setStatus(`обновлено: «${meta.name || item.title}» · IMDb ${rating.imdb ?? "—"} · КП ${rating.kp ?? "—"}`, "ok");
    } catch {
      setStatus(`ошибка обновления: «${item.title}»`, "error");
      if (button) { button.disabled = false; button.textContent = "⟳"; }
    }
  }

  function addAdminItemControls(card, listIndex, itemIndex) {
    if (!state.admin) return;
    const controls = document.createElement("div");
    controls.className = "admin-item-controls";
    const left = document.createElement("button");
    left.type = "button";
    left.textContent = "‹";
    left.title = "Сдвинуть влево";
    left.disabled = itemIndex === 0;
    left.addEventListener("click", (event) => {
      event.stopPropagation();
      moveItem(listIndex, itemIndex, -1);
    });
    const right = document.createElement("button");
    right.type = "button";
    right.textContent = "›";
    right.title = "Сдвинуть вправо";
    right.disabled = itemIndex >= state.catalog.lists[listIndex].items.length - 1;
    right.addEventListener("click", (event) => {
      event.stopPropagation();
      moveItem(listIndex, itemIndex, 1);
    });
    const select = document.createElement("select");
    select.title = "Перенести в другой список";
    state.catalog.lists.forEach((list, index) => {
      const option = document.createElement("option");
      option.value = String(index);
      option.textContent = list.title;
      option.selected = index === listIndex;
      select.appendChild(option);
    });
    select.addEventListener("click", (event) => event.stopPropagation());
    select.addEventListener("change", (event) => {
      event.stopPropagation();
      moveItemToList(listIndex, itemIndex, Number(select.value));
    });
    const refresh = document.createElement("button");
    refresh.type = "button";
    refresh.className = "refresh";
    refresh.textContent = "⟳";
    refresh.title = "Обновить обложку и рейтинг с Кинопоиска/IMDb (плеер не трогает)";
    refresh.addEventListener("click", (event) => {
      event.stopPropagation();
      forceUpdateItem(listIndex, itemIndex, refresh);
    });
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "remove";
    remove.textContent = "×";
    remove.title = "Удалить";
    remove.addEventListener("click", (event) => {
      event.stopPropagation();
      state.catalog.lists[listIndex].items.splice(itemIndex, 1);
      markDirty();
      render();
    });
    controls.append(left, right, select, refresh, remove);
    card.querySelector(".card-media")?.appendChild(controls);
  }

  function moveList(index, direction) {
    const target = index + direction;
    if (target < 0 || target >= state.catalog.lists.length) return;
    [state.catalog.lists[index], state.catalog.lists[target]] = [
      state.catalog.lists[target],
      state.catalog.lists[index],
    ];
    markDirty();
    render();
  }

  function listHeader(list, index) {
    const header = document.createElement("div");
    header.className = "curated-list-head";
    if (state.admin) {
      const input = document.createElement("input");
      input.className = "curated-title-input";
      input.value = list.title;
      input.setAttribute("aria-label", "Название списка");
      input.addEventListener("change", () => {
        const title = input.value.trim() || "Новый список";
        if (title !== list.title) {
          list.title = title;
          markDirty();
          render();
        }
      });
      header.appendChild(input);
      const controls = document.createElement("div");
      controls.className = "curated-list-controls";
      for (const [label, title, action, disabled] of [
        ["↑", "Поднять список", () => moveList(index, -1), index === 0],
        ["↓", "Опустить список", () => moveList(index, 1), index === state.catalog.lists.length - 1],
        ["×", "Удалить список", () => {
          state.catalog.lists.splice(index, 1);
          markDirty();
          render();
        }, false],
      ]) {
        const button = document.createElement("button");
        button.type = "button";
        button.textContent = label;
        button.title = title;
        button.disabled = disabled;
        button.addEventListener("click", action);
        controls.appendChild(button);
      }
      header.appendChild(controls);
    } else {
      const title = document.createElement("h3");
      title.textContent = list.title;
      header.appendChild(title);
    }
    return header;
  }

  // ---------------------------------------------------------------------
  // Category shelf layout: 8 tiles across, 2 rows = one page of 16. Cards are
  // placed explicitly so the reading order is row-major (1-8, then 9-16) while
  // the grid still flows horizontally into the next page. Anything past 16
  // scrolls off to the right and gets prev/next arrows.
  // ---------------------------------------------------------------------
  const CURATED_COLS = 8;
  const CURATED_PAGE = CURATED_COLS * 2; // 16 tiles per visible page
  const CURATED_COL_GAP = 14; // keep in sync with .curated-row column-gap
  let curatedObservers = [];

  function layoutCuratedCards(row) {
    const cards = [...row.children].filter((child) => child.classList.contains("card"));
    cards.forEach((card, index) => {
      const pageIndex = index % CURATED_PAGE;
      const page = Math.floor(index / CURATED_PAGE);
      card.style.setProperty("--curated-r", pageIndex < CURATED_COLS ? "1" : "2");
      card.style.setProperty("--curated-c", String(page * CURATED_COLS + (pageIndex % CURATED_COLS) + 1));
      card.classList.toggle("page-lead", pageIndex === 0);
    });
    // Size columns so exactly 8 fill the viewport => clean one-page paging.
    const width = row.clientWidth;
    if (width > 0) {
      const col = Math.floor((width - (CURATED_COLS - 1) * CURATED_COL_GAP) / CURATED_COLS);
      row.style.setProperty("--curated-col", `${Math.max(96, col)}px`);
    }
    return cards.length;
  }

  function curatedNavButton(side, glyph) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `curated-nav curated-nav-${side}`;
    button.setAttribute("aria-label", side === "prev" ? "Предыдущие" : "Следующие");
    const span = document.createElement("span");
    span.className = "glyph";
    span.textContent = glyph;
    button.appendChild(span);
    return button;
  }

  function setupCuratedRow(wrap, row) {
    const count = [...row.children].filter((child) => child.classList.contains("card")).length;
    let sync = null;
    if (count > CURATED_PAGE) {
      const prev = curatedNavButton("prev", "‹");
      const next = curatedNavButton("next", "›");
      const pageStride = () => row.clientWidth + CURATED_COL_GAP;
      prev.addEventListener("click", () => row.scrollBy({ left: -pageStride(), behavior: "smooth" }));
      next.addEventListener("click", () => row.scrollBy({ left: pageStride(), behavior: "smooth" }));
      wrap.append(prev, next);
      sync = () => {
        const max = row.scrollWidth - row.clientWidth - 2;
        prev.disabled = row.scrollLeft <= 2;
        next.disabled = row.scrollLeft >= max;
      };
      row.addEventListener("scroll", sync, { passive: true });
    }
    const relayout = () => {
      layoutCuratedCards(row);
      window.alphyBridge?.layoutMobileGrid?.(row);
      sync?.();
    };
    relayout();
    // The home view can be hidden when render() runs (clientWidth 0); a
    // ResizeObserver re-runs the layout once the shelf actually gets a width,
    // and on every window resize, without a separate resize listener.
    if (typeof ResizeObserver !== "undefined") {
      const observer = new ResizeObserver(relayout);
      observer.observe(row);
      curatedObservers.push(observer);
    }
  }

  function render() {
    if (!el.section || !el.lists) return;
    const visible = state.admin || state.catalog.lists.some((list) => list.items.length);
    el.section.classList.toggle("hidden", !visible);
    if (visible) document.getElementById("homeEmpty")?.classList.add("hidden");
    el.actions?.classList.toggle("hidden", !state.admin);
    curatedObservers.forEach((observer) => observer.disconnect());
    curatedObservers = [];
    el.lists.replaceChildren();

    for (const [listIndex, list] of state.catalog.lists.entries()) {
      if (!state.admin && !list.items.length) continue;
      const block = document.createElement("section");
      block.className = "curated-list";
      block.appendChild(listHeader(list, listIndex));
      if (!list.items.length) {
        const empty = document.createElement("div");
        empty.className = "curated-empty";
        empty.textContent = "Пустой список — добавь тайтл из загруженного плеера.";
        block.appendChild(empty);
      } else {
        const wrap = document.createElement("div");
        wrap.className = "curated-row-wrap";
        const row = document.createElement("div");
        row.className = "curated-row";
        list.items.forEach((item, itemIndex) => {
          const card = makePublicCard(item);
          addAdminItemControls(card, listIndex, itemIndex);
          row.appendChild(card);
        });
        wrap.appendChild(row);
        block.appendChild(wrap);
        setupCuratedRow(wrap, row);
      }
      el.lists.appendChild(block);
    }
    updateAddButton();
  }

  function createList() {
    if (!state.admin) return;
    state.catalog.lists.push({ id: uid(), title: "Новый список", items: [] });
    markDirty();
    render();
  }

  function addItem(listIndex, rawItem) {
    const list = state.catalog.lists[listIndex];
    const item = normalizeItem(rawItem);
    if (!list || !item) return;
    if (!list.items.some((entry) => entry.key === item.key)) list.items.push(item);
    markDirty();
    render();
  }

  function openPicker(item) {
    if (!state.admin || !item) return;
    state.pendingItem = item;
    el.pickerOptions?.replaceChildren();
    state.catalog.lists.forEach((list, index) => {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = list.title;
      button.addEventListener("click", () => {
        addItem(index, state.pendingItem);
        state.pendingItem = null;
        closeDialog(el.picker);
      });
      el.pickerOptions?.appendChild(button);
    });
    const create = document.createElement("button");
    create.type = "button";
    create.className = "list-picker-create";
    create.textContent = "+ Новый список";
    create.addEventListener("click", () => {
      createList();
      addItem(state.catalog.lists.length - 1, state.pendingItem);
      state.pendingItem = null;
      closeDialog(el.picker);
    });
    el.pickerOptions?.appendChild(create);
    showDialog(el.picker);
  }

  function updateAddButton() {
    if (!el.addCurrent) return;
    const item = window.alphyBridge?.getCurrentCuratedItem?.();
    el.addCurrent.classList.toggle("hidden", !(state.admin && item));
  }

  function bind() {
    for (const button of document.querySelectorAll("[data-close-dialog]")) {
      button.addEventListener("click", () => closeDialog(button.closest("dialog")));
    }
    el.entry?.addEventListener("click", () => {
      if (state.admin) {
        logout();
        return;
      }
      el.loginError?.classList.add("hidden");
      if (el.user) el.user.value = "";
      if (el.password) el.password.value = "";
      showDialog(el.adminDialog);
      setTimeout(() => el.user?.focus(), 0);
    });
    el.loginForm?.addEventListener("submit", async (event) => {
      event.preventDefault();
      const user = el.user?.value.trim() || "";
      const password = el.password?.value || "";
      if (!user || !password) {
        el.loginError.textContent = "Введите логин и пароль";
        el.loginError.classList.remove("hidden");
        return;
      }
      el.loginError?.classList.add("hidden");
      if (el.loginButton) {
        el.loginButton.disabled = true;
        el.loginButton.textContent = "Проверяем…";
      }
      const result = await login(user, password);
      if (el.loginButton) {
        el.loginButton.disabled = false;
        el.loginButton.textContent = "Войти";
      }
      if (result.ok) {
        closeDialog(el.adminDialog);
      } else {
        el.loginError.textContent = result.reason === "credentials"
          ? "Неверный логин или пароль"
          : result.reason === "catalog"
            ? "Логин принят, но каталог сейчас недоступен. Повторите через минуту."
            : "Не удалось связаться с сервером. Проверьте соединение и повторите.";
        el.loginError.classList.remove("hidden");
      }
    });
    el.create?.addEventListener("click", createList);
    el.save?.addEventListener("click", saveCatalog);
    el.addCurrent?.addEventListener("click", () => {
      const item = window.alphyBridge?.getCurrentCuratedItem?.();
      if (item) openPicker(item);
    });
    window.addEventListener("alphy:player-ready", updateAddButton);
    window.addEventListener("alphy:view", updateAddButton);
    window.addEventListener("beforeunload", (event) => {
      if (!state.admin || !state.dirty) return;
      event.preventDefault();
      event.returnValue = "";
    });
  }

  async function init() {
    bind();
    await loadPublicCatalog().catch(() => {
      setStatus("подборки временно недоступны", "error");
    });
    await verifyStoredAdmin();
  }

  window.alphyCatalog = {
    init,
    render,
    isAdmin: () => state.admin,
    getCatalog: () => JSON.parse(JSON.stringify(state.catalog)),
  };

  init();
})();
