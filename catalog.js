(() => {
  "use strict";

  const CATALOG_CACHE_VERSION = "20260625-r70";
  const CONFIG_URL = `/curated-config.json?v=${CATALOG_CACHE_VERSION}`;
  const ADMIN_CHECK_URL = "/api/admin/check";
  const ADMIN_CATALOG_URL = "/api/admin/catalog";
  const ADMIN_LOGIN_URL = "/api/admin/login";
  const ADMIN_LOGOUT_URL = "/api/admin/logout";
  const ADMIN_FLAG_KEY = "alphy.admin.active.v2";
  const DRAFT_KEY = "alphy.curated.draft.v1";
  const SHELF_HINT_KEY = "alphy.shelf.hint.v1";
  const SHELF_HINT_INTERVAL = 14 * 24 * 3600e3;
  const SAVE_DELAY_MS = 1200;
  const ITEM_LABEL_MAX = 32;

  const state = {
    catalog: {
      schema: 1, revision: 0, updatedAt: null, lists: [], forYou: "on", bookmarkBanner: false,
    },
    blobUrl: "",
    fallbackUrl: `/curated-fallback.json?v=${CATALOG_CACHE_VERSION}`,
    admin: false,
    dirty: false,
    saving: false,
    queued: false,
    saveTimer: null,
    pendingItem: null,
    homeActive: !document.getElementById("homeView")?.classList.contains("hidden"),
    quickListItems: [],
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
    banner: document.getElementById("bookmarkBanner"),
    bannerToggle: document.getElementById("bookmarkBannerToggle"),
    quickToggle: document.getElementById("quickListsToggle"),
    quickDrawer: document.getElementById("quickListsDrawer"),
    quickBackdrop: document.getElementById("quickListsBackdrop"),
    quickClose: document.getElementById("quickListsClose"),
    quickNav: document.getElementById("quickListsNav"),
    picker: document.getElementById("listPickerDialog"),
    pickerOptions: document.getElementById("listPickerOptions"),
  };

  function uid() {
    return crypto?.randomUUID?.() || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  }

  function adminFlag() {
    try {
      return sessionStorage.getItem(ADMIN_FLAG_KEY) === "1";
    } catch {
      return false;
    }
  }

  function saveAdminFlag(active) {
    try {
      if (active) sessionStorage.setItem(ADMIN_FLAG_KEY, "1");
      else sessionStorage.removeItem(ADMIN_FLAG_KEY);
      // Remove credentials left by the pre-cookie login flow.
      sessionStorage.removeItem("alphy.admin.auth.v1");
    } catch {
      // Session persistence is a convenience, not a requirement.
    }
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
    if (kind === "soap" && /^\d+$/.test(String(value?.soapId || ""))) {
      return { kind, soapId: String(value.soapId) };
    }
    if (kind === "clps" && /^\d+$/.test(String(value?.kpId || ""))) {
      const target = { kind, kpId: String(value.kpId) };
      const season = Number.parseInt(String(value?.season || ""), 10);
      const episode = Number.parseInt(String(value?.episode || ""), 10);
      if (Number.isInteger(season) && season > 0) target.season = season;
      if (Number.isInteger(episode) && episode > 0) target.episode = episode;
      return target;
    }
    return null;
  }

  function normalizeItem(value) {
    const target = normalizeTarget(value?.target);
    const title = String(value?.title || "").trim();
    if (!target || !title) return null;
    const label = normalizeItemLabel(value?.label);
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
      label,
      isSeries: !!value?.isSeries,
      movieLength: Number.isFinite(Number(value?.movieLength)) ? Number(value.movieLength) : null,
      rating,
      target,
      cachedAt: String(value?.cachedAt || new Date().toISOString()),
    };
  }

  function normalizeItemLabel(value) {
    return String(value || "").replace(/\s+/g, " ").trim().slice(0, ITEM_LABEL_MAX);
  }

  function labelTone(value) {
    const normalized = normalizeItemLabel(value).toLocaleLowerCase("ru-RU");
    if (normalized === "4к" || normalized === "4k") return "quality";
    if (normalized === "новый сезон") return "season";
    return "custom";
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
      forYou: normalizeForYouMode(value?.forYou),
      bookmarkBanner: value?.bookmarkBanner === true,
      lists,
    };
  }

  // «Для вас» kill-switch, distributed to every client through the catalog
  // envelope: "on" (default) | "frozen" (render caches, zero API calls) | "off".
  function normalizeForYouMode(value) {
    return value === "frozen" || value === "off" ? value : "on";
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
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ catalog: state.catalog, baseRevision }),
        });
      } catch (error) {
        if (error.status !== 409 || !error.payload?.catalog) throw error;
        baseRevision = Number(error.payload.catalog.revision) || 0;
        payload = await fetchJson(ADMIN_CATALOG_URL, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
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
    if (el.entry) {
      el.entry.textContent = "admin";
      el.entry.title = state.admin ? "Выйти из режима администратора" : "Войти как администратор";
    }
    updateAddButton();
    render();
    window.dispatchEvent(new CustomEvent("alphy:admin", { detail: { active: state.admin } }));
  }

  function adminReturnRequested() {
    return new URLSearchParams(location.search).get("admin") === "1";
  }

  function cleanAdminReturnParam() {
    const url = new URL(location.href);
    if (!url.searchParams.has("admin")) return;
    url.searchParams.delete("admin");
    history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
  }

  async function verifyStoredAdmin() {
    const requested = adminReturnRequested();
    if (!requested && !adminFlag()) return false;
    try {
      await fetchJson(ADMIN_CHECK_URL, { cache: "no-store" });
      await loadAdminCatalog();
      saveAdminFlag(true);
      setAdminMode(true);
      if (restoreDraft()) render();
      cleanAdminReturnParam();
      return true;
    } catch (error) {
      saveAdminFlag(false);
      setAdminMode(false);
      cleanAdminReturnParam();
      if (error.status !== 401) setStatus("админ-каталог временно недоступен", "error");
      return false;
    }
  }

  async function logout() {
    if (state.saveTimer) clearTimeout(state.saveTimer);
    saveAdminFlag(false);
    try {
      await fetch(ADMIN_LOGOUT_URL, { method: "POST", cache: "no-store" });
    } catch {
      // The local mode still closes even if the cookie cleanup request failed.
    }
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
    image.decoding = "async";
    const cachedPoster = posterUrlCacheGet(item.id);
    image.src = cachedPoster || item.poster || item.backdrop || "";
    // "resolved" => a known RU-reachable poster; "primary" => may be the blocked
    // cdnlbox original, so an onerror triggers a one-time title resolve.
    image.dataset.posterStage = cachedPoster ? "resolved" : "primary";
    image.alt = "";
    image.addEventListener("error", () => handlePosterError(image, item));
    media.appendChild(image);
    const itemLabel = normalizeItemLabel(item.label);
    if (itemLabel) {
      const label = document.createElement("div");
      label.className = "curated-label";
      label.dataset.tone = labelTone(itemLabel);
      label.textContent = itemLabel;
      media.appendChild(label);
    }
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
      if (event.target.closest(".admin-item-controls, .admin-label-controls")) return;
      open();
    });
    card.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        open();
      }
    });
    window.alphyBridge?.armCardIntent?.(card, item.target, item);
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

  function setItemLabel(listIndex, itemIndex, value) {
    const item = state.catalog.lists[listIndex]?.items?.[itemIndex];
    if (!item) return;
    const label = normalizeItemLabel(value);
    if (normalizeItemLabel(item.label) === label) return;
    if (label) {
      item.label = label;
    } else {
      delete item.label;
    }
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
    const item = state.catalog.lists[listIndex]?.items?.[itemIndex];
    const media = card.querySelector(".card-media");
    if (!item || !media) return;
    const labelControls = document.createElement("div");
    labelControls.className = "admin-label-controls";
    const label4k = document.createElement("button");
    label4k.type = "button";
    label4k.textContent = "4к";
    label4k.title = "Поставить лейбл 4к";
    label4k.addEventListener("click", (event) => {
      event.stopPropagation();
      setItemLabel(listIndex, itemIndex, "4к");
    });
    const labelSeason = document.createElement("button");
    labelSeason.type = "button";
    labelSeason.className = "season-preset";
    labelSeason.textContent = "Новый сезон";
    labelSeason.title = "Поставить лейбл «Новый сезон»";
    labelSeason.addEventListener("click", (event) => {
      event.stopPropagation();
      setItemLabel(listIndex, itemIndex, "Новый сезон");
    });
    const labelInput = document.createElement("input");
    labelInput.type = "text";
    labelInput.value = normalizeItemLabel(item.label);
    labelInput.placeholder = "лейбл";
    labelInput.maxLength = ITEM_LABEL_MAX;
    labelInput.setAttribute("aria-label", "Лейбл карточки");
    labelInput.addEventListener("click", (event) => event.stopPropagation());
    labelInput.addEventListener("keydown", (event) => {
      event.stopPropagation();
      if (event.key === "Enter") {
        event.preventDefault();
        labelInput.blur();
      }
    });
    labelInput.addEventListener("change", (event) => {
      event.stopPropagation();
      setItemLabel(listIndex, itemIndex, labelInput.value);
    });
    const clearLabel = document.createElement("button");
    clearLabel.type = "button";
    clearLabel.textContent = "×";
    clearLabel.title = "Убрать лейбл";
    clearLabel.addEventListener("click", (event) => {
      event.stopPropagation();
      setItemLabel(listIndex, itemIndex, "");
    });
    labelControls.addEventListener("keydown", (event) => event.stopPropagation());
    labelControls.append(label4k, labelInput, clearLabel, labelSeason);
    media.appendChild(labelControls);

    const controls = document.createElement("div");
    controls.className = "admin-item-controls";
    controls.addEventListener("keydown", (event) => event.stopPropagation());
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
    media.appendChild(controls);
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
  // Category shelf layout. Once a shelf needs a second row, split the entire
  // list evenly: N/2 on top and N/2 below (top gets the odd card). This avoids
  // tails such as 5+1 on phones and 8+2 on desktop.
  // ---------------------------------------------------------------------
  const CURATED_DESKTOP_COLS = 8;
  const CURATED_DESKTOP_GAP = 14;
  const CURATED_SIDE_PADDING = 10;
  let curatedObservers = [];
  let shelfHintScheduled = false;

  function layoutCuratedCards(row) {
    const cards = [...row.children].filter((child) => child.classList.contains("card"));
    const mobile = typeof matchMedia === "function" && matchMedia("(max-width: 560px)").matches;
    const visibleColumns = mobile ? 3 : CURATED_DESKTOP_COLS;
    const twoRows = cards.length > visibleColumns + (mobile ? 1 : 0);
    const topCount = twoRows ? Math.ceil(cards.length / 2) : cards.length;
    row.style.setProperty("--curated-rows", twoRows ? "2" : "1");
    row.classList.toggle("mobile-two-row", twoRows);

    cards.forEach((card, index) => {
      const top = !twoRows || index < topCount;
      const column = top ? index + 1 : index - topCount + 1;
      card.style.setProperty("--curated-r", top ? "1" : "2");
      card.style.setProperty("--curated-c", String(column));
      card.style.removeProperty("--mobile-row");
      card.style.removeProperty("--mobile-column");
      card.classList.toggle("page-lead", top && (column - 1) % visibleColumns === 0);
    });

    // Desktop keeps eight full cards across. Mobile width is owned by CSS so
    // exactly 3.5 cards remain visible as an affordance for horizontal scroll.
    const width = row.clientWidth;
    if (!mobile && width > 0) {
      const gaps = (CURATED_DESKTOP_COLS - 1) * CURATED_DESKTOP_GAP;
      const col = Math.floor((width - CURATED_SIDE_PADDING - gaps) / CURATED_DESKTOP_COLS);
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
    const prev = curatedNavButton("prev", "‹");
    const next = curatedNavButton("next", "›");
    const pageStride = () => Math.max(120, Math.round(row.clientWidth * .88));
    prev.addEventListener("click", () => row.scrollBy({ left: -pageStride(), behavior: "smooth" }));
    next.addEventListener("click", () => row.scrollBy({ left: pageStride(), behavior: "smooth" }));
    wrap.append(prev, next);
    const sync = () => {
      const max = row.scrollWidth - row.clientWidth - 2;
      const overflows = max > 2;
      prev.classList.toggle("hidden", !overflows);
      next.classList.toggle("hidden", !overflows);
      prev.disabled = !overflows || row.scrollLeft <= 2;
      next.disabled = !overflows || row.scrollLeft >= max;
      if (overflows) maybeHintShelfScroll(row, max);
    };
    row.addEventListener("scroll", sync, { passive: true });
    const relayout = () => {
      layoutCuratedCards(row);
      sync();
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

  function maybeHintShelfScroll(row, max) {
    if (shelfHintScheduled || typeof row.scrollTo !== "function") return;
    if (typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    let previous = 0;
    try { previous = Number(localStorage.getItem(SHELF_HINT_KEY)) || 0; } catch { /* ignore */ }
    if (Date.now() - previous < SHELF_HINT_INTERVAL) return;
    shelfHintScheduled = true;
    try { localStorage.setItem(SHELF_HINT_KEY, String(Date.now())); } catch { /* ignore */ }

    let cancelled = false;
    const cancel = () => { cancelled = true; };
    for (const event of ["pointerdown", "touchstart", "wheel"]) {
      row.addEventListener(event, cancel, { once: true, passive: true });
    }
    setTimeout(() => {
      if (cancelled || row.scrollLeft > 2) return;
      row.scrollTo({ left: Math.min(42, max), behavior: "smooth" });
      setTimeout(() => {
        if (!cancelled && row.scrollLeft < 70) row.scrollTo({ left: 0, behavior: "smooth" });
      }, 430);
    }, 900);
  }

  // ---------------------------------------------------------------------
  // «Для вас» — a synthetic, per-device row computed by foryou.js. Rendered
  // with the same cards as curated lists but never stored in the catalog;
  // only its mode flag lives in the envelope.
  // ---------------------------------------------------------------------
  // Identity of a "ready" curated title: normalized title + release year + type.
  // Same normalization as the recommender uses, so both sides agree.
  function readyTitleKey(title, year, isSeries) {
    const t = String(title || "")
      .toLocaleLowerCase("ru-RU")
      .replace(/[ёе]/g, "е")
      .replace(/[^a-zа-я0-9]+/gi, " ")
      .trim();
    const y = String(year || "").trim();
    if (!t || !/^\d{4}$/.test(y)) return "";
    return `${t}|${y}|${isSeries ? "s" : "f"}`;
  }

  // title+year+type -> curated item with an already-resolved player target
  // (ort/zen/clps/...). kp: targets are skipped — opening them is the same
  // resolve flow the caller already has. Rebuilt on every render.
  let readyIndex = new Map();
  function rebuildReadyIndex() {
    readyIndex = new Map();
    for (const list of state.catalog.lists) {
      for (const item of list.items) {
        if (!item?.target?.kind || item.target.kind === "kp") continue;
        const key = readyTitleKey(item.title, item.year, item.isSeries);
        if (key && !readyIndex.has(key)) readyIndex.set(key, item);
      }
    }
  }
  function findReady(title, year, isSeries) {
    return readyIndex.get(readyTitleKey(title, year, isSeries)) || null;
  }

  function forYouItems() {
    if (normalizeForYouMode(state.catalog.forYou) === "off") return [];
    const items = window.alphyForYou?.getItems?.() || [];
    // A recommendation the admin already curated opens instantly through the
    // list's resolved target instead of re-running the full kp resolve flow.
    return items.map((item) => {
      const ready = findReady(item.title, item.year, item.isSeries);
      if (!ready) return item;
      return {
        ...ready,
        id: item.id,
        fyKpId: String(item.target?.kpId || ""),
        // Keep the recommender's kpId so the play lands in history with it.
        kpId: ready.kpId || String(item.target?.kpId || ""),
        // Prefer the kp poster/ratings: Yandex CDN loads in RU, cdnlbox may not.
        poster: item.poster || ready.poster,
        rating: (item.rating?.kp || item.rating?.imdb) ? item.rating : ready.rating,
      };
    });
  }

  function forYouBlock(items) {
    const mode = normalizeForYouMode(state.catalog.forYou);
    const block = document.createElement("section");
    block.className = "curated-list foryou-list";
    const header = document.createElement("div");
    header.className = "curated-list-head";
    const title = document.createElement("h3");
    title.textContent = "Для вас";
    header.appendChild(title);
    if (state.admin) {
      const controls = document.createElement("div");
      controls.className = "curated-list-controls foryou-controls";
      const select = document.createElement("select");
      select.title = "Режим «Для вас» для всех устройств";
      for (const [value, label] of [
        ["on", "вкл"],
        ["frozen", "заморожен (без запросов)"],
        ["off", "выкл для всех"],
      ]) {
        const option = document.createElement("option");
        option.value = value;
        option.textContent = label;
        option.selected = value === mode;
        select.appendChild(option);
      }
      select.addEventListener("change", () => {
        state.catalog.forYou = normalizeForYouMode(select.value);
        markDirty();
        render();
      });
      controls.appendChild(select);
      header.appendChild(controls);
    }
    block.appendChild(header);
    if (!items.length) {
      const empty = document.createElement("div");
      empty.className = "curated-empty";
      empty.textContent = mode === "off"
        ? "Выключено для всех устройств."
        : "Подборка появится после нескольких просмотров (считается локально на устройстве зрителя).";
      block.appendChild(empty);
      return block;
    }
    const wrap = document.createElement("div");
    wrap.className = "curated-row-wrap";
    const row = document.createElement("div");
    row.className = "curated-row";
    items.forEach((item) => row.appendChild(makeForYouCard(item)));
    const top = items[0];
    const warmTop = () => window.alphyBridge?.prepareTarget?.(top?.target, top);
    if (typeof requestIdleCallback === "function") requestIdleCallback(warmTop, { timeout: 1800 });
    else setTimeout(warmTop, 650);
    wrap.appendChild(row);
    block.appendChild(wrap);
    setupCuratedRow(wrap, row);
    return block;
  }

  // A «Для вас» card is a regular curated card plus a dismiss cross: hiding a
  // title only removes it from the row (no negative taste signal).
  function makeForYouCard(item) {
    const card = makePublicCard(item);
    const kpId = String(item.fyKpId || item.target?.kpId || "");
    const media = card.querySelector(".card-media");
    if (!media || !/^\d+$/.test(kpId)) return card;
    const hideButton = document.createElement("button");
    hideButton.type = "button";
    hideButton.className = "fy-hide";
    hideButton.title = "Скрыть и больше не рекомендовать";
    hideButton.setAttribute("aria-label", "Скрыть рекомендацию");
    hideButton.textContent = "✕";
    hideButton.addEventListener("keydown", (event) => event.stopPropagation());
    hideButton.addEventListener("click", (event) => {
      event.stopPropagation();
      event.preventDefault();
      window.alphyForYou?.hide?.(kpId);
    });
    media.appendChild(hideButton);
    return card;
  }

  function closeQuickLists() {
    document.body.classList.remove("quick-lists-open");
    el.quickToggle?.setAttribute("aria-expanded", "false");
    el.quickDrawer?.setAttribute("aria-hidden", "true");
  }

  function openQuickLists() {
    if (!state.homeActive || !state.quickListItems.length) return;
    document.body.classList.add("quick-lists-open");
    el.quickToggle?.setAttribute("aria-expanded", "true");
    el.quickDrawer?.setAttribute("aria-hidden", "false");
  }

  function renderQuickListNav(items) {
    state.quickListItems = items;
    el.quickNav?.replaceChildren();
    for (const item of items) {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = item.title;
      button.addEventListener("click", () => {
        closeQuickLists();
        document.getElementById(item.id)?.scrollIntoView({ behavior: "smooth", block: "start" });
      });
      el.quickNav?.appendChild(button);
    }
    const visible = state.homeActive && items.length > 0;
    el.quickToggle?.classList.toggle("hidden", !visible);
    if (!visible) closeQuickLists();
  }

  function listAnchor(list, index) {
    const suffix = String(list?.id || "")
      .replace(/[^a-z0-9_-]+/gi, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60);
    return `curated-${suffix || index + 1}`;
  }

  function applyBookmarkBanner() {
    const enabled = state.catalog.bookmarkBanner === true;
    el.banner?.classList.toggle("hidden", !enabled);
    if (el.bannerToggle) el.bannerToggle.checked = enabled;
  }

  function render() {
    if (!el.section || !el.lists) return;
    applyBookmarkBanner();
    window.alphyForYou?.setMode?.(normalizeForYouMode(state.catalog.forYou));
    rebuildReadyIndex();
    const fyItems = forYouItems();
    const visible = state.admin || fyItems.length > 0 || state.catalog.lists.some((list) => list.items.length);
    el.section.classList.toggle("hidden", !visible);
    el.actions?.classList.toggle("hidden", !state.admin);
    curatedObservers.forEach((observer) => observer.disconnect());
    curatedObservers = [];
    el.lists.replaceChildren();
    const quickItems = [];

    if (fyItems.length || state.admin) {
      const block = forYouBlock(fyItems);
      block.id = "curated-for-you";
      el.lists.appendChild(block);
      if (fyItems.length) quickItems.push({ id: block.id, title: "Для вас" });
    }

    for (const [listIndex, list] of state.catalog.lists.entries()) {
      if (!state.admin && !list.items.length) continue;
      const block = document.createElement("section");
      block.className = "curated-list";
      block.id = listAnchor(list, listIndex);
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
      if (list.items.length) quickItems.push({ id: block.id, title: list.title });
    }
    renderQuickListNav(quickItems);
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

  function adminLoginHref() {
    const current = new URL(location.href);
    current.searchParams.delete("admin");
    const returnPath = `${current.pathname}${current.search}${current.hash}`;
    return `${ADMIN_LOGIN_URL}?return=${encodeURIComponent(returnPath)}`;
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
      location.assign(adminLoginHref());
    });
    el.bannerToggle?.addEventListener("change", () => {
      if (!state.admin) return;
      state.catalog.bookmarkBanner = el.bannerToggle.checked;
      markDirty();
      applyBookmarkBanner();
    });
    el.quickToggle?.addEventListener("click", openQuickLists);
    el.quickClose?.addEventListener("click", closeQuickLists);
    el.quickBackdrop?.addEventListener("click", closeQuickLists);
    el.create?.addEventListener("click", createList);
    el.save?.addEventListener("click", saveCatalog);
    el.addCurrent?.addEventListener("click", () => {
      const item = window.alphyBridge?.getCurrentCuratedItem?.();
      if (item) openPicker(item);
    });
    window.addEventListener("alphy:player-ready", updateAddButton);
    window.addEventListener("alphy:view", (event) => {
      updateAddButton();
      state.homeActive = event.detail?.view === "home";
      renderQuickListNav(state.quickListItems);
    });
    window.addEventListener("alphy:foryou", () => render());
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape") closeQuickLists();
    });
    window.addEventListener("beforeunload", (event) => {
      if (!state.admin || !state.dirty) return;
      event.preventDefault();
      event.returnValue = "";
    });
  }

  async function init() {
    try { sessionStorage.removeItem("alphy.admin.auth.v1"); } catch { /* old login cleanup */ }
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
    addToList: (item) => openPicker(item),
    // Search/recommendations consult this to open an already-curated title
    // through its resolved list target instead of the full kp resolve flow.
    findReady,
  };

  init();
})();
