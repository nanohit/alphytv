-- The mirrored catalogue. Built by the Cloudflare crawler, rendered into static
-- per-letter shards in Storage, and read from there by the browser.
create table if not exists titles (
  id             integer primary key,
  name           text not null,
  year           integer,
  type           integer,
  slug           text,
  initial        text,
  origin_initial text,
  shard_keys     text[],
  embed_id       integer,
  kp             text,
  rate_kp        real,
  origin_name    text,
  is_series      boolean
);

create index if not exists titles_initial on titles (initial);
create index if not exists titles_origin_initial on titles (origin_initial);

-- The shard query is an array-contains, so GIN.
create index if not exists titles_shard_keys on titles using gin (shard_keys);

-- /resolve looks a title up by slug, and until this existed that was a
-- sequential scan of all 81,702 rows — 1035ms measured — on the write half of
-- every resolve. Unique because slugs are (81,702 of 81,702 distinct), and
-- because the lookup wants exactly one row to then PATCH by primary key.
create unique index if not exists titles_slug on titles (slug);

-- Every letter a title can be reached by: the first character of each of its
-- words, across the Russian name and the original one.
--
-- Routing used to be a single `initial`, so «Пираты Карибского моря» lived only
-- in shard п. The matcher has always claimed it matches the start of any word —
-- the tests assert it — but the client loads the shard for the first letter of
-- the QUERY, so typing «карибского» fetched shard к and the row was never
-- delivered to the matcher at all. Exactly the shape of the earlier
-- English-title bug: the matcher could, the router never let it.
--
-- Costs 2.4× the row instances (111k -> 269k) and takes the busiest shard from
-- 259KB to ~450KB brotli. Filtering out words shorter than three characters
-- saves only 11% and loses real queries, so every word counts.
create or replace function shard_keys_of(p_name text, p_origin text) returns text[]
language sql immutable as $fn$
  select coalesce(array_agg(distinct letter), '{}'::text[])
  from (
    select replace(lower(left(w, 1)), 'ё', 'е') as letter
    from unnest(regexp_split_to_array(
      -- Mirrors the client's suggestFold exactly: runs of non-alphanumerics
      -- become one space, lowercase, ё folded to е.
      regexp_replace(coalesce(p_name, '') || ' ' || coalesce(p_origin, ''), '[^[:alnum:]]+', ' ', 'g'),
      ' +')) as w
    where w <> ''
  ) t
  where letter <> '';
$fn$;

alter table titles add column if not exists shard_keys text[];

-- One BEFORE trigger owns everything derived, and everything that must not be
-- lost. Two of them would have needed an ordering, and Postgres orders
-- same-kind triggers alphabetically by name — a footgun to leave lying around.
create or replace function titles_before_write() returns trigger
language plpgsql as $fn$
declare
  first_alnum text;
begin
  -- Enrichment never regresses to null.
  --
  -- Two independent writers own these columns: the crawler, which publishes
  -- whole rows out of its own D1 copy, and /resolve, which writes straight here.
  -- So a title resolved by a viewer (embed_id 44097) whose D1 row still says
  -- null was reset to null the next time the crawler republished it — and phase
  -- 1 marks every row it re-reads dirty, so this needs no unusual sequence.
  -- null means "not known" for all four; a writer that knows nothing must not
  -- overwrite one that knows something.
  if tg_op = 'UPDATE' then
    new.embed_id    := coalesce(new.embed_id, old.embed_id);
    new.kp          := coalesce(new.kp, old.kp);
    new.origin_name := coalesce(new.origin_name, old.origin_name);
    new.is_series   := coalesce(new.is_series, old.is_series);
  end if;

  -- Both initials are still derived here rather than by whoever writes the row,
  -- because they did drift: `initial` was once the bare first character the
  -- crawler sent, so 101 titles like «Авария» – дочь мента sat in a shard named
  -- « that no viewer can ask for — the client strips leading punctuation before
  -- it picks a letter.
  first_alnum := lower(substring(regexp_replace(coalesce(new.name, ''), '[^[:alnum:]]+', '', 'g') from 1 for 1));
  new.initial := nullif(replace(first_alnum, 'ё', 'е'), '');
  first_alnum := lower(substring(regexp_replace(coalesce(new.origin_name, ''), '[^[:alnum:]]+', '', 'g') from 1 for 1));
  new.origin_initial := nullif(replace(first_alnum, 'ё', 'е'), '');
  new.shard_keys := shard_keys_of(new.name, new.origin_name);
  return new;
