-- The mirrored catalogue. Built by the Cloudflare crawler, read by the browser
-- one letter-shard at a time.
create table if not exists titles (
  id          integer primary key,
  name        text not null,
  year        integer,
  type        integer,
  slug        text,
  initial     text,
  embed_id    integer,
  kp          text,
  rate_kp     real,
  origin_name text,
  is_series   boolean
);

-- Shards are looked up by first letter, so both initials are indexed.
create index if not exists titles_initial on titles (initial);

-- The original title's initial. Without it an English query loaded the shard for
-- its own first letter, which holds titles whose RUSSIAN name starts that way —
-- so "Good Will Hunting" could never reach «Умница Уилл Хантинг» no matter how
-- the matcher scored. A trigger rather than a column default or application code
-- because three writers touch origin_name (crawler upsert, /resolve backfill,
-- manual repair) and any one of them forgetting would silently lose the row from
-- Latin search.
alter table titles add column if not exists origin_initial text;

create or replace function titles_set_origin_initial() returns trigger
language plpgsql as $fn$
begin
  -- Mirrors the client's suggestFold: leading punctuation ignored, ё folded to е.
  new.origin_initial := nullif(
    replace(
      lower(substring(regexp_replace(coalesce(new.origin_name, ''), '[^[:alnum:]]+', '', 'g') from 1 for 1)),
      'ё', 'е'),
    '');
  return new;
end
$fn$;

drop trigger if exists titles_origin_initial_trg on titles;
create trigger titles_origin_initial_trg
  before insert or update of origin_name on titles
  for each row execute function titles_set_origin_initial();

create index if not exists titles_origin_initial on titles (origin_initial);

-- Backfill for rows written before the trigger existed.
update titles set origin_name = origin_name where origin_name is not null and origin_initial is null;
