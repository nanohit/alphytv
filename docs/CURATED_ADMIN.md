# Curated homepage administration

## Runtime shape

- Public data: `catalog/curated.json` in the public `alphy-curated` Vercel Blob
  store.
- Public pointer: `/curated-config.json`.
- Deployment fallback: `/curated-fallback.json`.
- Admin authentication and writes: Vercel Functions under `/api/admin/*`.
- Playback and metadata resolver: unchanged Deno deployment.

Normal homepage traffic does not execute a Function and does not touch Deno.
The browser downloads one small CDN-cached JSON document.

## Authentication

Set these variables in Production and Preview:

```text
ALPHY_ADMIN_USER
ALPHY_ADMIN_PASSWORD
BLOB_READ_WRITE_TOKEN
```

The frontend keeps credentials in `sessionStorage` for the current tab. It
sends HTTP Basic authorization only to the same-origin admin endpoints. No
credential is embedded in static assets, localStorage, catalog JSON, or links.

Admin mode is enabled atomically only after both the credential check and the
catalog read succeed. A storage failure is reported separately from invalid
credentials, and editing controls are never rendered during verification.

## Save semantics

The catalog has an integer `revision`. PUT requests include `baseRevision`.
Conflicts return HTTP 409 with the current snapshot. The client retries once
against that revision, keeps an unsaved local draft, and shows explicit
dirty/saving/saved/error state.

The Function reads the known public Blob URL directly. Writes use the Blob REST
endpoint only on authenticated PUT requests, keeping the public path and admin
GET cold start free of the Blob SDK module graph.

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