end
$fn$;

drop trigger if exists titles_initials_trg on titles;
drop trigger if exists titles_before_write on titles;
create trigger titles_before_write
  before insert or update on titles
  for each row execute function titles_before_write();

-- The rebuild queue. /build pops letters from it, so a write rewrites only the
-- shards it actually changed. At most one row per distinct letter, so it never
-- grows.
create table if not exists shard_dirty (
  letter    text primary key,
  marked_at timestamptz not null default now()
);

-- Invalidation belongs here and not in whoever writes the row.
--
-- It started life as a set computed inside the ingest handler, which meant
-- /resolve — a second writer to the same table — queued nothing at all. Rows it
-- wrote reached Postgres and no shard, so its whole purpose ("write it back and
-- the next viewer gets it for free") bought nothing: viewers read a Storage
-- snapshot, and the next one paid another request to the source for the same
-- title. A trigger cannot be forgotten by a writer that did not exist yet.
create or replace function titles_mark_shard_dirty() returns trigger
language plpgsql as $fn$
begin
  -- Every shard the row is in, and on an update every shard it was in: a rename
  -- leaves some and enters others, and both sides are stale.
  --
  -- DISTINCT is load-bearing. Proposing one key twice in a single statement
  -- makes ON CONFLICT DO UPDATE abort with "cannot affect row a second time",
  -- which fails the caller's write, not just the bookkeeping.
  insert into shard_dirty (letter, marked_at)
  select distinct letter, now() from unnest(
    coalesce(new.shard_keys, '{}'::text[]) ||
    case when tg_op = 'UPDATE' then coalesce(old.shard_keys, '{}'::text[]) else '{}'::text[] end
  ) as letter
  where letter is not null and letter <> ''
  -- Never ignore-duplicates. Moving the timestamp is what tells a build already
  -- in flight that its snapshot is stale: the builder deletes the queue entry
  -- only if the mark still matches the one it read before it started. With
  -- ignore-duplicates the second mark changed nothing and the unconditional
  -- delete then threw it away — the change sat in Postgres, in no shard, and
  -- nothing noticed until something else happened to touch that letter.
  on conflict (letter) do update set marked_at = excluded.marked_at;
  return null;
end
$fn$;

-- Two triggers, because a WHEN clause cannot see TG_OP — it may reference only
-- OLD and NEW, and OLD does not exist on an insert.
drop trigger if exists titles_shard_dirty_ins on titles;
drop trigger if exists titles_shard_dirty_upd on titles;

create trigger titles_shard_dirty_ins
  after insert on titles
  for each row execute function titles_mark_shard_dirty();

create trigger titles_shard_dirty_upd
  after update of name, year, slug, is_series, embed_id, kp, origin_name on titles
  for each row
  -- Only what a shard actually carries, plus the keys that decide which shards
  -- carry it. A write that changes none of them invalidates nothing.
  when (
    (old.name, old.year, old.slug, old.is_series, old.embed_id, old.kp,
     old.origin_name, old.shard_keys)
    is distinct from
    (new.name, new.year, new.slug, new.is_series, new.embed_id, new.kp,
     new.origin_name, new.shard_keys)
  )
  execute function titles_mark_shard_dirty();

-- Every letter any shard is keyed by. Asking `titles` directly returns only the
-- first 1000 rows' worth — PostgREST's cap — and the builder then silently skips
-- most of the alphabet.
create or replace view shard_letters as
  select distinct unnest(shard_keys) as letter from titles;

-- Storage: a public bucket `index` holding v<N>/<codepoint-hex>.json per letter.
-- Public because the shards are the same data the site already serves, and
-- because a public object is CDN-cached while a function response never is.
--   insert into storage.buckets (id, name, public) values ('index','index',true)
--     on conflict (id) do update set public = true;
--
-- Storage ignores Cache-Control on upload — header and multipart cacheControl
-- alike — and serves every object as `no-cache`. That is not the problem it
-- looks like: the CDN then revalidates, so a rebuilt shard is visible at once.
-- The staleness that mattered was the browser's own copy, which had nothing
-- checking it for a week; the client now revalidates it with an ETag.

-- Re-derive every row after changing the trigger:
--   update titles set name = name;
