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
  embed_id       integer,
  kp             text,
  rate_kp        real,
  origin_name    text,
  is_series      boolean
);

-- Shards are looked up by first letter, so both initials are indexed.
create index if not exists titles_initial on titles (initial);
create index if not exists titles_origin_initial on titles (origin_initial);

-- /resolve looks a title up by slug, and until this existed that was a
-- sequential scan of all 81,702 rows — 1035ms measured — on the write half of
-- every resolve. Unique because slugs are (81,702 of 81,702 distinct), and
-- because the lookup wants exactly one row to then PATCH by primary key.
create unique index if not exists titles_slug on titles (slug);

-- One trigger owns both initials.
--
-- `origin_initial` exists because routing on the Russian name alone meant an
-- English query loaded the shard for its own first letter, which holds titles
-- whose RUSSIAN name starts that way — "Good Will Hunting" could never reach
-- «Умница Уилл Хантинг» no matter how the matcher scored.
--
-- Both are derived here rather than by whoever writes the row, because three
-- writers touch these columns (crawler upsert, /resolve backfill, manual repair)
-- and they did drift: `initial` used to be the bare first character the crawler
-- sent, so 101 titles like «Авария» – дочь мента sat in a shard named « that no
-- viewer can ask for — the client strips leading punctuation before it picks a
-- letter. Deriving both in one place is the only way they cannot drift again.
create or replace function titles_set_initials() returns trigger
language plpgsql as $fn$
declare
  first_alnum text;
begin
  -- Mirrors the client's suggestFold: leading punctuation ignored, ё folded to е.
  first_alnum := lower(substring(regexp_replace(coalesce(new.name, ''), '[^[:alnum:]]+', '', 'g') from 1 for 1));
  new.initial := nullif(replace(first_alnum, 'ё', 'е'), '');
  first_alnum := lower(substring(regexp_replace(coalesce(new.origin_name, ''), '[^[:alnum:]]+', '', 'g') from 1 for 1));
  new.origin_initial := nullif(replace(first_alnum, 'ё', 'е'), '');
  return new;
end
$fn$;

drop trigger if exists titles_initials_trg on titles;
create trigger titles_initials_trg
  before insert or update of name, origin_name on titles
  for each row execute function titles_set_initials();

-- The rebuild queue. /build pops letters from it, so a write rewrites only the
-- shards it actually changed. At most one row per distinct initial, so it never
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
  -- DISTINCT is load-bearing. A row whose Russian and original initials are the
  -- same letter — or whose initials did not change across an update, which is
  -- most updates — proposes the same key twice in one statement, and ON CONFLICT
  -- DO UPDATE then aborts with "cannot affect row a second time". That fails the
  -- caller's write, not just the bookkeeping.
  insert into shard_dirty (letter, marked_at)
  select distinct letter, now() from (values
    (new.initial), (new.origin_initial),
    -- The shards a renamed row is LEAVING are stale too, so both sides count.
    (case when tg_op = 'UPDATE' then old.initial end),
    (case when tg_op = 'UPDATE' then old.origin_initial end)
  ) as v(letter)
  where letter is not null
  -- Never ignore-duplicates. Bumping the timestamp is what tells a build already
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
  -- Only what a shard actually carries, plus the two initials that decide which
  -- shard carries it. A write that changes none of them invalidates nothing.
  when (
    (old.name, old.year, old.slug, old.is_series, old.embed_id, old.kp,
     old.origin_name, old.initial, old.origin_initial)
    is distinct from
    (new.name, new.year, new.slug, new.is_series, new.embed_id, new.kp,
     new.origin_name, new.initial, new.origin_initial)
  )
  execute function titles_mark_shard_dirty();

-- The distinct initials, as one cheap read. Asking `titles` for them instead
-- silently answers with the letters of the first thousand rows — PostgREST caps
-- a plain select — and the builder then skips three quarters of the alphabet.
create or replace view shard_letters as
  select distinct letter from (
    select initial as letter from titles where initial is not null
    union all
    select origin_initial from titles where origin_initial is not null
  ) t;

-- Storage: a public bucket `index` holding v<N>/<codepoint-hex>.json per letter.
-- Public because the shards are the same data the site already serves, and
-- because a public object is CDN-cached while a function response never is.
--   insert into storage.buckets (id, name, public) values ('index','index',true)
--     on conflict (id) do update set public = true;

-- Re-derive every row after changing the trigger:
--   update titles set name = name;
