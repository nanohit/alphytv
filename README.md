# AlphyTV MVP

Lightweight static MVP for the current playback flow:

1. Search or paste a Newdeaf page URL.
2. Use Newdeaf -> Ortified Cleanroom when the page exposes `api.ortified.ws`.
3. Use Newdeaf -> Gencit/Opravar -> Werberk HLS when that is the only player.
4. Otherwise fall back to Zona -> Zenith.
5. Use the static SOAP movie catalog (`/m/:id`) for direct HLS movie playback
   when a fresh `soap-movies.json` is shipped.
6. Play Opravar and Zenith streams in Shaka; play SOAP movies in hls.js.
7. Serve admin-curated homepage lists as one public JSON snapshot from Vercel
   Blob CDN.

The Vercel app remains static. The included Cloudflare Worker only resolves
metadata and IDs; it does not proxy video bytes.

## Deploy Shape

- `index.html`, `styles.css`, `app.js`, `catalog.js` - Vercel static frontend.
- `api/admin/*` - admin-only authentication and catalog writes.
- `curated-config.json` - public Blob URL; visitors read the snapshot directly
  from Blob CDN and do not invoke a Function or Deno.
- `soap-movies.json` - static SOAP movie catalog. Its HLS master URLs expire;
  run `npm run check:soap` before relying on the shipped catalog.
- `worker/` - resolver source for PoiskKino, `kpId -> Zenith`, and Opravar
  control-plane resolution.

## SOAP Movie Catalog

SOAP movie playback is still client-side: visitors fetch `soap-movies.json`, then
their browser plays the HLS master directly from SOAP's CDN with hls.js. No video
bytes or SOAP credentials pass through Alphy.

Because SOAP CDN behavior can differ by IP and HTTP context, refreshed runs also
execute `npm run probe:soap`. The probe checks master playlist, variant playlist,
and first media segment with bare, `alphy.tv`, and `soap4youand.me` headers, but
prints only statuses and metadata, never signed URLs.

The HLS masters expire, so `.github/workflows/soap-catalog.yml` keeps the catalog
fresh conservatively:

- every 2 hours it runs a canary against already-published masters, without SOAP
  credentials;
- authenticated scheduled refresh is disabled unless the repository variable
  `SOAP_AUTO_REFRESH` is set to `true`; manual `force_refresh=true` runs still
  work. This keeps the paid account from being touched by a broken/stale canary;
- when enabled, if the canary is stale and the catalog is at least
  `SOAP_MIN_REFRESH_HOURS` old (default 12h), it logs in from GitHub Actions
  using repository secrets and refreshes the catalog;
- refresh order is `>1080p` movies first (the 4K shelf, including 1440p/1600p
  style masters), then the rest of the movie catalog;
- the workflow commits only `soap-movies.json`; it does not upload cookies,
  HTML dumps, passwords, account tokens, or raw scraper artifacts.

Required repository secrets for authenticated refresh:

```text
SOAP_LOGIN
SOAP_PASSWORD
```

Optional repository variable:

```text
SOAP_AUTO_REFRESH=true
```

Useful manual runs:

```bash
npm run check:soap              # small priority-first canary
npm run check:soap:priority     # all >1080p masters
npm run check:soap:all          # every stored master
npm run probe:soap              # master -> variant -> segment delivery probe
```

For a GitHub Actions smoke test, run the `SOAP catalog canary and refresh`
workflow manually with `force_refresh=true`, `scope=priority`, and a small
`limit` such as `5`. For production refresh, leave `limit` empty and use
`scope=full`.

## Frontend

Vercel auto-deploys this repo to:

```text
https://alphytv.vercel.app
```

After the Worker is deployed, open:

```text
https://alphytv.vercel.app/?resolver=https://alphy-resolver.<account>.workers.dev
```

The page saves the Worker URL in `localStorage`. You can also click `Worker` and
paste/change it manually.

## Worker Setup

```bash
cd worker
npm install
npx wrangler login
npx wrangler secret put POISKKINO_TOKEN
npm run deploy
```

Paste the PoiskKino key when Wrangler asks. The key is intentionally not
committed.

Current Worker vars live in `worker/wrangler.toml`:

```toml
ALLOWED_ORIGIN = "https://alphytv.vercel.app,http://127.0.0.1:5177,http://localhost:5177"
POISKKINO_BASE_URL = "https://api.poiskkino.dev"
```

If the Vercel domain changes, update `ALLOWED_ORIGIN` and redeploy the Worker.

## Curated Lists

The production project uses a public Vercel Blob store named `alphy-curated`.
Only the admin endpoints use Functions; public homepage traffic fetches the
stable `catalog/curated.json` Blob URL directly.

