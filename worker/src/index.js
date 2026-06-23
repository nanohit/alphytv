import { getZonaLib, zonaUserAgent } from "./zona-runtime-and-loader.js";

const DEFAULT_POISKKINO_BASE_URL = "https://api.poiskkino.dev";

let zonaResolveQueue = Promise.resolve();

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(request, env) });
    }

    try {
      if (url.pathname === "/" || url.pathname === "/health") {
        return json(request, env, { ok: true, service: "alphy-resolver" });
      }

      if (url.pathname === "/search") {
        return await handleSearch(request, env, url);
      }

      if (url.pathname === "/movie") {
        return await handleMovie(request, env, url);
      }

      if (url.pathname === "/seasons") {
        return await handleSeasons(request, env, url);
      }

      if (url.pathname === "/resolve-zona") {
        return await handleZonaResolve(request, env, url);
      }

      if (url.pathname === "/zenith") {
        return await handleZenith(request, env, url);
      }

      if (url.pathname === "/resolve-opravar") {
        return await handleOpravarResolve(request, env, url);
      }

      return json(request, env, { ok: false, error: "not_found" }, 404);
    } catch (error) {
      return json(request, env, {
        ok: false,
        error: "internal_error",
        message: String(error?.message || error),
      }, 500);
    }
  },
};

async function handleSearch(request, env, url) {
  const query = (url.searchParams.get("q") || "").trim();
  const year = (url.searchParams.get("year") || "").trim();
  const limit = clampInt(url.searchParams.get("limit"), 1, 20, 10);

  if (!query) {
    return json(request, env, { ok: false, error: "missing_q" }, 400);
  }

  const { results, source } = await searchWithFallback(env, query, limit);
  // Year is a soft hint: providers (e.g. Newdeaf) and PoiskKino often disagree
  // by a year on the same title, so match within +/-1 and never let the year
  // filter zero out an otherwise-valid result.
  const yearNum = Number.parseInt(year, 10);
  let filtered = results;
  if (Number.isFinite(yearNum)) {
    const near = results.filter((item) => {
      const y = Number.parseInt(item.year, 10);
      return Number.isFinite(y) && Math.abs(y - yearNum) <= 1;
    });
    filtered = near.length ? near : results;
  }

  return json(request, env, {
    ok: true,
    query,
    year: year || null,
    source,
    total: results.length,
    results: filtered,
  });
}

async function handleMovie(request, env, url) {
  const id = (url.searchParams.get("id") || url.searchParams.get("kpId") || "").trim();
  if (!/^\d+$/.test(id)) {
    return json(request, env, { ok: false, error: "missing_or_invalid_id" }, 400);
  }

  const { movie, source } = await movieWithFallback(env, id);
  return json(request, env, { ok: true, source, movie });
}

async function handleSeasons(request, env, url) {
  const id = (url.searchParams.get("id") || url.searchParams.get("kpId") || "").trim();
  if (!/^\d+$/.test(id)) {
    return json(request, env, { ok: false, error: "missing_or_invalid_id" }, 400);
  }
  const { seasons, source } = await seasonsWithFallback(env, id);
  return json(request, env, { ok: true, source, kpId: id, seasons });
}

// Metadata sources, used in order of remaining daily budget:
//   1) api.poiskkino.dev — primary, ~200 req/day on one shared key.
//   2) kinopoiskapiunofficial.tech — a POOL of keys, ~500 req/day each.
// When a source 4xxs (esp. 402/429 = quota spent) we rotate to the next. The
// unofficial cursor sticks to the current working key (drain it first) and only
// advances past a key once its quota is spent, so N keys ≈ N*500/day on top of the
// primary's 200 (5 keys -> ~2700/day). All sources speak Kinopoisk IDs, so kpId
// stays compatible with /resolve-zona regardless of which one answered.
let unofficialCursor = 0;

function unofficialKeys(env) {
  const list = String(env.KINOPOISK_UNOFFICIAL_TOKENS || "").split(",").map((s) => s.trim());
  if (env.KINOPOISK_UNOFFICIAL_TOKEN) list.push(String(env.KINOPOISK_UNOFFICIAL_TOKEN).trim());
  return [...new Set(list.filter(Boolean))];
}

function isQuotaError(error) {
  return /\b(402|429)\b/.test(String(error?.message || ""));
}

async function unofficialRotate(keys, run) {
  const start = unofficialCursor; // capture once; the loop must not skip keys as the cursor moves
  let lastError;
  for (let i = 0; i < keys.length; i += 1) {
    const idx = (start + i) % keys.length;
    try {
      const value = await run(keys[idx]);
      unofficialCursor = idx; // stick with this working key next time
      return { value, index: idx };
    } catch (error) {
      lastError = error;
      if (isQuotaError(error)) unofficialCursor = (idx + 1) % keys.length; // this key is spent for today
    }
  }
  throw lastError || new Error("all unofficial keys exhausted");
}

