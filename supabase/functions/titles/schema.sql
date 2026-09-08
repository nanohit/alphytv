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

-- The rebuild queue. Ingest marks the letters a batch touched, /build pops them,
-- so a push rewrites only the shards it actually changed. At most one row per
-- distinct initial, so it never grows.
create table if not exists shard_dirty (
  letter    text primary key,
  marked_at timestamptz not null default now()
);

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
