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
