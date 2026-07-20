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
- PoiskKino keys never leave the encrypted registry/Deno runtime. Enabled
  Unofficial keys with the `browser` scope are intentionally returned by the
  CDN-cached `/api/client-key-pool` view; the provider supports browser CORS and
  these requests then carry the viewer's real egress IP.

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
- `браузер (public)`: publishes an Unofficial key to the client-side pool. It is
  never available for PoiskKino. Browser calls are not present in Deno metrics;
  use `Проверить` for the provider's authoritative quota totals.
- A key with both scopes off is retained in encrypted storage but never sent to
  Deno. Turning `включён` off has the same runtime effect while preserving its
  scope choices.

## Status and counters

`Проверить` calls the provider's own token-info endpoint and shows its real daily
quota. Deno separately records request count, errors, last status, operations and
average upstream latency per registry key. Those operational counters are batched
into the Deno Cache API and are approximate under concurrent cold isolates; they
are useful for rotation diagnostics, not billing reconciliation.

## Runtime load

- PoiskKino search, title metadata and batch enrichment are small JSON requests
  to Deno. Unofficial similars, credits and title lookup go directly from the
  browser; Deno remains their fallback. Player manifests and media segments go
  directly from the viewer to their source CDN.
- A cold Similar shelf uses one Unofficial similars request and one PoiskKino
  batch request for the entire row. Metadata is cached in the browser for 30
  days; it never fans out into one request per card.
- Deno reads the encrypted registry through Vercel at most once every five
  minutes per warm isolate. An admin save asks Deno to reload immediately, so
  edits do not wait for the poll.
- Vercel is otherwise used for the admin control plane, encrypted Blob storage
  and a five-minute CDN-cached client-key response. Recommendation/provider
  traffic does not proxy through Vercel.

Do not rotate `ALPHY_KEY_POOL_MASTER_KEY` by simply replacing it: re-encrypt the
existing registry with `rewriteKeyPoolCiphertext()` in `api/_key-pool-store.js`
first. Rotating `ALPHY_KEY_POOL_TOKEN` is safe from the admin registry side, but
the matching Deno secret must be updated once.
