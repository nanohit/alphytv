# AlphyTV Domain Probe

Temporary Vercel probe for the `api.ortified.ws` / `cdnr.interkh.com` playback path.

Latest result:

- iframe playback works from Russian IP;
- the iframe wrapper is the promising MVP path;
- CORS to `cdnr.interkh.com` returns `200` from the Vercel origin;
- direct Shaka/DASH loads the manifest but segment requests return `410`.
- one rare iframe ad was observed in desktop incognito, so the wrapper is lower-ad,
  not guaranteed ad-free.

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

1. Pick an iframe mode.
2. Click `Iframe`.
3. Wait 60-90 seconds.
4. Click `Clean` if no ad appears, or `Ad` if an ad appears.
5. Click `CORS`.
6. Click `Copy Report`.
7. Paste the copied report into the Codex thread.

Recommended iframe mode order:

1. `Baseline`
2. `No referrer`
3. `Credentialless`
4. `Sandbox`
5. `Sandbox + no referrer`
6. `Sandbox + credentialless`

If a mode breaks playback, note that and move to the next one.

## Result Meaning

Best result:

- iframe is clean on Vercel;
- CORS returns `200`;
- iframe video plays.

Still workable:

- iframe has ads, but CORS returns `200`.

Bad:

- CORS fails on Vercel;
- direct DASH fails even though localhost works.

Expected current DASH behavior:

```text
manifest: 200
segments: 410
```

That means the provider iframe/player is doing extra segment signing or renewal
that a plain Shaka player does not reproduce.
