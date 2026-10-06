# Bad Apple · Mosaic studio

A browser port of [bad-apple-ify](https://github.com/j-ameswong/bad-apple-ify).
Rebuild a video from gallery tiles, preview it, and download the mosaic or a
side-by-side video with the source audio. The app reads selected files locally;
media processing runs in a worker. It has no upload endpoint or account system.

## Use

1. Select a source video and one or more gallery files. Galleries can contain
   video clips, still images, or extracted CIFAR Python batches such as `train`.
2. Choose geometry and matching settings. Start with a short source slice.
3. Use **Estimate size** to check dimensions, tile memory and available codecs,
   then **Make mosaic**. Both download buttons appear when encoding finishes.
4. To pause a longer job, cancel after a segment completes and **Save checkpoint**.
   In a new tab, load that ZIP, reselect the same source and gallery, and resume.
   Only completed segments are kept; an interrupted segment is processed again.

Use a browser with WebCodecs video decoding and encoding, OffscreenCanvas, and
workers. The app checks codec support on the device. Current desktop Chrome or
Edge is a useful starting point; the integration suite uses Chromium on Linux.
HTTPS is required outside localhost. A phone may have less memory or fewer
available codecs even though the controls fit a small screen.

MP4 with H.264/AAC is selected when both output sizes and the source's audio can
be encoded. Otherwise the app tries WebM with VP9/Opus. Unsupported inputs or
output sizes produce an error before processing. The mosaic has no audio; the
combined video preserves the source audio timeline and selected slice.

## Settings and Python parity

The editor exposes the Python pipeline's matching and sizing controls:

| Controls | Behaviour |
| --- | --- |
| Grid density, fixed grid, cell height, tile fit | Automatic or explicit geometry; native ratio, centre crop or stretch; density 1 supports a single tile |
| Colour / brightness, contrast, colour bins, brightness tolerance | Mean-colour lattice or luma matching, with gallery brightness trimming |
| Candidate tiles, varied choices, seed, hold unchanged tiles | Seeded candidate selection and optional temporal stability |
| Start, duration | A source slice; skipped frames initialise matching state so slicing preserves the same browser choices |
| Gallery frame stride | Sample every Nth video frame and discard duplicate video tiles |
| Checkpoint interval | Completed video segments plus matching state; 0 disables resumable checkpoints |
| Gallery memory limit, reuse gallery | Bound resized tile bytes and optionally reuse a session cache |
| Estimate size | Probe the source and gallery without producing output |

Load a flat TOML or JSON settings file, or save the current settings as TOML.
Python path and CLI-only fields (`source`, `gallery`, `output_dir`,
`gallery_type`, `dry_run`) are ignored on import; files are selected explicitly
in the browser. Other unknown fields are rejected. The default tile budget is
256 MiB. Other defaults follow the Python CLI, including 5,000-frame segments.

The browser uses its own seeded PRNG and Canvas resizing. Runs resumed in this
app preserve their tile choices; their pixels are not expected to match NumPy
and OpenCV output. Variable-rate inputs retain decoded frame order and are
encoded at the detected nominal frame rate. Browser ZIP checkpoints and Python
checkpoint directories are separate formats.

## Memory and checkpoint limits

Decoded source frames are processed incrementally. Gallery tiles, matching
tables, encoded segments and final downloads consume browser memory. The tile
budget bounds the resized RGBA tile array, not total memory. Resizing, parsing,
matching and encoding need extra working space. A local parse of the full
50,000-image CIFAR-100 batch used about 396 MiB peak process RSS in Node; this
is not a browser memory guarantee. CIFAR batch files are capped at 512 MiB.

The session gallery cache has a 64 MiB tile allowance and can be cleared from
Advanced settings. Settings, caches and checkpoints are not saved to browser
storage. Download a checkpoint before closing or reloading the tab.

Checkpoints contain encoded segments, settings, input content digests, and RNG
and held-tile state. Imports validate names, hashes, sizes, geometry and frame
totals. Archives are limited to 2 GiB and 50,000 segments. Output geometry is
limited to 16,384 pixels per mosaic side, 67,108,864 pixels, and 1,048,576 grid
cells; device codecs can impose smaller limits. Content hashes are versioned
SHA-256 digests over 4 MiB block digests, allowing large files to be checked
without loading them into one JavaScript buffer.

## Development

Node 22.12 or later is recommended. Install and run:

```sh
npm ci
npm run dev
```

```sh
npm test
npm run build
npx playwright install chromium
npm run test:browser
```

Browser tests also need Python 3, FFmpeg and ffprobe on `PATH`. They generate
small synthetic videos in a temporary directory and inspect the downloaded
files. Tests cover slicing, delayed audio, both metrics, CIFAR, settings
round-trips, input errors, responsive controls, and exact decoded equality
after cancellation and checkpoint resume. Unit tests use small synthetic
pickles; the full CIFAR dataset is optional.

The app uses TypeScript and Vite with no UI framework. Mediabunny owns demuxing,
WebCodecs integration and muxing. `pickleparser` handles the pickle grammar
through a restricted NumPy/CIFAR adapter; `fflate` handles stored checkpoint
ZIPs; `smol-toml` handles settings.

| Module | Responsibility |
| --- | --- |
| `config.ts`, `types.ts` | Settings, geometry and shared contracts |
| `cifar.ts`, `gallery.ts` | CIFAR adaptation, gallery loading and cache |
| `matching.ts` | Matching, seeded choices and held state |
| `media.ts`, `engine.ts` | Media inspection, incremental processing and output |
| `checkpoint.ts` | File identity and checked checkpoint archives |
| `worker.ts` | Background jobs, cancellation and progress messages |
| `main.ts`, `ui.ts`, `style.css` | Editor, local files, preview and downloads |

When `document.modelContext` is available, the page registers optional WebMCP
tools to read status, configure settings, estimate and start work using files
already selected by the user. The ordinary editor does not depend on this API.

`npm run build` produces the static `dist/` directory. `.openai/hosting.json`
identifies the Sites deployment; it contains no runtime credentials. Hosting
serves the app only, and receives none of the selected media.

## Licence

MIT; see [LICENSE](LICENSE). Source videos and third-party datasets are not
included in the app.
