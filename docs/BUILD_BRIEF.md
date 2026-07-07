# Pingwire DCO App — Build Brief

## Purpose

A local, solo-use web app that generates personalized display ads. Roel uploads background creatives and a list of target companies. The app renders a headline containing the company name, a stat block, and the Pingwire logo onto each background, in the correct position, font, size, and color. Output: compressed PNGs written directly to disk in one folder per company.

Scale today: 4 creatives x 5 banner sizes = 20 templates. ~70 target companies per batch = ~1,400 PNGs per full run.

## Terminology

- **Creative**: one of the 4 ad designs (e.g. "Faster_case_handling").
- **Template**: one creative in one banner size. 20 exist today.
- **Company**: a target company whose name is inserted into the headline (e.g. "Avarda").
- **Element**: a positioned item on a template: headline, stat block, or logo.

## Architecture

- Local-first. Runs on Roel's machine via `npm run dev`. No hosting, no auth.
- Vite + React frontend. Node/Express backend in the same repo (or Next.js with API routes; builder's choice, keep it simple).
- Rendering happens in the browser with the HTML canvas API. The editor preview IS the render, pixel-identical.
- The browser posts finished PNG blobs to the local server. The server writes files/folders to disk and proxies the Tinify API.
- Tinify API key lives in a local `.env` file, never in frontend code.
- Storage: one SQLite file (better-sqlite3) for configs, companies, display-name overrides, and run history. An `assets/` folder for uploaded background PNGs and the logo. Everything portable; committing/backing up the folder backs up the app.
- Output folder path is configurable in settings (Roel points it at a Google Drive synced folder). Structure: `{output}/{CompanySanitized}/{CompanySanitized}_{Message}_{WxH}.png`. No ZIPs, ever.

## Fonts and colors

- Font: Inter, all weights, bundled locally as font files in the repo. Loaded via @font-face. Wait for `document.fonts.ready` before any canvas render.
- Brand palette defaults (verify against brand guide in editor once):
  - Main Green `#124131` (headline and stat text)
  - Marigold `#ECA400` (company name accent)
  - Dark Green `#238061`
  - Bright Snow `#F9FAFA`
- Each element's color is set per template, prefilled from the palette. The palette itself is editable in settings.

## Banner sizes

300x250, 300x600, 320x320, 320x480, 980x400. Sizes must be data, not hardcoded: adding a size later means adding a row, not changing code.

## The 2x pipeline

All rendering happens at 2x internal resolution. Background PNGs are uploaded as 2x exports (e.g. 600x500 for the 300x250 template). Text and logo render at 2x. One high-quality downscale to final size at export, then Tinify compression. Validate uploaded background dimensions = 2x the template size; warn if not.

## Templates

- Upload backgrounds via drag-and-drop. Filename convention parsed automatically: `Brand_Message_WxH.png` (e.g. `Pingwire_Faster_case_handling_300x250.png` at 2x pixel dimensions). Parsed fields (creative name, size) shown and editable before saving, in case the parse is wrong.
- Logo uploaded once as SVG or PNG asset, placed per template.

## Visual editor (per template)

Canvas preview at actual final pixel size (rendered at 2x, displayed at 1x), with a sample company name.

Three elements, each draggable and resizable:

1. **Headline**: rich text with a `{company}` placeholder token. The placeholder is its own styled span: independent color (default Marigold) and weight. All other headline text defaults to Main Green. The styling rule must be per-template config, not hardcoded, so a future creative can invert it.
2. **Stat block**: two lines, a large stat (e.g. "92%") and a sub-line (e.g. "Faster case handling."). Fixed per creative, identical across companies, editable in the editor. Position mode toggle: absolute, or "follow headline" with a fixed gap so it shifts down when a long company name wraps the headline to an extra line.
3. **Logo**: the uploaded asset, positioned and scaled per template.

Per text element controls: x/y, max width (wrap boundary), font size, font weight, line height, letter spacing, alignment, color. Text wraps within max width; manual line breaks allowed in the headline pattern.

Editor conveniences: switch the sample company name to test long names (preload "Länsförsäkringar Bank"), copy element layout from another template of the same size, save per template.

## Long-name handling

- Auto-shrink: if the headline exceeds its max width/height box, reduce font size in steps down to a configurable floor (default 80% of base size).
- If it still overflows at the floor: render anyway, flag the company+template as an overflow case for the review queue.
- Per-company display name override, edited in-app and persisted in SQLite, so re-runs remember it. The override affects rendered text only; see naming below.

## Companies

- Upload .xlsx or .csv. Read the first column. Skip the first row if it looks like a header. Trim whitespace. Dedupe identical names with a notice. Show the parsed list for confirmation before saving.
- Companies persist in SQLite with: original name, optional display-name override, timestamps.
- Single-company mode: type or pick one company, generate its 20 ads.

## Output naming

- Folder and file names use a sanitized company name: transliterate Å/Ä/Ö/å/ä/ö and other diacritics to ASCII, spaces to underscores, strip characters outside `[A-Za-z0-9_-]`.
- Rendered text on the banner always uses the real (or override) name, untouched.
- File: `{CompanySanitized}_{Message}_{WxH}.png`.

## Run modes

1. **Single company**: pick one, generate 20, review, write to disk.
2. **Batch**: select companies (default all), then either:
   - **Preview run**: generate only the first company's 20 ads, show the approval grid. On approval, the batch proceeds automatically.
   - **Full run**: skip the gate.
- **Dry-run toggle**: generate and write PNGs but skip Tinify entirely. For testing without burning credits.
- **Skip-unchanged**: a run only regenerates companies whose name/override changed or whose templates changed since their last successful generation (hash the template config + display name; store per company per template in run history). Manual "force regenerate" override available.
- Overwrite behavior: regenerating a company overwrites its files. Companies not in the run are never touched.
- Batch never pauses for flagged cases. It completes everything and leaves flagged cases in the queue for afterward.
- Progress bar with per-company status.

## Tinify integration

- Server-side proxy only; key in `.env`.
- Throttle requests (small delay between calls). Retry with exponential backoff, 3 attempts per file.
- On final failure: write the uncompressed PNG anyway, add to a failures list, continue the batch. "Retry failed compressions" button afterward re-compresses in place.
- Read the compression-count header from Tinify responses. Display credits used this month. Before a batch, estimate the compression count and warn if it would exceed the configured plan limit (settings field: monthly limit, default 500).

## Review screens

1. **Preview-run approval**: grid of the first company's 20 ads at actual pixel size, grouped by creative (4 rows x 5 sizes). Buttons: "Approve and start batch" / "Cancel".
2. **Flagged-cases queue** (overflow at shrink floor): per case, show the rendered ad with actions: accept as-is; edit display name inline and re-render immediately; skip company.
3. **Batch summary**: files written, credits used, failures list with retry button, output path with an "open folder" button (shell open).

## Suggested build order

1. **Phase 1 — Core render**: project scaffold, SQLite, template upload with filename parsing, the visual editor for one template with all three elements and the 2x pipeline, single-company render to disk (dry-run only, no Tinify).
2. **Phase 2 — Robustness**: auto-shrink with floor and flagging, display-name overrides, long-name test tooling, Excel/CSV import, output naming and sanitization.
3. **Phase 3 — Batch**: batch runner with progress, preview-run gate, skip-unchanged, review queue, batch summary.
4. **Phase 4 — Tinify**: proxy, throttling, retries, failure fallback, credit counter and warnings.

## Acceptance checks

- Rendered output for the sample "Avarda" set is visually indistinguishable from the reference banners (position, wrap, colors, weights).
- "Länsförsäkringar Bank" on 300x250 either fits via shrink or is flagged; never silently overflows.
- A full dry-run of 3 companies x 20 templates writes 60 correctly named PNGs into 3 folders in under a minute.
- Killing and restarting the app loses nothing: templates, placements, companies, overrides, and run history persist.
- No Tinify key appears anywhere in frontend code or the browser network tab beyond calls to localhost.
