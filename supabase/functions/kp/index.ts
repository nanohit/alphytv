// Shared Kinopoisk Unofficial cache.
//
// Every browser used to spend its own Unofficial quota on the same films: a
// title opened by a thousand people cost a thousand `film` + `staff` +
// `similars` calls, and the pool ran out at about a thousand daily users. Here
// a film is fetched once for everyone and published as a public Storage file,
// which browsers read straight from the CDN. This function is reached only for
// a film that is missing or stale.
//
// How a fill behaves:
//  - one worker per (kind, film): a Postgres lease with a fencing version, so a
//    thousand simultaneous misses make one upstream call and a worker that
//    outlived its lease cannot overwrite the next one's result;
//  - one budget for every key: a key is reserved from today's quota before it
//    is used, 402 retires it until midnight Moscow time, 401 retires it for
//    good, 403/429 bench it for a while;
//  - a failure is never an answer. A timeout or 5xx returns an error and backs
//    the film off for a minute; it is never published as "no similar films".
//
// The objects keep the provider's own shape (staff trimmed to the two
// professions the site reads), so the browser's normalisers are unchanged.

export const KINDS = ["film", "staff", "similars"];

// Objects are spread over three projects in three organisations: each has its
// own free egress. 256 stable placement groups sit between a film and a
// project, so growing the ring moves groups, not every object.
export const OBJECT_HOSTS = [
  "xoathqkggcuyoyutxwri",
  "hcuhanruaclhiltpdegc",
  "matozzgmaranfemgxpzy",
];
export const GROUP_HOSTS: number[] = Array.from({ length: 256 }, (_, group) => group % OBJECT_HOSTS.length);
export const BUCKET = "kp";

export function placementGroup(id: string): number {
  let hash = 0;
  for (const char of String(id)) hash = (Math.imul(hash, 31) + char.charCodeAt(0)) >>> 0;
  return hash % 256;
}

export const hostFor = (id: string): string => OBJECT_HOSTS[GROUP_HOSTS[placementGroup(id)]];
export const objectPath = (kind: string, id: string): string => `v1/${kind}/${id}.json`;

const DAY_MS = 24 * 3600e3;
// Not worse than the browser caches they replace: metadata a week, the lists a
// month. A film the provider does not know is re-asked after a week.
export const FRESH_MS: Record<string, number> = { film: 7 * DAY_MS, staff: 30 * DAY_MS, similars: 30 * DAY_MS };
const MISSING_MS = 7 * DAY_MS;
const RETRY_MS = 60_000;
const NO_BUDGET_RETRY_MS = 10 * 60_000;
const LEASE_SECONDS = 30;
// Below the provider's 500 so racing reservations cannot tip a key over.
export const DAILY_LIMIT = 480;
const KEY_ATTEMPTS = 2;
const WAIT_MS = 6000;
const POLL_MS = 400;
const ACTORS_KEPT = 40;

export function upstreamPath(kind: string, id: string): string {
  if (kind === "film") return `/api/v2.2/films/${id}`;
  if (kind === "similars") return `/api/v2.2/films/${id}/similars`;
  return `/api/v1/staff?filmId=${id}`;
}

// The site reads directors and actors only — the first three and eight, by
// staffId, nameRu/nameEn and professionKey. Every director and the first forty
// actors are kept, in the provider's order, which leaves room for the entries
// the readers skip (no id, no name, duplicates).
export function compactPayload(kind: string, data: unknown): unknown {
  if (kind !== "staff") return data;
  const out: Record<string, unknown>[] = [];
  let actors = 0;
  for (const person of Array.isArray(data) ? data : []) {
    const profession = String(person?.professionKey || "");
    if (profession !== "DIRECTOR" && profession !== "ACTOR") continue;
    if (profession === "ACTOR" && actors >= ACTORS_KEPT) continue;
    if (profession === "ACTOR") actors += 1;
    out.push({
      staffId: person?.staffId ?? null,
      nameRu: person?.nameRu ?? null,
      nameEn: person?.nameEn ?? null,
      professionKey: profession,
    });
  }
  return out;
}

// The provider's daily quota turns over at midnight Moscow time.
export const moscowDay = (now: number): string => new Date(now + 3 * 3600e3).toISOString().slice(0, 10);

