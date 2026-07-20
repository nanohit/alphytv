import test from "node:test";
import assert from "node:assert/strict";

import worker from "../worker/src/index.js";

const env = { ALLOWED_ORIGIN: "http://127.0.0.1:5177" };

// These must reject before any upstream (mzona) call, so they stay fast and
// hermetic — no network, no 9s resolve wait.

test("rejects a non-numeric Zona kpId", async () => {
  const response = await worker.fetch(
    new Request("http://local/resolve-zona?kpId=abc"),
    env,
  );
  const body = await response.json();

  assert.equal(response.status, 400);
  assert.equal(body.ok, false);
  assert.equal(body.error, "missing_or_invalid_kpId");
});

test("rejects a missing Zona kpId", async () => {
  const response = await worker.fetch(
    new Request("http://local/resolve-zona"),
    env,
  );
  const body = await response.json();

  assert.equal(response.status, 400);
  assert.equal(body.ok, false);
  assert.equal(body.error, "missing_or_invalid_kpId");
});

test("recommendation API uses only managed recommendation keys and reports metrics", async () => {
  const originalFetch = globalThis.fetch;
  const attempts = [];
  const upstream = [];
  globalThis.fetch = async (request, init = {}) => {
    upstream.push({ url: String(request), key: init.headers?.["X-API-KEY"] });
    return new Response(JSON.stringify({ items: [{ filmId: 326, nameRu: "Побег" }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  try {
    const response = await worker.fetch(
      new Request("http://local/recommendations/similars?id=301"),
      {
        ALLOWED_ORIGIN: "http://127.0.0.1:5177",
        __KEY_POOL_MANAGED: true,
        __KEY_POOL_KEYS: [{
          id: "rec-1",
          provider: "unofficial",
          label: "recommendations",
          value: "secret-key",
          scopes: { resolver: false, recommendations: true },
        }],
        __recordKeyAttempt: (event) => attempts.push(event),
      },
    );
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.items[0].filmId, 326);
    assert.equal(upstream[0].key, "secret-key");
    assert.equal(attempts[0].id, "rec-1");
    assert.equal(attempts[0].operation, "recommendations:similars");
    assert.equal(attempts[0].ok, true);
    assert.equal(JSON.stringify(body).includes("secret-key"), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("movie metadata keeps Kinopoisk person ids without extra upstream calls", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return new Response(JSON.stringify({
      id: 301,
      name: "Матрица",
      year: 1999,
      persons: [
        { id: 10, name: "Режиссёр", enProfession: "director" },
        { id: 20, name: "Актёр", enProfession: "actor" },
      ],
    }), { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    const response = await worker.fetch(new Request("http://local/movie?id=301"), {
      ALLOWED_ORIGIN: "http://127.0.0.1:5177",
      __KEY_POOL_MANAGED: true,
      __KEY_POOL_KEYS: [{
        id: "pk-1",
        provider: "poiskkino",
        label: "primary",
        value: "secret-key",
        scopes: { resolver: true, recommendations: false },
      }],
    });
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(calls, 1);
    assert.deepEqual(body.movie.people.directors, [{ id: "10", name: "Режиссёр" }]);
    assert.deepEqual(body.movie.people.cast, [{ id: "20", name: "Актёр" }]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
