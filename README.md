# AlphyTV Domain Probe

Temporary Vercel probe for the `api.ortified.ws` / `cdnr.interkh.com` playback path.

Latest result:

- iframe playback works from Russian IP;
- the iframe wrapper is the promising MVP path;
- CORS to `cdnr.interkh.com` returns `200` from the Vercel origin;
- direct Shaka/DASH loads the manifest but segment requests return `410`.
- desktop incognito later showed the same visible ad across every black-box
  iframe privacy variant, so iframe wrapping alone is not guaranteed ad-free.

Current experiment:

- `Cleanroom` fetches the Ortified embed HTML from the viewer's browser, removes
  the Ortified ad config before the player initializes, then loads the sanitized
  player into a `srcdoc` iframe.
- `Cleanroom + block ads` does the same thing and also injects a small diagnostic
  blocker for known ad hosts seen in the captures.

These modes must be tested from a Russian IP because the embed HTML fetch still
depends on the same RU-only Ortified gate.

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

On the deployed page from a Russian IP:

1. Pick `Cleanroom`.
2. Click `Iframe`.
3. If the player loads, start/switch an episode and wait 90-120 seconds.
4. Click `Clean` if no ad appears, or `Ad` if an ad appears.
5. Click `Copy Report`.
6. Paste the copied report into the Codex thread.
7. Repeat the same test with `Cleanroom + block ads`.

Only retest these older modes as controls if needed:

1. `Baseline`
2. `No referrer`
3. `Credentialless`
4. `Sandbox`
5. `Sandbox + no referrer`
6. `Sandbox + credentialless`

If a mode breaks playback, note that and move to the next one.

## Result Meaning

Best result:

- `Cleanroom` or `Cleanroom + block ads` is clean on Vercel;
- CORS returns `200`;
- video plays.

Still workable:

- black-box iframe has ads, but cleanroom removes them.

Bad:

- cleanroom fetch returns `422` or does not contain `makePlayer`;
- cleanroom loads but the provider player no longer plays video;
- CORS fails on Vercel;
- direct DASH fails even though localhost works.

Important cleanroom report fields:

- `cleanroom.ok` - whether the browser fetched and sanitized Ortified HTML.
- `cleanroom.adScriptBlocks` - should usually be at least `1`.
- `cleanroom.adsConfigRefs` - should usually be at least `1`.
- `cleanroom.makePlayerRefs` - should usually be at least `1`.
- `cleanroom.preludeInjected` - true only for `Cleanroom + block ads`.

Expected current DASH behavior:

```text
manifest: 200
segments: 410
```

That means the provider iframe/player is doing extra segment signing or renewal
that a plain Shaka player does not reproduce.
