# AlphyTV Domain Probe

Temporary Vercel probe for the `api.ortified.ws` / `cdnr.interkh.com` playback path.

This repo intentionally contains only:

- `index.html` - browser test UI;
- `config.generated.json` - signed URLs from a Russian-IP mint;
- `vercel.json` - static deploy config;
- `package.json` - optional Vercel CLI helper.

## Important

`config.generated.json` contains signed media URLs from the latest RU capture.
They expire at:

```text
2026-06-22T23:52:55.000Z
```

After that, regenerate the config from a fresh RU capture before testing again.

## Deploy

Connect this GitHub repo to Vercel, or run:

```bash
npm install
npm run deploy
```

Use the production URL from a Russian IP.

## Test Sequence

On the deployed page:

1. Click `Iframe`.
2. Wait 60-90 seconds.
3. Click `Clean` if no ad appears, or `Ad` if an ad appears.
4. Click `CORS`.
5. Click `DASH`.
6. Click `Copy Report`.
7. Paste the copied report into the Codex thread.

## Result Meaning

Best result:

- iframe is clean on Vercel;
- CORS returns `200`;
- direct DASH plays.

Still workable:

- iframe has ads, but direct DASH plays cleanly.

Bad:

- CORS fails on Vercel;
- direct DASH fails even though localhost works.
