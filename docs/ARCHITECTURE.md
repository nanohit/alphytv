# AlphyTV MVP Architecture

## Goal

Keep the user-visible flow simple while avoiding a bandwidth backend:

```text
input title/Newdeaf URL
  -> Newdeaf page probe
  -> Ortified Cleanroom if available
  -> Zona/Zenith fallback if Newdeaf only exposes Allo
  -> browser-side playback
```

## Source Decisions

### Newdeaf

The frontend fetches Newdeaf search/page HTML from a sandboxed iframe without
`allow-same-origin`. That produces a browser `Origin: null` request instead of
`Origin: https://alphytv.vercel.app`.

Daily mirror candidates are generated around the current date:

- today, e.g. `14jun.newdeaf.co`;
- yesterday;
- tomorrow.

This handles the Newdeaf mirror rollover window around late night Moscow time.

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

Shaka Player handles DASH/HLS and exposes quality/audio switching.

## Backend Scope

The Worker is intentionally narrow:

- PoiskKino title search;
- PoiskKino movie lookup;
- Zona `kpId -> Zenith` ID resolution;
- optional Zenith metadata fallback.

It does not proxy video segments, manifests, MP4, M4S, TS, or images.

## Legacy Integration Window

The static MVP exports a small conceptual contract for later legacy frontend
integration:

- input: title, Newdeaf URL, Ortified URL, Zenith URL, or `kpId`;
- output: provider decision, playback iframe/video element, diagnostics report;
- config: resolver Worker URL.

SOAP/HDRezka code is intentionally not included in this repo.
