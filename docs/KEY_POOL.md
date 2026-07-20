# Unified Kinopoisk key pool

## Data flow

- `api.poiskkino.dev` keys and `kinopoiskapiunofficial.tech` keys live in one
  encrypted registry at `admin/key-pool.enc.json` in Vercel Blob.
- The Blob object is public only at the transport layer because this project
  already has a public Blob store. Its payload is AES-256-GCM ciphertext. The
  master key is `ALPHY_KEY_POOL_MASTER_KEY` in Vercel and is never sent to a
  browser or to Deno.
- `/api/admin/key-pool` decrypts the registry only after the normal Alphy admin
  session is verified.
- `/api/key-pool/runtime` returns enabled runtime entries only when Deno presents
  `ALPHY_KEY_POOL_TOKEN`.
- Deno caches the registry for five minutes and keeps the last known good copy
  when Vercel or Blob is temporarily unavailable. Admin saves request an
  immediate reload, so this polling is only a recovery path.
- `foryou.js` contains no API keys. Recommendation metadata and similars use the
  resolver's `/recommendations/*` endpoints.

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
- A key with both scopes off is retained in encrypted storage but never sent to
  Deno. Turning `включён` off has the same runtime effect while preserving its
  scope choices.

## Status and counters

`Проверить` calls the provider's own token-info endpoint and shows its real daily
quota. Deno separately records request count, errors, last status, operations and
average upstream latency per registry key. Those operational counters are batched
into the Deno Cache API and are approximate under concurrent cold isolates; they
are useful for rotation diagnostics, not billing reconciliation.

Do not rotate `ALPHY_KEY_POOL_MASTER_KEY` by simply replacing it: re-encrypt the
existing registry with `rewriteKeyPoolCiphertext()` in `api/_key-pool-store.js`
first. Rotating `ALPHY_KEY_POOL_TOKEN` is safe from the admin registry side, but
the matching Deno secret must be updated once.
