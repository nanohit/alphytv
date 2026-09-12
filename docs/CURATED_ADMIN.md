# Curated homepage administration

## Runtime shape

- Source of truth: private Supabase `alphy_documents`, updated with an atomic
  revision check. Visitors read the published `catalog-cdn` snapshot on jsDelivr.
- `/api/catalog-snapshot` supplies the publisher; `/curated-live.json` is a
  compatibility route to that endpoint, not the normal homepage path.
- Public pointer: `/curated-config.json`.
- Deployment fallback: `/curated-fallback.json`.
- Admin authentication and writes: Vercel Functions under `/api/admin/*`.
- Playback and metadata resolver: unchanged Deno deployment.

Normal homepage traffic does not execute a Function and does not touch Deno.
The browser reads the CDN snapshot, with a bundled deployment fallback.
`npm run sync:catalog` snapshots the live catalog into the deployment fallback
and a revisioned file under `docs/catalog-backups/`.

`npm run refresh:identity` also incrementally fills `imdb-map.json`; existing
IDs are reused and only newly added identities reach Cinemeta. The daily
`Refresh catalog identity` GitHub Action runs the same pipeline and commits a
changed snapshot. `npm run check:identity` is an offline coverage check used by
CI. Rare aliases that Cinemeta cannot resolve belong in `imdb-overrides.json`.

## Authentication

Set these variables in Production and Preview:

```text
ALPHY_ADMIN_USER
ALPHY_ADMIN_PASSWORD
ALPHY_STATE_URL
ALPHY_STATE_SERVICE_KEY
ALPHY_KEY_POOL_MASTER_KEY
```

The footer's `admin` link opens the browser's native HTTP Basic prompt against
`/api/admin/login`. After a successful login, a signed eight-hour `HttpOnly`
cookie authorizes the same-origin admin endpoints. Raw credentials never enter
frontend JavaScript, browser storage, the bundle, or a URL, and no credential
is embedded in static assets, localStorage, catalog JSON, or links.

Admin mode is enabled atomically only after both the credential check and the
catalog read succeed. A storage failure is reported separately from invalid
credentials, and editing controls are never rendered during verification.

## Save semantics

The catalog has an integer `revision`. PUT requests include `baseRevision`.
Conflicts return HTTP 409 with the current snapshot. The client retries once
against that revision, keeps an unsaved local draft, and shows explicit
dirty/saving/saved/error state.

The Function reads and writes private Supabase RPCs using its service key.
Catalog updates and the encrypted key pool do not use Vercel Blob. Migrate both
documents and verify their revisions before deploying these endpoints; see
`SCALING_IMPLEMENTATION_2026-09-12.md` for the rollout sequence.

The server validates and caps the payload:

- up to 24 lists;
- up to 60 items per list;
- up to 512 KiB total JSON;
- allowlisted playback target shapes;
- public HTTPS artwork URLs only.

## Cached item contract

Each curated item contains:

```json
{
  "id": "stable-editor-id",
  "key": "zen:2097",
  "title": "Конь БоДжек",
  "year": "2014",
  "poster": "https://…",
  "backdrop": "https://…",
  "description": "…",
  "isSeries": true,
  "movieLength": null,
  "rating": { "kp": 8.4, "imdb": 8.8 },
  "target": { "kind": "zen", "zenithId": "2097" },
  "cachedAt": "2026-06-24T00:00:00Z"
}
```

The add button is exposed only after a player has actually initialized. When
possible, a loaded `kpId` title is stored as the resolved Zenith ID, so opening
the homepage card skips search, Newdeaf parsing, and Zona mapping.

## Continue snapshots

Only the latest Continue entry keeps a snapshot, limiting localStorage growth.
Shaka captures a 480×270 JPEG after `loadeddata`, `playing`, `pause`, or
`seeked`. The injected Ortified cleanroom hook attempts the same capture from
inside the player document. If the provider taints canvas, the wide card falls
back to a darkened poster.

Continue uses its own layout rather than the ordinary poster-card component.
The latest entry is a wide 16:9 card; the remaining entries are narrow posters
with the same media height. Episode/season, remaining minutes, and progress are
rendered inside the image, and the section heading shows the item count.
