# AlphyTV MVP Architecture

## Goal

Keep the user-visible flow simple while avoiding a bandwidth backend:

```text
input title/Newdeaf URL
  -> Newdeaf page probe
  -> Ortified Cleanroom if available
  -> Gencit/Opravar custom player if available
  -> Zona/Zenith fallback otherwise
  -> browser-side playback
```

## Source Decisions

### Newdeaf

Newdeaf search/page HTML is fetched by the viewer browser so the request keeps
the viewer's network location. The transport order is:

1. direct CORS `fetch`;
2. direct CORS `XMLHttpRequest` for browsers that patch or stall `fetch`;
3. an opaque-origin sandbox helper as the final browser-only fallback.

Every transport has a deadline. Daily mirror probes are staggered, so a privacy
browser that leaves a blocked third-party request pending cannot stall Newdeaf
search indefinitely.

Daily mirror candidates are generated around the current date:

- today, e.g. `14jun.newdeaf.co`;
- yesterday;
- tomorrow.

This handles the Newdeaf mirror rollover window around late night Moscow time.

Only non-empty successful search results are cached. Empty responses are not
persisted because a real zero-result page and a response swallowed by a browser
privacy layer cannot be distinguished reliably after the fact. The frontend
asset URL is versioned so browsers with persistent caches cannot retain the old
sandbox-only search implementation.

Hard limitation: if a browser blocks every request to `*.newdeaf.co` before the
CORS layer, a browser-only client cannot read the response. In that case Alphy
finishes the search with the normal catalogue results and shows a small Newdeaf
availability note instead of silently omitting it or hanging.

### Ortified

Ortified is preferred when a Newdeaf page exposes:

```text
https://api.ortified.ws/embed/...
```

The working mode is Cleanroom:

- fetch the Ortified embed HTML in the viewer browser;
- replace the known `<script data-name="ad">` block with an empty config;
- replace `ads: adsConfig` with `ads: {}`;
- inject a small blocker for observed ad/tracker hosts;
- load the sanitized HTML into `iframe.srcdoc`.

This preserves the provider player logic without loading its visible ad config.

### Allo

Allo is not used as the default playback route.

Findings:

- baseline `allo.cdnlbox.club` iframe can play from a Russian IP;
- it can force visible/audible ads;
- parent page JS cannot mute, inspect, or control the cross-origin iframe;
- rehost/cleanroom fails because internal Allo API calls such as `/bnsi/movies`
  and `/events` are CORS/origin gated.

Therefore Allo is only treated as a signal to invoke Zona fallback.

### Gencit / Opravar

Newdeaf can expose a `gencit.info/bil/<id>` iframe, which redirects to
`opravar.online`. The provider HTML includes:

- the current signed HLS URL;
- `data-spare="https://f*.werberk.pro"`;
- Russian/English VTT URLs;
- a full season/episode/voice playlist;
- a `video_id` for each selectable item.

The primary `cdn*.opravar.online` host is not usable from Alphy because its CORS
header is pinned to `https://opravar.online`. Opravar's own reserve
`f*.werberk.pro` accepts the same signed path, regenerates nested URLs on
Werberk, and returns wildcard CORS for master playlists, variants, and TS
segments.

The resolver endpoint:

```text
GET /resolve-opravar?url=<player>&pageUrl=<newdeaf>
GET /resolve-opravar?url=<player>&videoId=<id>
```

does control-plane work only:

- validates the player URL against fixed Gencit/Opravar hosts;
- fetches player HTML or `player/responce.php`;
- parses navigation metadata and subtitles;
- rewrites only the signed media hostname to the validated Werberk reserve.

The browser then loads HLS and VTT directly in Shaka. Because the provider
player bundle is never executed, its `adsConfig`/VAST preroll code is never
initialized.

### Zona / Zenith

Zona pages are not directly usable from the frontend:

- `w1.zona.im` search/page fetch is CORS blocked;
- page iframe is blocked by `X-Frame-Options: sameorigin`.

The useful primitive is Zona's internal `kpId -> Zenith` mapping. The Worker
loads the extracted Zona stream runtime and calls it in a Worker-compatible
shim, returning:

```json
{
  "kpId": "1382256",
  "zenithId": "87181",
  "embedUrl": "https://api.zenithjs.ws/embed/movie/87181"
}
```

Then the browser fetches the Zenith embed and extracts:

- `dash`;
- `dasha`;
- `hls`;
- audio labels.
- `playlist.current`;
- every season/episode and its own signed DASH/HLS sources.

The playlist is authoritative. Zenith serial embeds contain many media URLs,
and the first URL in the HTML is not necessarily the current episode. The
resolver and browser parser therefore match `playlist.current` (or the saved
user selection) to a concrete episode before loading Shaka. Season/episode
buttons switch directly to that episode's source and persist the selection.
If a signed source expires during switching, the client refreshes the Zenith
embed through the resolver and retries the same selection.

The Deno wrapper keeps successful parsed Zenith responses fresh for one hour
and stale-usable for up to 24 hours. This absorbs provider `422` bursts without
proxying media; Shaka still requests manifests and segments from the media CDN.

Shaka Player handles DASH/HLS and exposes season, episode, quality, and audio
switching.

## Backend Scope

The Worker is intentionally narrow:

- PoiskKino title search;
- PoiskKino movie lookup;
- Zona `kpId -> Zenith` ID resolution;
- Zenith metadata/serial-playlist fallback.
- Gencit/Opravar player/API metadata resolution and media-host substitution.

It does not proxy video segments, manifests, MP4, M4S, TS, or images.

## Legacy Integration Window

The static MVP exports a small conceptual contract for later legacy frontend
integration:

- input: title, Newdeaf URL, Ortified URL, Zenith URL, or `kpId`;
- output: provider decision, playback iframe/video element, diagnostics report;
- config: resolver Worker URL.

SOAP/HDRezka code is intentionally not included in this repo.
