# AlphyTV Domain Probe

Temporary Vercel probe for the `api.ortified.ws` / `cdnr.interkh.com` playback path.

Latest result:

- iframe playback works from Russian IP;
- the plain iframe wrapper proves the low-bandwidth path but not the ad-free
  path;
- CORS to `cdnr.interkh.com` returns `200` from the Vercel origin;
- direct Shaka/DASH loads the manifest but segment requests return `410`.
- desktop incognito later showed the same visible ad across every black-box
  iframe privacy variant, so iframe wrapping alone is not guaranteed ad-free.
- `Cleanroom` and `Cleanroom + block ads` fetched the RU-only Ortified HTML,
  removed one visible ad config block, preserved `makePlayer(...)`, and played
  without the visible ad in the reported run.

Current experiment:

- `Cleanroom` fetches the Ortified embed HTML from the viewer's browser, removes
  the Ortified ad config before the player initializes, then loads the sanitized
  player into a `srcdoc` iframe.
- `Cleanroom + block ads` does the same thing and also injects a small diagnostic
  blocker for known ad hosts seen in the captures.

These modes must be tested from a Russian IP because the embed HTML fetch still
depends on the same RU-only Ortified gate.

Extra live seed target:

- `Rick and Morty S1` uses
  `https://api.ortified.ws/embed/movie/301?season=1&episode=1&episode=1`.
- Open `https://alphytv.vercel.app/?preset=rick-morty-s1` from a Russian IP,
  choose `Cleanroom`, then click `Iframe`.
- Or use `?embed=<api.ortified.ws embed URL>` for any static Newdeaf Ortified
  seed discovered by the scanner.

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

1. Pick a target: `Captured config`, `Rick and Morty S1`, or a custom `embed`
   query URL.
2. Pick `Cleanroom`.
3. Click `Iframe`.
4. If the player loads, start/switch an episode and wait 90-120 seconds.
5. Click `No Ad Seen` if no ad appears, or `Ad Seen` if an ad appears.
6. Click `Copy Report`.
7. Paste the copied report into the Codex thread.
8. Repeat the same test with `Cleanroom + block ads` only if plain
   `Cleanroom` fails or shows ads.

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
- `cleanroom.adScriptBlocks` is at least `1`;
- `cleanroom.adsConfigRefs` is at least `1`;
- `cleanroom.makePlayerRefs` is at least `1`;
- video plays.

Still workable:

- black-box iframe has ads, but cleanroom removes them. This is the current
  result to beat.

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
