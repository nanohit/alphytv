import test from "node:test";
import assert from "node:assert/strict";

import worker from "../worker/src/index.js";

const env = { ALLOWED_ORIGIN: "http://127.0.0.1:5177" };

test("rejects invalid Zona serial selection before upstream resolve", async () => {
  const response = await worker.fetch(
    new Request("http://local/resolve-zona?kpId=408414&season=x&episode=1"),
    env,
  );
  const body = await response.json();

  assert.equal(response.status, 400);
  assert.equal(body.ok, false);
  assert.equal(body.error, "invalid_season_episode");
});

test("rejects incomplete Zona serial selection before upstream resolve", async () => {
  const response = await worker.fetch(
    new Request("http://local/resolve-zona?kpId=408414&season=1"),
    env,
  );
  const body = await response.json();

  assert.equal(response.status, 400);
  assert.equal(body.ok, false);
  assert.equal(body.error, "invalid_season_episode");
});