async function searchWithFallback(env, query, limit) {
  try {
    return { results: await poiskkinoSearch(env, query, limit), source: "poiskkino" };
  } catch (primaryError) {
    const keys = unofficialKeys(env);
    if (!keys.length) throw primaryError;
    try {
      const { value, index } = await unofficialRotate(keys, (key) => unofficialSearch(env, key, query, limit));
      return { results: value, source: `kinopoiskunofficial#${index + 1}` };
    } catch {
      throw primaryError; // everything down -> surface the primary error
    }
  }
}

async function movieWithFallback(env, id) {
  try {
    return { movie: await poiskkinoMovie(env, id), source: "poiskkino" };
  } catch (primaryError) {
    const keys = unofficialKeys(env);
    if (!keys.length) throw primaryError;
    try {
      const { value, index } = await unofficialRotate(keys, (key) => unofficialMovie(env, key, id));
      return { movie: value, source: `kinopoiskunofficial#${index + 1}` };
    } catch {
      throw primaryError;
    }
  }
}

async function seasonsWithFallback(env, id) {
  try {
    return { seasons: await poiskkinoSeasons(env, id), source: "poiskkino" };
  } catch (primaryError) {
    const keys = unofficialKeys(env);
    if (!keys.length) throw primaryError;
    try {
      const { value, index } = await unofficialRotate(keys, (key) => unofficialSeasons(env, key, id));
      return { seasons: value, source: `kinopoiskunofficial#${index + 1}` };
    } catch {
      throw primaryError;
    }
  }
}

async function poiskkinoSearch(env, query, limit) {
  const apiUrl = new URL("/v1.4/movie/search", poiskkinoBase(env));
  apiUrl.searchParams.set("query", query);
  apiUrl.searchParams.set("limit", String(limit));
  const raw = await poiskkinoFetch(env, apiUrl);
  const docs = Array.isArray(raw.docs) ? raw.docs : [];
  return docs.map(normalizeMovie);
}

async function poiskkinoMovie(env, id) {
  const apiUrl = new URL(`/v1.4/movie/${id}`, poiskkinoBase(env));
  return normalizeMovie(await poiskkinoFetch(env, apiUrl));
}

async function poiskkinoSeasons(env, id) {
  const apiUrl = new URL("/v1.4/season", poiskkinoBase(env));
  apiUrl.searchParams.set("movieId", id);
  apiUrl.searchParams.set("limit", "50");
  const raw = await poiskkinoFetch(env, apiUrl);
  return normalizeSeasons(raw.docs);
}

async function unofficialSearch(env, key, query, limit) {
  const apiUrl = new URL("/api/v2.1/films/search-by-keyword", unofficialBase(env));
  apiUrl.searchParams.set("keyword", query);
  apiUrl.searchParams.set("page", "1");
  const raw = await unofficialFetch(key, apiUrl);
  const films = Array.isArray(raw.films) ? raw.films : [];
  return films.slice(0, limit).map(normalizeUnofficialSearch);
}

async function unofficialMovie(env, key, id) {
  const apiUrl = new URL(`/api/v2.2/films/${id}`, unofficialBase(env));
  return normalizeUnofficialFilm(await unofficialFetch(key, apiUrl));
}

async function unofficialSeasons(env, key, id) {
  const apiUrl = new URL(`/api/v2.2/films/${id}/seasons`, unofficialBase(env));
  const raw = await unofficialFetch(key, apiUrl);
  return normalizeSeasons(raw.items);
}

async function unofficialFetch(key, apiUrl) {
  const response = await fetch(apiUrl, {
    headers: { "Accept": "application/json", "X-API-KEY": key },
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`KinopoiskUnofficial ${response.status}: ${text.slice(0, 200)}`);
  }
  return JSON.parse(text);
}

function unofficialBase(env) {
  return env.KINOPOISK_UNOFFICIAL_BASE_URL || "https://kinopoiskapiunofficial.tech";
}

async function handleZonaResolve(request, env, url) {
  const kpId = (url.searchParams.get("kpId") || url.searchParams.get("id") || "").trim();
  if (!/^\d+$/.test(kpId)) {
    return json(request, env, { ok: false, error: "missing_or_invalid_kpId" }, 400);
  }

  const resolved = await enqueueZonaResolve(() => resolveZonaInPureJs(kpId));
  if (!resolved.embedUrl) {
    // mzona occasionally returns an empty body when its shared egress is
    // rate-limited. That is a transient upstream failure, not a successful
    // "title has no Zenith" result. Returning ok:false lets clients retry and,
    // crucially, prevents an empty mapping from looking cacheable.
    return json(request, env, {
      ok: false,
      error: "zona_upstream_empty",
      message: "Zona временно не вернула Zenith embed",
      ...resolved,
    }, 503);
  }
  return json(request, env, { ok: true, ...resolved });
}

