# Alphy Resolver Worker

Tiny Cloudflare Worker for metadata and ID resolution only. It does not proxy
video bytes.

Endpoints:

- `GET /health` -> basic service check.
- `GET /search?q=Project%20Hail%20Mary` -> PoiskKino search normalized to
  `kpId`.
- `GET /movie?id=1382256` -> PoiskKino movie details.
- `GET /resolve-zona?kpId=1382256` -> pure-JS Zona protocol resolve from
  Kinopoisk ID to `https://api.zenithjs.ws/embed/movie/<id>`.
- `GET /zenith?id=2097` -> Zenith sources plus the normalized serial playlist
  (`current`, seasons, episodes, and per-episode DASH/HLS URLs).

## Local setup

```bash
cd /Users/pavel/Desktop/sunocturne/resolver-worker
npm install
npx wrangler secret put POISKKINO_TOKEN
npm run dev
```

For local tests, paste the token when Wrangler asks.

## Test

```bash
curl 'http://127.0.0.1:8787/search?q=Project%20Hail%20Mary&limit=3'
curl 'http://127.0.0.1:8787/movie?id=1382256'
curl 'http://127.0.0.1:8787/resolve-zona?kpId=1382256'
curl 'http://127.0.0.1:8787/zenith?id=2097'
```

## Deploy

```bash
cd /Users/pavel/Desktop/sunocturne/resolver-worker
npx wrangler login
npx wrangler secret put POISKKINO_TOKEN
npm run deploy
```

Use the deployed Worker URL in the frontend settings panel, or open:

```text
https://alphytv.vercel.app/?resolver=https://alphy-resolver.<account>.workers.dev
```

That saves the Worker URL in browser localStorage.
