-- Shared Kinopoisk Unofficial cache: which objects exist, who is filling one
-- right now, and how much of each key's daily quota is spent.
--
-- The objects themselves are public Storage files read straight from the CDN,
-- so nothing here is touched on an ordinary page view — only when a film is
-- missing or stale. Keys are never stored: `key_id` is a hash prefix of one.
-- Idempotent; run it as often as you like.

create table if not exists public.kp_cache (
  kind text not null check (kind in ('film', 'staff', 'similars')),
  kp_id bigint not null check (kp_id > 0),
  status text not null default 'pending' check (status in ('pending', 'ok', 'missing')),
  host text,
  fresh_until timestamptz,
  retry_at timestamptz,
  -- Fencing: bumped on every lease, so a worker that outlived its lease cannot
  -- overwrite what the next one wrote.
  version integer not null default 0,
  lease_owner text,
  lease_until timestamptz,
  bytes integer,
  fills integer not null default 0,
  updated_at timestamptz not null default now(),
  primary key (kind, kp_id)
);
alter table public.kp_cache enable row level security;

create table if not exists public.kp_key_day (
  key_id text not null,
  day date not null,
  used integer not null default 0,
  exhausted boolean not null default false,
  primary key (key_id, day)
);
alter table public.kp_key_day enable row level security;

create table if not exists public.kp_key_state (
  key_id text primary key,
  cooldown_until timestamptz,
  disabled_at timestamptz,
  last_status integer,
  updated_at timestamptz not null default now()
);
alter table public.kp_key_state enable row level security;

-- Take the right to fill one object. Succeeds only when it actually needs
-- filling (never fetched, missing its freshness, or past a failure's back-off)
-- and nobody else holds a live lease on it.
create or replace function public.kp_acquire(p_kind text, p_id bigint, p_owner text, p_lease_seconds integer)
returns table (acquired boolean, version integer, status text, fresh_until timestamptz, host text, retry_at timestamptz)
language plpgsql security definer set search_path = public as $$
#variable_conflict use_column
declare
  rec public.kp_cache;
begin
  insert into public.kp_cache (kind, kp_id) values (p_kind, p_id) on conflict do nothing;
  update public.kp_cache c
     set lease_owner = p_owner,
         lease_until = now() + make_interval(secs => p_lease_seconds),
         version = c.version + 1,
         updated_at = now()
   where c.kind = p_kind and c.kp_id = p_id
     and (c.lease_until is null or c.lease_until < now())
     and (c.status = 'pending' or c.fresh_until is null or c.fresh_until < now())
     and (c.retry_at is null or c.retry_at < now())
  returning * into rec;
  if found then
    return query select true, rec.version, rec.status, rec.fresh_until, rec.host, rec.retry_at;
    return;
  end if;
  select * into rec from public.kp_cache c where c.kind = p_kind and c.kp_id = p_id;
  return query select false, rec.version, rec.status, rec.fresh_until, rec.host, rec.retry_at;
end $$;

-- Finish a fill. A null status records a failure: the object keeps whatever it
-- had, and only the back-off moves.
create or replace function public.kp_complete(
  p_kind text, p_id bigint, p_owner text, p_version integer,
  p_status text, p_host text, p_fresh_until timestamptz, p_retry_at timestamptz, p_bytes integer
) returns boolean
language plpgsql security definer set search_path = public as $$
#variable_conflict use_column
begin
  update public.kp_cache c
     set status = coalesce(p_status, c.status),
         host = coalesce(p_host, c.host),
         fresh_until = coalesce(p_fresh_until, c.fresh_until),
         retry_at = p_retry_at,
         bytes = coalesce(p_bytes, c.bytes),
         fills = c.fills + case when p_status is null then 0 else 1 end,
         lease_owner = null,
         lease_until = null,
         updated_at = now()
   where c.kind = p_kind and c.kp_id = p_id
     and c.lease_owner = p_owner and c.version = p_version;
  return found;
end $$;

create or replace function public.kp_read(p_kind text, p_id bigint)
returns table (status text, fresh_until timestamptz, host text, retry_at timestamptz, leased boolean)
language sql security definer set search_path = public as $$
  select c.status, c.fresh_until, c.host, c.retry_at, coalesce(c.lease_until > now(), false)
    from public.kp_cache c where c.kind = p_kind and c.kp_id = p_id
$$;

-- Spend one unit of the least-used key that still has quota today. The limit
-- passed in is below the provider's own, so two racing callers cannot push a
-- key over it by more than a request or two.
create or replace function public.kp_reserve_key(p_keys text[], p_day date, p_limit integer)
returns text
language plpgsql security definer set search_path = public as $$
declare
  chosen text;
begin
  select k.key_id into chosen
    from unnest(p_keys) with ordinality as k(key_id, ord)
    left join public.kp_key_day d on d.key_id = k.key_id and d.day = p_day
    left join public.kp_key_state s on s.key_id = k.key_id
   where coalesce(d.used, 0) < p_limit
     and not coalesce(d.exhausted, false)
     and s.disabled_at is null
     and (s.cooldown_until is null or s.cooldown_until < now())
   order by coalesce(d.used, 0), k.ord
   limit 1;
  if chosen is null then
    return null;
  end if;
  insert into public.kp_key_day (key_id, day, used) values (chosen, p_day, 1)
  on conflict (key_id, day) do update set used = public.kp_key_day.used + 1;
  return chosen;
end $$;

-- What the provider said about a key. 402: spent for today. 401: not a key any
-- more. 403 and 429: sit out for a while rather than for good.
create or replace function public.kp_key_report(p_key text, p_day date, p_status integer)
returns void
language plpgsql security definer set search_path = public as $$
begin
  if p_status = 402 then
    insert into public.kp_key_day (key_id, day, used, exhausted) values (p_key, p_day, 0, true)
    on conflict (key_id, day) do update set exhausted = true;
  end if;
  insert into public.kp_key_state (key_id, cooldown_until, disabled_at, last_status, updated_at)
  values (
    p_key,
    case when p_status = 429 then now() + interval '1 minute'
         when p_status = 403 then now() + interval '1 hour' end,
    case when p_status = 401 then now() end,
    p_status,
    now()
  )
  on conflict (key_id) do update set
    cooldown_until = case when p_status = 429 then now() + interval '1 minute'
                          when p_status = 403 then now() + interval '1 hour'
                          else public.kp_key_state.cooldown_until end,
    disabled_at = case when p_status = 401 then now() else public.kp_key_state.disabled_at end,
    last_status = p_status,
    updated_at = now();
end $$;

-- Only the broker (service role) may call these.
revoke all on function public.kp_acquire(text, bigint, text, integer) from public, anon, authenticated;
revoke all on function public.kp_complete(text, bigint, text, integer, text, text, timestamptz, timestamptz, integer) from public, anon, authenticated;
revoke all on function public.kp_read(text, bigint) from public, anon, authenticated;
revoke all on function public.kp_reserve_key(text[], date, integer) from public, anon, authenticated;
revoke all on function public.kp_key_report(text, date, integer) from public, anon, authenticated;
grant execute on function public.kp_acquire(text, bigint, text, integer) to service_role;
grant execute on function public.kp_complete(text, bigint, text, integer, text, text, timestamptz, timestamptz, integer) to service_role;
grant execute on function public.kp_read(text, bigint) to service_role;
grant execute on function public.kp_reserve_key(text[], date, integer) to service_role;
grant execute on function public.kp_key_report(text, date, integer) to service_role;