async function handleZenith(request, env, url) {
  const idOrUrl = (url.searchParams.get("id") || url.searchParams.get("url") || "").trim();
  const id = idOrUrl.match(/(?:^|\/)(\d+)(?:$|[/?#])/)?.[1] || idOrUrl.match(/^\d+$/)?.[0] || "";
  if (!id) {
    return json(request, env, { ok: false, error: "missing_or_invalid_zenith_id" }, 400);
  }

  const embedUrl = new URL(`https://api.zenithjs.ws/embed/movie/${id}`);
  const season = optionalPositiveInt(url.searchParams.get("season"));
  const episode = optionalPositiveInt(url.searchParams.get("episode"));
  if (season && episode) {
    embedUrl.searchParams.set("season", String(season));
    embedUrl.searchParams.set("episode", String(episode));
  }
  const response = await fetch(embedUrl, {
    headers: {
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Origin": "https://kinoserial.online",
      "Referer": "https://kinoserial.online/",
      "User-Agent": zonaUserAgent(),
    },
  });
  const html = await response.text();
  if (!response.ok) {
    throw new Error(`Zenith ${response.status}: ${html.slice(0, 200)}`);
  }

  const parsed = parseZenithEmbed(html);
  const inspect = url.searchParams.get("inspect") === "1" ? inspectZenithHtml(html) : null;
  return json(request, env, {
    ok: true,
    id,
    season: season && episode ? season : null,
    episode: season && episode ? episode : null,
    embedUrl: embedUrl.href,
    status: response.status,
    bytes: html.length,
    sources: parsed.sources,
    meta: parsed.meta,
    hasSources: !!(parsed.sources.dash || parsed.sources.dasha || parsed.sources.hls),
    ...(inspect ? { inspect } : {}),
  });
}

async function handleOpravarResolve(request, env, url) {
  const videoId = (url.searchParams.get("videoId") || "").trim();
  const playerUrl = safeOpravarUrl(url.searchParams.get("url") || "");
  if (!playerUrl) {
    return json(request, env, { ok: false, error: "missing_or_invalid_opravar_url" }, 400);
  }

  if (videoId) {
    if (!/^\d+$/.test(videoId)) {
      return json(request, env, { ok: false, error: "invalid_video_id" }, 400);
    }
    const resolved = await fetchOpravarVideo(videoId, playerUrl, url.searchParams.get("base") || "");
    return json(request, env, { ok: true, provider: "opravar", ...resolved });
  }

  const pageUrl = safeNewdeafUrl(url.searchParams.get("pageUrl") || "");
  const response = await fetch(playerUrl, {
    redirect: "follow",
    headers: opravarHeaders(pageUrl || "https://newdeaf.co/"),
  });
  const html = await response.text();
  if (!response.ok) {
    throw new Error(`Opravar ${response.status}: ${html.slice(0, 200)}`);
  }
  if (html.length > 2_000_000) {
    throw new Error("Opravar player document is unexpectedly large");
  }

  // gencit.info/bil/N 301-redirects to the current (rotating) player host, e.g.
  // ceramet.net today. Everything downstream is derived from that resolved host
  // and the spare host the page itself declares — never hardcoded — because the
  // provider rotates its domains (ddos-guard fronted) like Newdeaf's mirrors.
  const base = safePublicOrigin(new URL(response.url).origin);
  const parsed = parseOpravarPage(html, base);
  if (!parsed.source || !parsed.playlist.length) {
    // Diagnostic (no secrets): tells apart "ddos-guard served Deno a stub"
    // (tiny html / no inputData) from "host rotated past our rewrite" (real
    // html but source unresolved).
    const playerTag = html.match(/<div\b[^>]*\bid=["']videoplayer\d+["'][^>]*>/i)?.[0] || "";
    return json(request, env, {
      ok: false,
      error: "opravar_parse_failed",
      diag: {
        status: response.status,
        finalUrl: response.url,
        htmlLength: html.length,
        hasInputData: /id=["']inputData["']/i.test(html),
        hasConfig: /data-config\s*=/i.test(html),
        spareSeen: htmlAttr(playerTag, "data-spare") || htmlAttr(playerTag, "data-domainspare") || null,
        sourceResolved: !!parsed.source,
        playlistCount: parsed.playlist.length,
        titleSnippet: (html.match(/<title>([^<]*)<\/title>/i)?.[1] || "").slice(0, 100),
      },
    }, 502);
  }
  return json(request, env, {
    ok: true,
    provider: "opravar",
    requestedUrl: playerUrl,
    resolvedUrl: response.url,
    base,
    pageUrl,
    ...parsed,
  });
}

// gencit.info/bil/N -> follow the 301 to learn the current player host so the
// episode/voice API (responce.php) is called on the live host, not a stale one.
async function resolveOpravarBaseOrigin(playerUrl) {
  const response = await fetch(playerUrl, {
    redirect: "follow",
    headers: opravarHeaders("https://newdeaf.co/"),
  });
  await response.text().catch(() => {});
  return safePublicOrigin(new URL(response.url).origin);
}

async function fetchOpravarVideo(videoId, playerUrl, baseParam) {
  const base = safePublicOrigin(baseParam) || (await resolveOpravarBaseOrigin(playerUrl));
  if (!base) throw new Error("Opravar: could not determine current player host");
  const apiUrl = `${base}/player/responce.php?video_id=${encodeURIComponent(videoId)}`;
  const response = await fetch(apiUrl, {
    headers: opravarHeaders(playerUrl),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Opravar video ${response.status}: ${text.slice(0, 200)}`);
  }

  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error("Opravar video API returned invalid JSON");
  }
  const originalSource = data.src || data.hls || "";
  const source = rewriteOpravarMediaHost(originalSource, data.spare);
  if (!source) throw new Error("Opravar video API did not expose a CORS-open spare stream");

  return {
    videoId: Number(videoId),
    source,
    spare: safePublicOrigin(data.spare),
    expiresAt: mediaExpiry(source),
    subtitles: normalizeOpravarSubtitles(data.subtitles),
    thumbnail: data.thumbnail?.src ? rewriteOpravarMediaHost(data.thumbnail.src, data.spare) : null,
  };
}

function parseOpravarPage(html, base) {
  const playerTag = String(html || "").match(/<div\b[^>]*\bid=["']videoplayer\d+["'][^>]*>/i)?.[0] || "";
  const inputMatch = String(html || "").match(/<div\b[^>]*\bid=["']inputData["'][^>]*>([\s\S]*?)<\/div>/i);
  const inputTag = inputMatch?.[0]?.slice(0, inputMatch[0].indexOf(">") + 1) || "";
  const config = parseJson(htmlAttr(playerTag, "data-config")) || {};
  const spare = safePublicOrigin(htmlAttr(playerTag, "data-spare") || htmlAttr(playerTag, "data-domainspare"));
  const source = rewriteOpravarMediaHost(config.hls || config.src || "", spare);
  const playlistData = parseJson(decodeHtml(inputMatch?.[1] || "")) || {};
  const playlist = normalizeOpravarPlaylist(playlistData);
  const current = {
    season: numberOrNull(htmlAttr(inputTag, "data-season")),
    episode: numberOrNull(htmlAttr(inputTag, "data-episode")),
    voiceId: numberOrNull(String(htmlAttr(inputTag, "data-voice") || "").split("#")[0]),
  };
  current.videoId = findOpravarVideoId(playlist, current);

  return {
    base: safePublicOrigin(base) || null,
    source,
    spare,
    expiresAt: mediaExpiry(source),
    subtitles: normalizeOpravarSubtitles({
      original: htmlAttr(playerTag, "data-original_subtitle"),
      ru: htmlAttr(playerTag, "data-ru_subtitle"),
      en: htmlAttr(playerTag, "data-en_subtitle"),
      ua: htmlAttr(playerTag, "data-ua_subtitle"),
    }),
    current,
    playlist,
  };
}

function normalizeOpravarPlaylist(raw) {
  const seasons = [];
  for (const [seasonKey, rawEpisodes] of Object.entries(raw || {})) {
    const season = Number(seasonKey);
    if (!Number.isFinite(season)) continue;
    const episodeEntries = Array.isArray(rawEpisodes)
      ? rawEpisodes.map((voices, index) => [String(index), voices])
      : Object.entries(rawEpisodes || {});
    const episodes = [];
    for (const [episodeKey, rawVoices] of episodeEntries) {
      if (!Array.isArray(rawVoices)) continue;
      const voices = rawVoices.map((voice) => ({
        videoId: numberOrNull(voice?.video_id),
        voiceId: numberOrNull(voice?.voice_id),
        name: String(voice?.voice_name || "Озвучка"),
        duration: numberOrNull(voice?.duration),
      })).filter((voice) => voice.videoId != null && voice.voiceId != null);
      if (!voices.length) continue;
      const episode = numberOrNull(voices[0]?.episode ?? rawVoices[0]?.episode ?? episodeKey);
      if (episode == null) continue;
      episodes.push({ episode, voices });
    }
    episodes.sort((a, b) => a.episode - b.episode);
    if (episodes.length) seasons.push({ season, episodes });
  }
  seasons.sort((a, b) => a.season - b.season);
  return seasons;
}

function findOpravarVideoId(playlist, current) {
  const season = playlist.find((item) => item.season === current.season);
  const episode = season?.episodes.find((item) => item.episode === current.episode);
  return episode?.voices.find((item) => item.voiceId === current.voiceId)?.videoId
    ?? episode?.voices[0]?.videoId
    ?? null;
}

function normalizeOpravarSubtitles(raw) {
  const labels = {
    original: ["original", "Original"],
    ru: ["ru", "Русские"],
    en: ["en", "English"],
    ua: ["uk", "Українські"],
  };
  return Object.entries(raw || {}).flatMap(([key, value]) => {
    if (!value || !labels[key]) return [];
    try {
      const parsed = new URL(String(value));
      // VTT is served CORS-open (ACAO:*) from the rotating player host, so accept
      // any public https .vtt rather than a hardcoded host.
      if (parsed.protocol !== "https:" || !isPublicHost(parsed.hostname) || !/\.vtt$/i.test(parsed.pathname)) return [];
      return [{ language: labels[key][0], label: labels[key][1], url: parsed.href }];
    } catch {
      return [];
    }
  });
}

// Move the signed media path from the primary host (e.g. cdn1.ceramet.net) to
// the reserve host the provider itself declares (data-spare / API `spare`, e.g.
// a1.flintraxvk-companet.pro or f1.werberk.pro). The reserve regenerates nested
// playlist/segment URLs on its host with wildcard CORS, so Shaka on our origin
// can read it. Hosts rotate, so nothing here is hardcoded — we only require both
// sides to be public https hosts.
function rewriteOpravarMediaHost(value, spareValue) {
  try {
    const media = new URL(String(value || ""));
    const spareOrigin = safePublicOrigin(spareValue);
    if (media.protocol !== "https:" || !isPublicHost(media.hostname) || !spareOrigin) return null;
    media.host = new URL(spareOrigin).host;
    return media.href;
  } catch {
    return null;
  }
}

// A public https origin: rejects localhost, bare IPs, and host:port. Used for the
// declared spare/reserve host and the redirect-resolved player base.
function safePublicOrigin(value) {
  try {
    const parsed = new URL(String(value || ""));
    if (parsed.protocol !== "https:" || !isPublicHost(parsed.hostname)) return null;
    return parsed.origin;
  } catch {
    return null;
  }
}

function isPublicHost(host) {
  const h = String(host || "").toLowerCase();
  if (!h || h === "localhost" || h.endsWith(".localhost")) return false;
  if (h.includes(":")) return false; // no IPv6 / host:port
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h)) return false; // no bare IPv4
  if (!h.includes(".")) return false; // must be a dotted domain
  return /^[a-z0-9.-]+$/.test(h);
}

function safeOpravarUrl(value) {
  try {
    const parsed = new URL(String(value || ""));
    if (parsed.protocol !== "https:" || !["gencit.info", "opravar.online"].includes(parsed.hostname)) return null;
    if (!/^\/bil\/\d+\/?$/i.test(parsed.pathname)) return null;
    parsed.username = "";
    parsed.password = "";
    parsed.hash = "";
    return parsed.href;
  } catch {
    return null;
  }
}

function safeNewdeafUrl(value) {
  try {
    const parsed = new URL(String(value || ""));
    if (parsed.protocol !== "https:" || !/(^|\.)newdeaf\.co$/i.test(parsed.hostname)) return null;
    parsed.username = "";
    parsed.password = "";
    parsed.hash = "";
    return parsed.href;
  } catch {
    return null;
  }
}

function opravarHeaders(referer) {
  return {
    "Accept": "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8",
    "Referer": referer,
    "User-Agent": zonaUserAgent(),
  };
}

function htmlAttr(tag, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = String(tag || "").match(new RegExp(`\\b${escaped}\\s*=\\s*([\"'])([\\s\\S]*?)\\1`, "i"));
  return decodeHtml(match?.[2] || "");
}

function decodeHtml(value) {
  return String(value || "")
    .replace(/&quot;/gi, '"')
    .replace(/&#0*39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&amp;/gi, "&");
}

function parseJson(value) {
  try {
    return JSON.parse(String(value || "").trim());
  } catch {
    return null;
  }
}

function numberOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function mediaExpiry(value) {
  try {
    const parts = new URL(String(value || "")).pathname.split("/");
    const epoch = parts.map((part) => Number(part)).find((part) => Number.isInteger(part) && part > 1_500_000_000);
    return epoch ? epoch * 1000 : null;
  } catch {
    return null;
  }
}

async function poiskkinoFetch(env, apiUrl) {
  if (!env.POISKKINO_TOKEN) {
    throw new Error("POISKKINO_TOKEN secret is not configured");
  }

  const response = await fetch(apiUrl, {
    headers: {
      "Accept": "application/json",
      "X-API-KEY": env.POISKKINO_TOKEN,
    },
  });

  const text = await response.text();
  if (!response.ok) {
    throw new Error(`PoiskKino ${response.status}: ${text.slice(0, 300)}`);
  }

  return JSON.parse(text);
}

function normalizeMovie(item) {
  return {
    kpId: item.id ?? null,
    name: item.name ?? null,
    alternativeName: item.alternativeName ?? null,
    enName: item.enName ?? null,
    type: item.type ?? null,
    year: item.year ?? null,
    isSeries: item.isSeries ?? false,
    seasons: normalizeSeasonInfo(item.seasonsInfo),
    movieLength: item.movieLength ?? null,
    description: item.description ?? null,
    shortDescription: item.shortDescription ?? null,
    poster: item.poster?.url || item.poster?.previewUrl || null,
    rating: {
      kp: item.rating?.kp ?? null,
      imdb: item.rating?.imdb ?? null,
    },
    votes: {
      kp: item.votes?.kp ?? null,
      imdb: item.votes?.imdb ?? null,
    },
  };
}

function normalizeSeasonInfo(items) {
  return (Array.isArray(items) ? items : [])
    .map((item) => ({
      season: numberOrNull(item?.number ?? item?.seasonNumber),
      episodes: Array.from(
        { length: Math.max(0, numberOrNull(item?.episodesCount) || 0) },
        (_, index) => ({ episode: index + 1 }),
      ),
    }))
    .filter((item) => item.season > 0 && item.episodes.length)
    .sort((a, b) => a.season - b.season);
}

function normalizeSeasons(items) {
  return (Array.isArray(items) ? items : [])
    .map((item) => {
      const season = numberOrNull(item?.number ?? item?.seasonNumber);
      let episodes = (Array.isArray(item?.episodes) ? item.episodes : [])
        .map((episode) => ({
          episode: numberOrNull(episode?.number ?? episode?.episodeNumber),
          title: String(episode?.name || episode?.nameRu || episode?.enName || episode?.nameEn || "").trim(),
        }))
        .filter((episode) => episode.episode > 0)
        .sort((a, b) => a.episode - b.episode);
      if (!episodes.length) {
        const count = Math.max(0, numberOrNull(item?.episodesCount) || 0);
        episodes = Array.from({ length: count }, (_, index) => ({ episode: index + 1, title: "" }));
      }
      return { season, episodes };
    })
    .filter((item) => item.season > 0 && item.episodes.length)
    .sort((a, b) => a.season - b.season);
}

// kinopoiskapiunofficial.tech /api/v2.2/films/{id} -> our normalized movie shape.
function normalizeUnofficialFilm(item) {
  const year = String(item.year ?? "").match(/\d{4}/)?.[0] || null;
  return {
    kpId: item.kinopoiskId ?? item.filmId ?? null,
    name: item.nameRu || item.nameOriginal || item.nameEn || null,
    alternativeName: item.nameOriginal || null,
    enName: item.nameEn || null,
    type: item.type ?? null,
    year: year ? Number(year) : null,
    isSeries: !!item.serial || /SERIES|TV_SHOW|MINI/i.test(String(item.type || "")),
    movieLength: typeof item.filmLength === "number" ? item.filmLength : null,
    description: item.description ?? null,
    shortDescription: item.shortDescription ?? null,
    poster: item.posterUrl || item.posterUrlPreview || null,
    rating: { kp: numOrNull(item.ratingKinopoisk), imdb: numOrNull(item.ratingImdb) },
    votes: { kp: numOrNull(item.ratingKinopoiskVoteCount), imdb: numOrNull(item.ratingImdbVoteCount) },
  };
}

// kinopoiskapiunofficial.tech /api/v2.1/films/search-by-keyword item. Search hits
// carry only a single string `rating` (KP) and no IMDb rating; year is a string.
function normalizeUnofficialSearch(item) {
  const year = String(item.year ?? "").match(/\d{4}/)?.[0] || null;
  return {
    kpId: item.filmId ?? item.kinopoiskId ?? null,
    name: item.nameRu || item.nameEn || null,
    alternativeName: item.nameEn || null,
    enName: item.nameEn || null,
    type: item.type ?? null,
    year: year ? Number(year) : null,
    isSeries: /SERIES|TV_SHOW|MINI/i.test(String(item.type || "")),
    movieLength: null,
    description: item.description ?? null,
    shortDescription: null,
    poster: item.posterUrl || item.posterUrlPreview || null,
    rating: { kp: ratingStr(item.rating), imdb: null },
    votes: { kp: numOrNull(item.ratingVoteCount), imdb: null },
  };
}

function numOrNull(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function ratingStr(value) {
  if (value == null || value === "null" || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function poiskkinoBase(env) {
  return env.POISKKINO_BASE_URL || DEFAULT_POISKKINO_BASE_URL;
}

function json(request, env, body, status = 200) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: {
      ...corsHeaders(request, env),
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function corsHeaders(request, env) {
  const requestOrigin = request.headers.get("origin") || "";
  return {
    "access-control-allow-origin": pickAllowOrigin(requestOrigin, env.ALLOWED_ORIGIN),
    "access-control-allow-methods": "GET, OPTIONS",
    "access-control-allow-headers": "content-type, authorization",
    "vary": "Origin",
  };
}

// Decide the Access-Control-Allow-Origin value. Beyond the explicit env
// allowlist we trust any *.vercel.app (so per-commit PREVIEW deploys, whose
// subdomain hash changes every push, work without re-listing them), any
// *.alphy.tv, and localhost. This is a credential-less public resolver — CORS
// is not its security boundary (the PoiskKino token never leaves the server),
// so reflecting these origins is safe and saves constant allowlist edits.
export function pickAllowOrigin(requestOrigin, allowedCsv) {
  const allowed = (allowedCsv || "").split(",").map((item) => item.trim()).filter(Boolean);
  const trusted =
    (requestOrigin && allowed.includes(requestOrigin)) ||
    /^https:\/\/([a-z0-9-]+\.)*vercel\.app$/i.test(requestOrigin) ||
    /^https:\/\/([a-z0-9-]+\.)*alphy\.tv$/i.test(requestOrigin) ||
    /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(requestOrigin);
  if (trusted) return requestOrigin;
  return allowed[0] || "*";
}

function clampInt(value, min, max, fallback) {
  const parsed = Number.parseInt(value || "", 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function optionalPositiveInt(value) {
  if (value == null || value === "") return null;
  const parsed = Number.parseInt(String(value), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function enqueueZonaResolve(task) {
  const run = zonaResolveQueue.then(task, task);
  zonaResolveQueue = run.catch(() => {});
  return run;
}

// The Zona runtime drives all its network I/O through globalThis.fetch, so we
// intercept fetch to (a) capture which api.zenithjs.ws embed it resolves to and
// (b) inject the headers mzona.net requires. The naive approach — swap
// globalThis.fetch per call and restore after — leaks across calls in a
// long-lived process (Deno Deploy / Render / reused Vercel instances): getStreams
// fires background requests that keep running after we return, and they land in
// the NEXT call's capture, so every resolve returns the previous title's Zenith
// id. Cloudflare hid this only because it discards an isolate's background work
// once the response is sent. Fix: an AsyncLocalStorage store so each fetch
// attributes itself to the resolve that actually started it, no matter when it
// lands. If async_hooks is unavailable (e.g. a Cloudflare Worker without the
// flag) we fall back to the per-call swap, which is correct on ephemeral isolates.
let zonaCapture;
let zonaCaptureInstalled = false;

async function ensureZonaCapture() {
  if (zonaCapture !== undefined) return zonaCapture;
  try {
    const { AsyncLocalStorage } = await import("node:async_hooks");
    zonaCapture = new AsyncLocalStorage();
  } catch {
    zonaCapture = null;
  }
  if (zonaCapture && !zonaCaptureInstalled) {
    zonaCaptureInstalled = true;
    const realFetch = globalThis.fetch.bind(globalThis);
    globalThis.fetch = (input, init = {}) => {
      const store = zonaCapture.getStore();
      if (!store) return realFetch(input, init);
      return capturedFetch(realFetch, store, input, init);
    };
  }
  return zonaCapture;
}

function capturedFetch(realFetch, store, input, init = {}) {
  const targetUrl = String(input?.url || input);
  if (isZonaResolverRequest(targetUrl)) {
    store.requests.push({ method: init?.method || "GET", url: targetUrl });
  }
  const headers = new Headers(init.headers || {});
  if (/\.mzona\.net\//i.test(targetUrl)) {
    headers.set("Origin", "https://kinoserial.online");
    headers.set("Referer", "https://kinoserial.online/");
    headers.set("User-Agent", zonaUserAgent());
    headers.set("Accept", "*/*");
  }
  return realFetch(input, { ...init, headers });
}

function runZonaProvider(lib, kpId, requests, callbacks) {
  const provider = lib.createStreamsProvider({
    getStreamDurationInMicroseconds: () => "0",
  });
  provider.getStreams(Number(kpId), null, null, {
    onStreamsReceived(payload) {
      callbacks.push(parseMaybeJson(payload));
    },
    onCompletion() {},
  });
  return waitFor(() => extractZenithIds(requests).length > 0, 12000);
}

async function resolveZonaInPureJs(kpId) {
  const lib = getZonaLib();
  if (!lib?.createStreamsProvider) {
    throw new Error("Zona stream library did not expose createStreamsProvider");
  }

  const requests = [];
  const callbacks = [];
  const als = await ensureZonaCapture();
  const previousConsole = globalThis.console;
  globalThis.console = {
    ...previousConsole,
    debug() {},
    error() {},
    info() {},
    log() {},
    warn() {},
  };

  try {
    if (als) {
      await als.run({ requests, callbacks }, () => runZonaProvider(lib, kpId, requests, callbacks));
    } else {
      const previousFetch = globalThis.fetch;
      globalThis.fetch = (input, init = {}) => capturedFetch(previousFetch, { requests }, input, init);
      try {
        await runZonaProvider(lib, kpId, requests, callbacks);
      } finally {
        globalThis.fetch = previousFetch;
      }
    }
  } finally {
    globalThis.console = previousConsole;
  }

  const zenithIds = extractZenithIds(requests);
  return {
    kpId,
    zenithId: zenithIds[0] || null,
    zenithIds,
    embedUrl: zenithIds[0] ? `https://api.zenithjs.ws/embed/movie/${zenithIds[0]}` : null,
    callbacks: callbacks.map(summarizeZonaCallback),
    requests: requests.slice(0, 50),
  };
}

function isZonaResolverRequest(url) {
  return /mzona\.net|api\.zenithjs\.ws|fotpro|vibio/i.test(url);
}

function extractZenithIds(requests) {
  return [...new Set(
    requests
      .map((request) => request.url.match(/api\.zenithjs\.ws\/embed\/movie\/(\d+)/i)?.[1])
      .filter(Boolean)
  )];
}

function parseMaybeJson(value) {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return { raw: value.slice(0, 1000) };
  }
}

function summarizeZonaCallback(value) {
  const streams = Array.isArray(value?.videoStreams) ? value.videoStreams : [];
  return {
    extractorType: value?.extractorType?.name || value?.extractorType || null,
    count: streams.length,
    streams: streams.slice(0, 5).map((stream) => ({
      url: stream?.source?.url || stream?.url || null,
      translation: stream?.translation || null,
      language: stream?.language || null,
      resolution: stream?.resolution || null,
      quality: stream?.quality || null,
      subtitles: Array.isArray(stream?.subtitles) ? stream.subtitles.length : null,
    })),
  };
}

function parseZenithEmbed(html) {
  const text = String(html || "");
  const sources = {};
  for (const match of text.matchAll(/\b(dash|dasha|hls)\s*:\s*("(?:(?:\\.|[^"\\])*)"|'(?:(?:\\.|[^'\\])*)')/g)) {
    sources[match[1]] = decodeJsQuoted(match[2]).replace(/&amp;/g, "&");
  }

  const fallbackText = text.replace(/\\\//g, "/").replace(/&amp;/g, "&");
  if (!sources.dash) sources.dash = firstUrl(fallbackText, /\.mpd(?:\?|$)/i);
  if (!sources.hls) sources.hls = firstUrl(fallbackText, /(?:\.m3u8|master\.m3u8)(?:\?|$)/i);

  const titleMatch = text.match(/\btitle\s*:\s*("(?:(?:\\.|[^"\\])*)"|'(?:(?:\\.|[^'\\])*)')/);
  const audioMatch = text.match(/\baudio\s*:\s*\{\s*["']?names["']?\s*:\s*\[([^\]]*)\]/);
  return {
    sources,
    meta: {
      title: titleMatch ? decodeJsQuoted(titleMatch[1]) : "",
      audioNames: audioMatch ? [...audioMatch[1].matchAll(/"([^"]+)"|'([^']+)'/g)].map((match) => match[1] || match[2]) : [],
    },
  };
}

function inspectZenithHtml(html) {
  const text = String(html || "");
  const scriptSrcs = [...text.matchAll(/<script\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/gi)]
    .map((match) => decodeHtml(match[1]))
    .slice(0, 50);
  const snippets = [];
  const seen = new Set();
  for (const match of text.matchAll(/season|episode|serial|playlist|translation|download_link_key/gi)) {
    const start = Math.max(0, match.index - 240);
    const snippet = text.slice(start, Math.min(text.length, match.index + 600)).replace(/\s+/g, " ");
    if (seen.has(snippet)) continue;
    seen.add(snippet);
    snippets.push(snippet);
    if (snippets.length >= 80) break;
  }
  return { scriptSrcs, snippets };
}

function firstUrl(text, kindRe) {
  for (const match of String(text || "").matchAll(/https?:\/\/[^"'<>\s\\]+/g)) {
    const url = match[0].replace(/[),.;]+$/, "");
    if (kindRe.test(url)) return url;
  }
  return "";
}

function decodeJsQuoted(raw) {
  const body = String(raw || "").slice(1, -1);
  return body
    .replace(/\\u([0-9a-f]{4})/gi, (_, hex) => String.fromCharCode(Number.parseInt(hex, 16)))
    .replace(/\\x([0-9a-f]{2})/gi, (_, hex) => String.fromCharCode(Number.parseInt(hex, 16)))
    .replace(/\\([\\/"'bfnrt])/g, (_, char) => {
      if (char === "b") return "\b";
      if (char === "f") return "\f";
      if (char === "n") return "\n";
      if (char === "r") return "\r";
      if (char === "t") return "\t";
      return char;
    });
}

async function waitFor(predicate, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}
