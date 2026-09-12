# Unified Kinopoisk key pool

## Data flow

- `api.poiskkino.dev` keys and `kinopoiskapiunofficial.tech` keys live in one
  encrypted registry in private Supabase `alphy_documents`, name `key_pool`.
- The payload is AES-256-GCM ciphertext. The master key is
  `ALPHY_KEY_POOL_MASTER_KEY` in Vercel and never goes to a browser or Deno.
- `/api/admin/key-pool` decrypts the registry only after the normal Alphy admin
  session is verified.
- `/api/key-pool/runtime` returns enabled runtime entries only when Deno presents
  `ALPHY_KEY_POOL_TOKEN`.
- Deno caches the registry for five minutes and keeps the last known good copy
  when the control plane is temporarily unavailable. Admin saves request an
  immediate reload, so this polling is only a recovery path.
- `/api/client-key-pool` returns an empty compatibility envelope. The browser
  reads shared Storage objects and asks Deno `/kp` for misses. Deno coalesces
  requests before the private Supabase broker, which owns the shared quota.

## One-time Deno link

Open `admin` on `alphy.tv`, click `API keys`, and run the setup command shown in
the dialog. It adds one secret named `ALPHY_KEY_POOL_TOKEN` to the `alphy / alphytv`
Deno application. A reload caused by that env change is expected.

After that one command, adding, editing, enabling, scoping, testing, or deleting
provider keys is done entirely from the Alphy admin dialog. Deno imports its old
`POISKKINO_*` and `KINOPOISK_UNOFFICIAL_*` env values into the registry on the
first successful link, so legacy keys are not silently dropped.

## Scopes

- `поиск / мета`: `/search` and `/movie` traffic. PoiskKino is primary;
  Kinopoisk Unofficial is fallback.
- `для вас`: `/recommendations/*` traffic. Only Kinopoisk Unofficial supports
  the endpoints currently used by the local recommendation engine.
- `общий кэш метаданных`: enables the private metadata broker. The stored field
  remains `browser` for compatibility, but no API key is published to visitors.
  Use `Проверить` for the provider's authoritative remaining quota.
- A key with all scopes off is retained in encrypted storage but never sent to
  Deno. Turning `включён` off has the same runtime effect while preserving its
  scope choices.

## Status and counters

`Проверить` calls the provider's own token-info endpoint and shows its real daily
quota. Deno separately records request count, errors, last status, operations and
average upstream latency per registry key. Those operational counters are batched
into the Deno Cache API and are approximate under concurrent cold isolates; they
are useful for rotation diagnostics, not billing reconciliation.

## Runtime load

- Ordinary Enter search uses shared KU keyword search, including titles absent
  from Lift. The static index is its outage fallback and always serves preview.
  Recommendation metadata uses shared film
  objects. These paths no longer request PoiskKino.
- Similar shelves use the external KU candidate list and shared film objects,
  with bounded concurrency for card enrichment. Warm reads cost no broker
  invocation; new distinct objects still consume quota.
- Deno reads the encrypted registry through Vercel at most once every five
  minutes per warm isolate. An admin save asks Deno to reload immediately, so
  edits do not wait for the poll.
- Vercel is otherwise used for the admin control plane. Recommendation/provider
  traffic does not proxy through Vercel.

Do not rotate `ALPHY_KEY_POOL_MASTER_KEY` by simply replacing it: re-encrypt the
existing registry with `rewriteKeyPoolCiphertext()` in `api/_key-pool-store.js`
first. Rotating `ALPHY_KEY_POOL_TOKEN` is safe from the admin registry side, but
the matching Deno secret must be updated once.
