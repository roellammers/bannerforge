# Bannerforge — Pingwire DCO App

Local, solo-use web app that renders personalized display ads: a headline with
the target company's name, a stat block, and the Pingwire logo composited onto
uploaded background creatives, written to disk as PNGs — one folder per company.

## Run

```bash
npm install
npm run dev
```

Open http://localhost:5170. The API server runs on port 5171 (proxied, so the
browser only ever talks to localhost:5170).

## How it works

- **Rendering** happens in the browser with the canvas API at 2x resolution
  (backgrounds are uploaded as 2x exports), then one high-quality downscale to
  final size. The editor preview goes through the exact same code path as the
  exported file.
- **Storage**: `data/app.db` (SQLite via better-sqlite3) holds template
  configs, companies, settings, and run history. `data/assets/` holds uploaded
  backgrounds and the logo. Back up the folder, back up the app.
- **Output**: `{output}/{CompanySanitized}/{CompanySanitized}_{Message}_{WxH}.png`.
  The output folder is configurable in Settings.
- **Fonts**: Inter (variable, all weights) bundled in `public/fonts`, loaded
  via `@font-face`; every render waits for the fonts to be ready.

## Template upload naming convention

`Brand_Message_WxH.png` at 2x pixel dimensions, e.g.
`Pingwire_Faster_case_handling_300x250.png` exported at 600x500. Parsed fields
are shown and editable before saving.

## Build status

- [x] Phase 1 — Core render: scaffold, SQLite, template upload with filename
  parsing, visual editor (headline / stat block / logo, 2x pipeline),
  single-company render to disk (dry-run, no Tinify)
- [x] Phase 2 — Robustness: auto-shrink to a floor with overflow flagging,
  per-company display-name overrides, "test all companies" overflow tool,
  Excel/CSV company import. (Output naming/sanitization landed in Phase 1.)
- [x] Phase 3 — Batch: select companies (default all), full run or preview-run
  approval gate, skip-unchanged (hash of template config + display name in
  run_history) with force override, per-company progress, flagged-cases review
  queue (accept / rename & re-render / skip), and a batch summary with a
  failures retry button and open-folder.
- [x] Phase 4 — Tinify: server-side proxy (key in `.env`, never in the
  frontend), throttled calls with 3-attempt exponential backoff, uncompressed
  fallback on failure with "Retry failed compressions" (re-compresses in
  place), credits-used counter from the Compression-Count header, and a
  pre-batch estimate that warns before exceeding the monthly plan limit.
  Dry-run toggle on both Generate and Batch skips Tinify entirely.

## Notes

- **Creatives**: a "creative" is a headline/stat combo sharing a background.
  Duplicate a creative across all its formats at once from the Templates page,
  entering the new texts up front. Leave a stat field empty to render it as a
  single headline-style line (for ads with no stat).
- **`xlsx` dependency**: company import uses SheetJS `xlsx` 0.18.5 from npm,
  which carries two high-severity advisories (prototype pollution, ReDoS) that
  only trigger on a *malicious* spreadsheet — not a concern for your own
  exports. The patched release is distributed only from SheetJS's CDN, not npm.
  To upgrade: `npm install "https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz"`.
