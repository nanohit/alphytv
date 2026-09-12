import test from "node:test";
import assert from "node:assert/strict";
import { expiredObject } from "../scripts/clean-kp-cache.mjs";
import { objectSlot } from "../supabase/functions/kp/index.ts";

test("cache maintenance keeps the current/previous slots and never touches unrelated data", () => {
  const now = Date.parse("2026-09-12T05:00:00Z");
  for (const kind of ["film", "staff", "similars", "search"]) {
    const slot = objectSlot(kind, "301", now);
    const path = (s) => `v2/${kind}/301/${s}.json`;
    assert.equal(expiredObject(path(slot), now), false);
    assert.equal(expiredObject(path(slot - 1), now), false);
    assert.equal(expiredObject(path(slot - 2), now), true);
    assert.equal(expiredObject(path(slot + 1), now), false);
  }
  for (const name of ["v1/film/301.json", "catalog.json", "provider-cache/zona/301.json", "v2/other/301/1.json", "v2/film/../1.json"])
    assert.equal(expiredObject(name, now), false);
});
