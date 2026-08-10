import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { makeSandbox, sleep } from "./helpers/app-sandbox.js";

async function liftwHelpers() {
  const ctx = makeSandbox();
  ctx.run();
  await sleep(80);
  return ctx.sandbox.window.alphyBridge._test;
}

test("LiftW search payload is normalized without Kinopoisk metadata calls", async () => {
  const helpers = await liftwHelpers();
  const results = helpers.normalizeLiftwSearchPayload({
    totalCount: 3,
    items: [
      {
        id: 15534,
        type: 1,
        name: "Бэтмен",
        origin_name: "The Batman",
        poster: "https://img.niteface.ws/poster-token",
        year: 2022,
        imdb_rating: 7.9,
        kp_rating: 7.9,
        quality: "FHD",
      },
      {
        id: 11991,
        type: 5,
        name: "Бэтмен",
        poster: "https://evil.example/tracker.jpg",
        year: 1992,
        imdb_rating: 9,
        kp_rating: 7.92,
        serial_status: "Все серии",
        quality: "HD",
      },
      { id: "not-an-id", type: 1, name: "bad" },
    ],
  });

  assert.equal(results.length, 2);
  assert.deepEqual(JSON.parse(JSON.stringify(results[0])), {
    id: "15534",
    title: "Бэтмен",
    originalTitle: "The Batman",
    year: 2022,
    poster: "https://img.niteface.ws/poster-token",
    quality: "FHD",
    serialStatus: "",
    rating: { kp: 7.9, imdb: 7.9 },
    type: 1,
    typeLabel: "фильм",
    isSeries: false,
    url: "https://liftw.ws/details.html?id=15534",
  });
  assert.equal(results[1].isSeries, true);
  assert.equal(results[1].typeLabel, "мультсериал");
  assert.equal(results[1].poster, "");
  assert.equal(results[1].serialStatus, "Все серии");
});

test("LiftW search is fail-closed inside the opaque client sandbox", async () => {
  const source = await readFile(new URL("../app.js", import.meta.url), "utf8");
  const start = source.indexOf("async function searchLiftw");
  const end = source.indexOf("function normalizeLiftwSearchPayload", start);
  const block = source.slice(start, end);
  assert.ok(start >= 0 && end > start);
  assert.match(block, /preferSandbox:\s*true/);
  assert.match(block, /directFallback:\s*false/);
  assert.doesNotMatch(block, /resolverJson|\/api\//);
});

test("LiftW detail links accept only numeric ids", async () => {
  const helpers = await liftwHelpers();
  assert.equal(helpers.liftwDetailsUrl(42), "https://liftw.ws/details.html?id=42");
  assert.equal(helpers.liftwDetailsUrl("javascript:alert(1)"), "");
});

test("LiftW cards do not enter any Alphy playback route", async () => {
  const source = await readFile(new URL("../app.js", import.meta.url), "utf8");
  const start = source.indexOf("function makeLiftwCard");
  const end = source.indexOf("function makeCollapsCard", start);
  const block = source.slice(start, end);
  assert.ok(start >= 0 && end > start);
  assert.match(block, /openExternalNoReferrer/);
  assert.match(block, /noopener noreferrer/);
  assert.doesNotMatch(block, /\/watch\/|\bgo\s*\(|resolveKp|recordOpen/);
});
