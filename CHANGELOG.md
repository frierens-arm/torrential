# Changelog

Notable changes to **torrential**. The CLI flags and `config.json` keys are the
public surface; anything marked *internal* can change without notice.

## 2.1.1 — 2026-10-24

### Added
- **`--doctor`** — runtime, config warnings, cache writability, disk space,
  player detection, port availability and a live probe of every indexer in one
  plain-text report. Exits non-zero on a hard failure. `--offline` skips the
  network probes, so it works on a plane and in CI.
- **`--debug[=<path>]`** — opt-in diagnostic log (`TORRENTIAL_DEBUG=1` and
  `TORRENTIAL_LOG` also work). Search timings, metadata cache hits, turbo bind
  results, the selected file, player argv and teardown all land in
  `<cache>/torrential.log`; nothing is written to the TUI frame.
- **Continuity** — recent searches (recalled with `↑`/`↓`), the last episode
  streamed from a season preselected and marked `▶`, and a finished episode
  advancing the pre-flight card to the next one.
- **Unit tests + CI** — `npm test` runs a `node:test` suite over the parser,
  classifier, Range handling, playhead selection, config validation, state
  ledger, cache pruning and doctor report. CI covers Linux/macOS/Windows ×
  Node 22/24. Tag pushes publish to npm with provenance.

### Changed
- Metadata cache (`<cache>/meta`) is pruned at boot: entries untouched for 30
  days are dropped and the directory is capped at 300 files.
- Playhead tracking only follows connections that served bytes in the last
  10 s, so a paused second player or an EOF index probe can no longer drag the
  piece window away from the active reader.
- `App.tsx` split into `src/ui/hooks/*` (*internal*).
- Repo URLs corrected from the `example/torrential` placeholder.

## 2.1.0

The dual-mode edition.

- **Auto-mode movie router** — every row carries a classifier verdict
  (`movie` / `episode` / `season-pack` plus confidence). The first results
  batch is voted once: a movie majority lands on the flat list, an
  episode/pack majority or an unsure vote keeps the series tiers. A
  classifier miss looks exactly like 2.0.
- **`movies` mode** — `--mode movies` (or `/mode movies`) lands on the flat
  movie list. `tv` stays a strict firewall that drops non-episodic rows.
- **Movie pre-flight** — `⏎` on a movie opens the same card as an episode
  (seed warnings, `n`/`p` cycling); `b`/`q` returns to the list.
- **Year guards** — `Oppenheimer - 2023 [1080p]` is no longer read as E2023,
  `Blade Runner 2049` is no longer S20E49, and year-shaped `1xx` tokens are
  skipped.
- Offline coverage for the new paths: `tools/classify-smoke.mjs`,
  `tools/render-smoke.tsx`, `tools/tv-smoke.mjs`.

## 2.0.0

The episodic TV edition.

- Series grouping, season browser, episode grid, pinned season packs.
- Smart supplemental hunts: thin views re-query with `SxxExx` and `1xx`
  nomenclature and merge the results in place.
- Interactive file picker for season packs, with the target episode
  pre-highlighted.
- 1337x TV-category route, `n`/`p` pre-flight cycling, backend slots
  (`kind: 'torrent' | 'api'`) for future streaming providers.
- Cleaner teardown: after playback you land back on the pre-flight card.
