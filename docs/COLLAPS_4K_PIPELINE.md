# Collaps 4K metadata pipeline

Local, resumable discovery of Collaps titles that expose a progressive rendition above 1080p.
The pipeline reads metadata only. It never downloads video bytes and never stores signed OK CDN URLs.

## Safety boundary

The default command is offline:

```bash
npm run collaps4k:plan
```

`plan`, `status`, and `export` do not access Kinopoisk or Collaps. A network run requires both the
`run` command and the exact confirmation phrase:

```bash
npm run collaps4k:run -- --confirm COLLAPS_4K_SCAN
```

Without the phrase, the process exits before creating a lock or making a request. Requests are strictly
sequential with randomized `300-700ms` spacing. There is no concurrency switch.

For a smaller first wave, `--limit` is applied before both KP mapping and Collaps probing:

```bash
npm run collaps4k:run -- --confirm COLLAPS_4K_SCAN --limit 10
```

The next run without `--limit` resumes those ten and continues through the remaining candidates.

## Candidate sources

Default sources:

- `soap4k`: every local `soap-movies.json` movie whose stored ladder is above 1080p. This is the
  high-signal first pass (currently 87 titles). Legacy SOAP years are deliberately ignored because old
  dumps could mistake a number in a title, such as `Blade Runner 2049`, for its release year.
- `curated`: existing catalog items that already carry a Kinopoisk id.

Additional candidates can be supplied as JSON:

```bash
npm run collaps4k:plan -- --input /absolute/path/candidates.json
```

Shape:

```json
{
  "candidates": [
    {
      "id": "local-1",
      "title": "Example",
      "year": 2024,
      "isSeries": false,
      "kpId": "123456",
      "source": "manual",
      "priority": 50
    }
  ]
}
```

`kpId` is optional. Automatic title matching is exact across Russian, English, and original names. It
never accepts a fuzzy/partial result. Multiple exact remakes go to `collaps-4k-review.json`.

## Kinopoisk keys

The default mapper uses Kinopoisk Unofficial and reads keys only from the process environment:

```bash
export KINOPOISK_UNOFFICIAL_TOKENS='key-one,key-two,key-three'
```

The singular `KINOPOISK_UNOFFICIAL_TOKEN` also works. Keys rotate on `401/402/403/429`; their values
are never written to state, events, or output. PoiskKino is available only when selected explicitly:

```bash
export POISKKINO_TOKENS='key-one,key-two'
npm run collaps4k:plan -- --provider poiskkino
```

Use a manual map to resolve ambiguous titles without another API request. The versioned SOAP aliases live
in `scripts/collaps-4k-manual-map.json`; override them for another input set with `--manual-map`.

```json
{
  "soap:202": {
    "kpId": "1234567",
    "title": "Ballerina",
    "year": 2025,
    "isSeries": false
  }
}
```

## Probe strategy

For every mapped KP id:

1. Fetch `playlist?pub=1&aggr=kp&id=...`.
2. Fetch `video/{vkId}` metadata sequentially.
3. Stop immediately after a non-empty `mpeg2kUrl`, `mpeg4kUrl`, or `mpegQhdUrl` is found.
4. Discard every returned URL; persist only the quality field and non-secret evidence.

CDNVideoHub's names do not describe their real ordering: `mpeg2kUrl`/type 7 is the 3840-wide
rendition, while `mpeg4kUrl`/type 6 is 2560-wide. This mapping is covered by tests and the player uses
the same order. The pipeline's broad high-resolution bucket still intentionally includes both 4K and
2K/1440-class files; only evidence labelled `4K` is strict UHD-width.

Films inspect up to 12 unique `vkId` values by default. If the cap is reached without a hit, the result
is `sampled_no_high_res`, not a false confirmed negative. Increase with `--max-film-videos`.

Series default to `staged`: first/middle/last episode of each season, up to two voices per sampled
episode and 48 `vkId` values per title. A miss is partial. `--series-mode full` is the exhaustive mode;
`--series-mode skip` excludes series. Positive hits are always confirmed regardless of sampling mode.

For broad catalog discovery, `--series-mode quick` samples globally spaced first/middle/last seasons
instead of every season. Combine it with one episode and one voice per season to keep the first pass bounded:

```bash
npm run collaps4k:run -- --confirm COLLAPS_4K_SCAN \
  --sources "" --input var/collaps-4k-discovery/candidates.json \
  --out-dir var/collaps-4k-popular --provider none \
  --max-film-videos 2 --series-mode quick --series-season-samples 3 \
  --series-samples 1 --voices-per-episode 1 --max-series-videos 3
```

The candidate file itself is built in 20-title API batches and includes dedicated movie and series collections:

```bash
npm run collaps4k:discover:run -- --confirm COLLAPS_KP_DISCOVERY
```

The default discovery set is `TOP_POPULAR_ALL`, `TOP_POPULAR_MOVIES`, `TOP_250_MOVIES`,
`TOP_250_TV_SHOWS`, and `POPULAR_SERIES`. It is a broad popular-catalog pass, not a claim that every
Kinopoisk title has been enumerated. Overlapping collections are deduplicated by KP id before Collaps probing.

## Resilience and monitoring

- Atomic `state.json` checkpoint after every mapping, playlist, and video result.
- Re-running the same command skips completed mappings and scans.
- `SIGINT`/`SIGTERM` abort the active request and preserve the checkpoint.
- `.lock` prevents concurrent runs.
- Access-policy changes (`401/403` from Collaps), five consecutive failures, or the request budget stop
  the run without discarding progress.
- Default request budget: 1500. Override with `--max-requests`.
- `events.jsonl` and stderr show progress without keys or signed URLs.

Status during or after a run:

```bash
npm run collaps4k:status
```

Generated under ignored `var/collaps-4k*/` directories:

- `collaps-4k-titles.txt`: plain title names.
- `collaps-4k-details.tsv`: title, year, type, quality, KP id.
- `collaps-4k.json`: confirmed positives with quality evidence.
- `collaps-4k-review.json`: ambiguous mappings and partial series/film misses.
- `summary.json`: counts and per-host request totals.
- `state.json`: resumable checkpoint, without media URLs or API keys.

`summary.json` separates the broad `confirmedHighRes` total from strict `confirmed4K` and
`confirmed2K` counts. A strict 4K positive means the current video metadata exposes type 7; occasional
`ffprobe` spot checks are still useful because the provider does not publish dimensions in its JSON.

Merge any number of completed scan exports without network access:

```bash
npm run collaps4k:merge
```

By default this combines `var/collaps-4k/collaps-4k.json` and
`var/collaps-4k-popular/collaps-4k.json` into `var/collaps-4k-all/`. The merger allows only sanitized
quality evidence, deduplicates by KP id, and reports movie/series totals. Override inputs with
`--input first.json,second.json` and the destination with `--out-dir`.

## Recommended first run

Keep the default high-signal inputs and staged series mode:

```bash
npm run collaps4k:plan
npm run collaps4k:run -- --confirm COLLAPS_4K_SCAN
```

Do not add `--refresh` when resuming: ordinary runs skip every terminal result without a request.
`--refresh` deliberately reloads playlists and revalidates selected video metadata while retaining the
checkpoint structure. `--force-unlock` should only be used after confirming that no scanner process is running.
