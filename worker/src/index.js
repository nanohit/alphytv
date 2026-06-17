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

      if (url.pathname === "/resolve-zona") {
        return await handleZonaResolve(request, env, url);
      }

      if (url.pathname === "/zenith") {
        return await handleZenith(request, env, url);
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

  const apiUrl = new URL("/v1.4/movie/search", poiskkinoBase(env));
  apiUrl.searchParams.set("query", query);
  apiUrl.searchParams.set("limit", String(limit));

  const raw = await poiskkinoFetch(env, apiUrl);
  const docs = Array.isArray(raw.docs) ? raw.docs : [];
  // Year is a soft hint: providers (e.g. Newdeaf) and PoiskKino often disagree
  // by a year on the same title, so match within +/-1 and never let the year
  // filter zero out an otherwise-valid result.
  const yearNum = Number.parseInt(year, 10);
  let filtered = docs;
  if (Number.isFinite(yearNum)) {
    const near = docs.filter((item) => {
      const y = Number.parseInt(item.year, 10);
      return Number.isFinite(y) && Math.abs(y - yearNum) <= 1;
    });
    filtered = near.length ? near : docs;
  }

  return json(request, env, {
    ok: true,
    query,
    year: year || null,
    total: raw.total ?? docs.length,
    results: filtered.map(normalizeMovie),
  });
}

async function handleMovie(request, env, url) {
  const id = (url.searchParams.get("id") || url.searchParams.get("kpId") || "").trim();
  if (!/^\d+$/.test(id)) {
    return json(request, env, { ok: false, error: "missing_or_invalid_id" }, 400);
  }

  const apiUrl = new URL(`/v1.4/movie/${id}`, poiskkinoBase(env));
  const raw = await poiskkinoFetch(env, apiUrl);
  return json(request, env, { ok: true, movie: normalizeMovie(raw) });
}

async function handleZonaResolve(request, env, url) {
  const kpId = (url.searchParams.get("kpId") || url.searchParams.get("id") || "").trim();
  if (!/^\d+$/.test(kpId)) {
    return json(request, env, { ok: false, error: "missing_or_invalid_kpId" }, 400);
  }

  const resolved = await enqueueZonaResolve(() => resolveZonaInPureJs(kpId));
  return json(request, env, { ok: true, ...resolved });
}

async function handleZenith(request, env, url) {
  const idOrUrl = (url.searchParams.get("id") || url.searchParams.get("url") || "").trim();
  const id = idOrUrl.match(/(?:^|\/)(\d+)(?:$|[/?#])/)?.[1] || idOrUrl.match(/^\d+$/)?.[0] || "";
  if (!id) {
    return json(request, env, { ok: false, error: "missing_or_invalid_zenith_id" }, 400);
  }

  const embedUrl = `https://api.zenithjs.ws/embed/movie/${id}`;
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
  return json(request, env, {
    ok: true,
    id,
    embedUrl,
    status: response.status,
    bytes: html.length,
    sources: parsed.sources,
    meta: parsed.meta,
    hasSources: !!(parsed.sources.dash || parsed.sources.dasha || parsed.sources.hls),
  });
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
