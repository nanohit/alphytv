# AlphyTV MVP

Lightweight static MVP for the current playback flow:

1. Search or paste a Newdeaf page URL.
2. Use Newdeaf -> Ortified Cleanroom when the page exposes `api.ortified.ws`.
3. Use Newdeaf -> Gencit/Opravar -> Werberk HLS when that is the only player.
4. Otherwise fall back to Zona -> Zenith.
5. Play Opravar and Zenith streams in a local Shaka player.

The Vercel app remains static. The included Cloudflare Worker only resolves
metadata and IDs; it does not proxy video bytes.

## Deploy Shape

- `index.html`, `styles.css`, `app.js` - Vercel static frontend.
- `worker/` - resolver source for PoiskKino, `kpId -> Zenith`, and Opravar
  control-plane resolution.
- No legacy SOAP frontend code is included here.

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

- Ortified path: fetches provider HTML from the browser with a null-origin
  sandbox, strips the known ad config, and loads a `srcdoc` player.
- Opravar path: resolver reads player/API metadata, changes the signed HLS host
  to Opravar's CORS-open `f*.werberk.pro` reserve, then the browser loads HLS
  and VTT directly in Shaka. The resolver never proxies video bytes.
- Allo-only Newdeaf path: does not embed Allo by default; it uses the title to
  resolve PoiskKino `kpId`, then Zona/Zenith.
- Zona path: Worker resolves `kpId -> api.zenithjs.ws/embed/movie/<id>`, then
  the browser fetches the Zenith embed and plays DASH/HLS directly.
- Diagnostics are hidden by default. Click `Диагностика` to copy logs.

## Known Limits

- `api.zenithjs.ws` may return `422` outside the working region/origin context.
  The production test must be done from the Russian browser path where Zenith
  was previously confirmed.
- Zona currently has no usable built-in subtitles in our captures.
- Allo remains black-box: baseline iframe can play but may force audible ads;
  cleanroom/rehost fails because Allo API calls are origin/CORS gated.
- Opravar signed media URLs are short-lived. Episode/voice changes therefore
  call `/resolve-opravar` again to mint a fresh URL.