export async function keyIdOf(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`alphy-kp:${value}`));
  return [...new Uint8Array(digest)].slice(0, 8).map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
};

const reply = (body: unknown, status = 200, cache = "no-store") => new Response(JSON.stringify(body), {
  status,
  headers: { ...CORS, "Content-Type": "application/json", "Cache-Control": cache },
});

type Key = { id: string; value: string };
type Deps = {
  rpc: (name: string, args: Record<string, unknown>) => Promise<any>;
  putObject: (host: string, path: string, body: string, maxAgeSeconds: number) => Promise<void>;
  getObject: (host: string, path: string) => Promise<any>;
  upstream: (path: string, key: string) => Promise<{ status: number; body: any }>;
  keys: () => Promise<Key[]>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  owner?: string;
};

export function createKpHandler(deps: Deps) {
  const now = deps.now || (() => Date.now());
  const sleep = deps.sleep || ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const owner = deps.owner || crypto.randomUUID();
  const isFresh = (until: string | null) => !!until && Date.parse(until) > now();

  async function serveStored(kind: string, id: string, host: string | null) {
    try {
      const stored = await deps.getObject(host || hostFor(id), objectPath(kind, id));
      if (stored?.v === 1) return reply(stored, 200, "public, max-age=300");
    } catch { /* fall through to the caller's error */ }
    return null;
  }

  async function finish(kind: string, id: string, version: number, fields: Record<string, unknown>) {
    try {
      await deps.rpc("kp_complete", {
        p_kind: kind, p_id: Number(id), p_owner: owner, p_version: version,
        p_status: null, p_host: null, p_fresh_until: null, p_retry_at: null, p_bytes: null,
        ...fields,
      });
    } catch { /* the lease simply expires */ }
  }

  async function fill(kind: string, id: string, version: number) {
    const keys = await deps.keys();
    if (!keys.length) {
      await finish(kind, id, version, { p_retry_at: new Date(now() + NO_BUDGET_RETRY_MS).toISOString() });
      return reply({ error: "no_keys" }, 503);
    }
    const day = moscowDay(now());
    for (let attempt = 0; attempt < KEY_ATTEMPTS; attempt += 1) {
      const chosen = await deps.rpc("kp_reserve_key", {
        p_keys: keys.map((key) => key.id), p_day: day, p_limit: DAILY_LIMIT,
      });
      const key = keys.find((entry) => entry.id === chosen);
      if (!key) {
        await finish(kind, id, version, { p_retry_at: new Date(now() + NO_BUDGET_RETRY_MS).toISOString() });
        return reply({ error: "budget_exhausted" }, 503);
      }
      let answer;
      try {
        answer = await deps.upstream(upstreamPath(kind, id), key.value);
      } catch {
        await finish(kind, id, version, { p_retry_at: new Date(now() + RETRY_MS).toISOString() });
        return reply({ error: "upstream_unreachable" }, 503);
      }
      if ([401, 402, 403, 429].includes(answer.status)) {
        try { await deps.rpc("kp_key_report", { p_key: key.id, p_day: day, p_status: answer.status }); } catch { /* best effort */ }
        continue;
      }
      const missing = answer.status === 404 || answer.status === 400;
      if (!missing && (answer.status !== 200 || answer.body == null)) {
        await finish(kind, id, version, { p_retry_at: new Date(now() + RETRY_MS).toISOString() });
        return reply({ error: "upstream_failed", status: answer.status }, 503);
      }
      const freshFor = missing ? MISSING_MS : FRESH_MS[kind];
      const object = {
        v: 1,
        kind,
        id: Number(id),
        status: missing ? "missing" : "ok",
        fetchedAt: new Date(now()).toISOString(),
        freshUntil: new Date(now() + freshFor).toISOString(),
        data: missing ? null : compactPayload(kind, answer.body),
      };
      const body = JSON.stringify(object);
      const host = hostFor(id);
      try {
        await deps.putObject(host, objectPath(kind, id), body, 3600);
      } catch {
        // The caller still gets its answer; the next miss after the back-off
        // will publish it.
        await finish(kind, id, version, { p_retry_at: new Date(now() + RETRY_MS).toISOString() });
        return reply(object, 200);
      }
      await finish(kind, id, version, {
        p_status: object.status,
        p_host: host,
        p_fresh_until: object.freshUntil,
        p_bytes: body.length,
      });
      return reply(object, 200, "public, max-age=300");
    }
    await finish(kind, id, version, { p_retry_at: new Date(now() + RETRY_MS).toISOString() });
    return reply({ error: "keys_refused" }, 503);
  }

  return async function handle(req: Request): Promise<Response> {
    if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
    if (req.method !== "GET") return reply({ error: "method_not_allowed" }, 405);
    const url = new URL(req.url);
    const kind = url.searchParams.get("kind") || "";
    const id = url.searchParams.get("id") || "";
    if (!KINDS.includes(kind) || !/^[1-9]\d{0,9}$/.test(id)) return reply({ error: "bad_request" }, 400);

    let lease;
    try {
      [lease] = await deps.rpc("kp_acquire", {
        p_kind: kind, p_id: Number(id), p_owner: owner, p_lease_seconds: LEASE_SECONDS,
      });
    } catch {
      return reply({ error: "state_unavailable" }, 503);
    }
    if (lease?.acquired) return fill(kind, id, lease.version);

    // Someone else's answer is already published, or is being fetched now.
    if (lease && lease.status !== "pending" && isFresh(lease.fresh_until)) {
      const stored = await serveStored(kind, id, lease.host);
      if (stored) return stored;
    }
    const until = now() + WAIT_MS;
    while (now() < until) {
      await sleep(POLL_MS);
      let row;
      try {
        [row] = await deps.rpc("kp_read", { p_kind: kind, p_id: Number(id) });
      } catch {
        break;
      }
      if (!row || row.leased) continue;
      if (row.status !== "pending" && isFresh(row.fresh_until)) {
        const stored = await serveStored(kind, id, row.host);
        if (stored) return stored;
      }
      break;
    }
    if (lease?.retry_at && Date.parse(lease.retry_at) > now()) {
      return reply({ error: "backing_off", retryAt: lease.retry_at }, 503);
    }
    return reply({ error: "busy" }, 503);
  };
}