Required Vercel environment variables:

```text
BLOB_READ_WRITE_TOKEN
ALPHY_ADMIN_USER
ALPHY_ADMIN_PASSWORD
```

Credentials are sent only to same-origin `/api/admin/*` over HTTPS and are kept
in `sessionStorage`, never in the frontend bundle or URL. Catalog saves use a
revision guard, a local unsaved-draft backup, and a 1.2-second debounce.

See [docs/CURATED_ADMIN.md](docs/CURATED_ADMIN.md) for the data model and
operational details.

## Local Smoke Test

Terminal 1:

```bash
cd worker
npm install
printf 'POISKKINO_TOKEN=<your key>\n' > .dev.vars
npm run dev -- --ip 127.0.0.1 --port 8787
```

Terminal 2:

```bash
python3 -m http.server 5177
```

Open:

```text
http://127.0.0.1:5177/?resolver=http://127.0.0.1:8787
```

From a Russian IP, search a title or paste a Newdeaf URL.

## Expected Behavior

- Newdeaf search: tries direct CORS fetch, XHR, then a sandbox fallback with
  deadlines and staggered daily-mirror probes. Only successful non-empty
  results are cached; transient empty responses are never pinned.
- Ortified path: fetches provider HTML from the browser with a null-origin
  sandbox, strips the known ad config, and loads a `srcdoc` player.
- Opravar path: resolver reads player/API metadata, changes the signed HLS host
  to Opravar's CORS-open `f*.werberk.pro` reserve, then the browser loads HLS
  and VTT directly in Shaka. The resolver never proxies video bytes.
- Allo-only Newdeaf path: does not embed Allo by default; it uses the title to
  resolve PoiskKino `kpId`, then Zona/Zenith.
- Zona path: Worker resolves `kpId -> api.zenithjs.ws/embed/movie/<id>`. The
  Zenith embed contains the authoritative season/episode playlist and a
  separate signed DASH/HLS source for every episode. Shaka shows those seasons
  and episodes next to audio/quality controls, loads the selected episode
  directly, and restores the saved selection on reopen.
- Non-Ortified Newdeaf serial pages preserve their explicit season/episode
  through both Gencit/Opravar and Allo-to-Zona fallback paths, so Shaka opens
  the selected season instead of an arbitrary provider `playlist.current`.
- Newdeaf search cards are matched client-side to the closest PoiskKino result
  after season/promo noise is removed. Matching cards inherit ratings, poster,
  duration, year, and series/movie type without another API request.
- Curated cards cache metadata and a resolved direct playback target. A click
  therefore skips Newdeaf search/page parsing; Zenith items also skip the Zona
  `kpId` mapping.
- The newest Continue card is a wide 16:9 card. Shaka captures a small local
  JPEG frame after playback starts; the Ortified cleanroom attempts the same
  capture and falls back to the poster if canvas security blocks it.
- Diagnostics are hidden by default. Click `Диагностика` to copy logs.

## Known Limits

- A privacy browser can block `*.newdeaf.co` before CORS is evaluated. The
  browser-only client cannot read a body that the browser itself suppresses;
  it falls back to catalogue results and displays a Newdeaf availability note.
- `api.zenithjs.ws` may return `422` outside the working region/origin context.
  The production test must be done from the Russian browser path where Zenith
  was previously confirmed.
- Zona/Zenith currently has no usable built-in subtitles in our captures. Shaka
  exposes a client-only `запросить` subtitles action that searches Wyzie Subs by
  IMDb/TMDB ID, downloads the subtitle text in the browser, converts SRT to VTT,
  and injects it into Shaka. If the resolver metadata has only a Kinopoisk ID,
  the client asks Wikidata for IMDb/TMDB IDs before hitting Wyzie. With the
  current free Wyzie keys only `charlie` and `lima` sources are available; if
  Wyzie returns empty/CORS-blocked download files, the button stays retryable and
  reports the failure without breaking playback.
- Zenith does not accept `?season=&episode=` navigation. Episode switching must
  use the per-episode sources embedded in its playlist; selecting the first
  media URL in the document can play the wrong episode.
- The Deno resolver caches successful Zenith playlist metadata for one hour and
  can serve it stale for up to 24 hours when Zenith temporarily returns `422`.
  Media manifests and segments are still loaded directly by the browser.
- Allo remains black-box: baseline iframe can play but may force audible ads;
  cleanroom/rehost fails because Allo API calls are origin/CORS gated.
- Opravar signed media URLs are short-lived. Episode/voice changes therefore
  call `/resolve-opravar` again to mint a fresh URL.
