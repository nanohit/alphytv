import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const fn = () => readFile(new URL("../supabase/functions/titles/index.ts", import.meta.url), "utf8");
const schema = () => readFile(new URL("../supabase/functions/titles/schema.sql", import.meta.url), "utf8");
const script = () => readFile(new URL("../scripts/build-title-shards.mjs", import.meta.url), "utf8");

test("shard invalidation is the database's job, not a writer's", async () => {
  const sql = await schema();
  // Computing the touched letters inside the ingest handler meant /resolve —
  // which writes to the same table — queued nothing, so the rows it wrote
  // reached Postgres and no shard, and viewers read a stale snapshot forever.
  assert.match(sql, /create trigger titles_shard_dirty_ins\s+after insert on titles/);
  assert.match(sql, /create trigger titles_shard_dirty_upd\s+after update of/);
  // A rename leaves one shard and enters another; both are stale.
  assert.match(sql, /case when tg_op = 'UPDATE' then old\.initial end/);
  assert.match(sql, /case when tg_op = 'UPDATE' then old\.origin_initial end/);
  // Without DISTINCT a row whose two initials coincide proposes the same key
  // twice and ON CONFLICT DO UPDATE aborts the caller's write outright.
  assert.match(sql, /select distinct letter, now\(\)/);
  // The mark must move on every write, or a build in flight cannot tell that
  // its snapshot went stale.
  assert.match(sql, /on conflict \(letter\) do update set marked_at = excluded\.marked_at/);

  const source = await fn();
  const ingest = source.slice(source.indexOf("// Ingest, from the Cloudflare crawler only."),
    source.indexOf("if (url.pathname.endsWith(\"/resolve\")"));
  assert.doesNotMatch(ingest, /touched/);
  assert.doesNotMatch(ingest, /ignore-duplicates/);
});

test("a letter re-marked mid-build stays queued", async () => {
  const source = await fn();
  const build = source.slice(source.indexOf('if (url.pathname.endsWith("/build")'),
    source.indexOf("// Ingest, from the Cloudflare crawler only."));
  // The timestamps are read before anything is built...
  assert.match(build, /select=letter,marked_at/);
  assert.match(build, /const marks = new Map\(/);
  // ...and the delete afterwards is conditional on them. An unconditional
  // delete threw away a mark that arrived while the letter was being built.
  assert.match(build, /marked_at=eq\.\$\{encodeURIComponent\(mark\)\}/);
  assert.match(build, /const mark = marks\.get\(letter\)/);

  // The operator script runs the same risk and takes the same precaution.
  const full = await script();
  assert.match(full, /shard_dirty\?select=letter,marked_at/);
  assert.match(full, /marked_at=eq\.\$\{encodeURIComponent\(mark\)\}/);
});