// ---------------------------------------------------------------- runtime
declare const Deno: any;
if (typeof Deno !== "undefined") {
  const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
  const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  const self = new URL(SUPABASE_URL).hostname.split(".")[0];
  // Service keys of the other object hosts, {"<ref>": "<key>"}; never logged.
  let hostKeys: Record<string, string> = {};
  try { hostKeys = JSON.parse(Deno.env.get("KP_HOST_KEYS") ?? "{}"); } catch { hostKeys = {}; }
  hostKeys[self] = SERVICE_KEY;

  let keysPromise: Promise<Key[]> | null = null;
  const keys = () => {
    keysPromise ||= Promise.all(String(Deno.env.get("KU_KEYS") ?? "")
      .split(",").map((value) => value.trim()).filter(Boolean)
      .map(async (value) => ({ id: await keyIdOf(value), value })));
    return keysPromise;
  };

  const handle = createKpHandler({
    keys,
    async rpc(name, args) {
      const response = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${name}`, {
        method: "POST",
        headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify(args),
        signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) throw new Error(`rpc ${name} ${response.status}`);
      return response.status === 204 ? null : response.json();
    },
    async putObject(host, path, body, maxAgeSeconds) {
      const key = hostKeys[host];
      if (!key) throw new Error(`no key for ${host}`);
      const response = await fetch(`https://${host}.supabase.co/storage/v1/object/${BUCKET}/${path}`, {
        method: "POST",
        headers: {
          apikey: key,
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/json",
          "cache-control": `max-age=${maxAgeSeconds}`,
          "x-upsert": "true",
        },
        body,
        signal: AbortSignal.timeout(8000),
      });
      if (!response.ok) throw new Error(`storage ${host} ${response.status}`);
    },
    async getObject(host, path) {
      const response = await fetch(`https://${host}.supabase.co/storage/v1/object/public/${BUCKET}/${path}`, {
        signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) return null;
      return response.json();
    },
    async upstream(path, key) {
      const response = await fetch(`https://kinopoiskapiunofficial.tech${path}`, {
        headers: { "X-API-KEY": key, Accept: "application/json" },
        signal: AbortSignal.timeout(7000),
      });
      const text = await response.text();
      let body = null;
      try { body = JSON.parse(text); } catch { body = null; }
      return { status: response.status, body };
    },
  });

  Deno.serve(handle);
}
