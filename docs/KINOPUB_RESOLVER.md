# KinoPub direct resolver

## Purpose

`resolver-deno/kinopub-main.js` is a small private control-plane service:

```text
authorized browser / TV
  -> Deno resolver JSON request
  -> KinoPub API with a dedicated OAuth device
  -> signed HLS4 URL (24-hour TTL)
  -> browser / TV loads manifest and media directly from CDN
```

The resolver does not fetch or relay manifests, MP4 files, HLS playlists, or
segments during normal playback.

Deploy this entrypoint as a **separate Deno app**. Do not replace the existing
`resolver-deno/main.js` production entrypoint.

## Why Deno KV is required

KinoPub rotates both access and refresh tokens. After a successful refresh the
previous access token returns `401` and the previous refresh token returns
`invalid_refresh_token`. A static refresh token stored only in an environment
variable therefore works once.

The resolver stores the current token pair in Deno KV. An atomic short lease
ensures that only one isolate refreshes the pair when concurrent requests see an
expired access token. Environment variables are used only to seed an empty
database.

`GET /health` exposes `persistentTokenStore`. It must be `true` before treating
the deployment as durable.

## Required configuration

Create a dedicated OAuth device instead of reusing Kodi's refresh token. Set
that device's capabilities to 4K, HEVC, HDR, and HLS4 before seeding the app.

Required Deno secrets:

```text
KINOPUB_ACCESS_TOKEN
KINOPUB_REFRESH_TOKEN
KINOPUB_CLIENT_ID
KINOPUB_CLIENT_SECRET
KINOPUB_RESOLVER_KEY
```

Required plain values:

```text
KINOPUB_ACCESS_EXPIRES_AT=<absolute Unix timestamp>
KINOPUB_ALLOWED_ORIGINS=https://alphy.tv,https://www.alphy.tv
```

Optional overrides:

```text
KINOPUB_API_BASE=https://api.srvkp.com/v1
KINOPUB_OAUTH_URL=https://api.srvkp.com/oauth2/token
```

Never commit any of these values. The checked-in code contains no user access
token, refresh token, account password, or resolver bearer key.

## API

Health is public but contains no credentials:

```http
GET /health
```

Search the catalog:

```http
GET /v1/kinopub/search?q=Avatar&type=movie&page=1
Authorization: Bearer <KINOPUB_RESOLVER_KEY>
```

`type` defaults to `all`. Supported exact KinoPub types are `movie`, `serial`,
`docuserial`, `tvshow`, `concert`, `3d`, and `documovie`. Search results contain
only card metadata such as id, title, type, year, quality, artwork, genres,
countries, and ratings. Upstream media URLs and other unneeded fields are not
returned. KinoPub's catalog does not accept `quality=2160` as a useful search
filter; use the returned numeric `quality` field for a client-side 4K filter.

Resolve a movie:

```http
GET /v1/kinopub/resolve?item=121792&quality=2160p&stream=hls4
Authorization: Bearer <KINOPUB_RESOLVER_KEY>
```

Resolve a series episode:

```http
GET /v1/kinopub/resolve?item=8738&season=1&episode=1&quality=best&stream=hls4
Authorization: Bearer <KINOPUB_RESOLVER_KEY>
```

Successful responses contain metadata, signed issuance/expiry times, and
`manifestUrl`. Responses are always `private, no-store`.

If the account is authenticated but does not have playback entitlement, the API
returns a `media=-1` demo capability. The resolver rejects it with HTTP `402`
and `subscription_inactive`; it never labels the 1080p demo as the requested
movie or as 4K.

## Client integration

The frontend calls the JSON endpoint with its resolver bearer key, then passes
`manifestUrl` directly to hls.js, Shaka, AVPlayer, ExoPlayer, Kodi, or the Smart
TV player. The media request contains no Deno authorization header because it
goes directly to the CDN.

Do not put `KINOPUB_RESOLVER_KEY` in a public repository or public catalog JSON.
For a personal web client, store it during a one-time setup in local storage or
an HttpOnly first-party session.

## Cross-egress acceptance test

1. Call `/v1/kinopub/resolve` from the viewer network.
2. Confirm that the decoded signed URL contains the Deno egress IP, not the
   viewer IP.
3. From the viewer device, request the returned master with no cookies, Referer,
   or bearer header.
4. Request one child playlist and a 4 KiB range of the first media segment.
5. Require statuses `200`, `200`, and `206` respectively.

This verifies that Deno only resolves control-plane data and that the viewer's
different IP can consume the CDN capability directly.

## Local checks

```bash
deno check resolver-deno/kinopub-main.js
node --test tests/kinopub-resolver.test.js
npm test
```
