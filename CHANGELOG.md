# Changelog

Notable changes to **torrential**. The CLI flags and `config.json` keys are the
public surface; anything marked *internal* can change without notice.

## 2.3.0 — 2026-11-16

A hardening release: everything here makes an existing feature honest or
cheaper, not louder.

### Fixed
- **`max_results` actually caps the table.** The key was documented and
  validated since 2.1.1 but nothing read it, so a session kept every row the
  sources returned. The merged list is now trimmed to the healthiest swarms
  (by seeders) once it exceeds the configured cap.
- **`@types/node` matches the runtime.** Types move to 22 next to the `engines`
  requirement, so Node 22-only APIs no longer type as absent.

### Changed
- **A superseded search stops scraping.** The session `AbortSignal` now flows
  from `useSearch` through `runSearch` into every provider request
  (`fetchText`/`fetchJson`). A new query, a `/mode` switch or an app exit drops
  the in-flight indexer requests instead of letting each run to its timeout.
- **One bounded retry per provider call.** A genuinely transient failure
  (reset socket, 5xx, DNS hiccup) is retried once after 250 ms. Blocks,
  timeouts and cancellations never are — they will not improve by asking again.
- **`src/ui/hooks.ts` folded into `src/ui/hooks/`** as `useTerminal.ts`. The
  repo no longer has two modules called "hooks" (*internal*).

### Added
- Tests for the pure modules that had none: player argv and launch-chain
  fallbacks (`buildPlayerLaunch`, `findOnPath`, `resolveLaunchChain`),
  `--sources` alias parsing, the slash-command parser, 1337x mirror URL
  construction, and a version-drift guard that keeps `version.ts`,
  `package.json` and this file in agreement.
- CI gained a `dependency audit` job (`npm audit --omit=dev --audit-level=high`)
  and weekly Dependabot updates for npm (monthly for Actions), so the pinned
  `webtorrent` / native-dependency set is reviewed on a schedule.
- `updates/2.3.0/` records what shipped here and what is deliberately queued
  for the next release.

### Removed
- `tools/test-fixes-130.tsx` and `tools/test-fixes-131.tsx` — one-off
  verification harnesses from the 1.3.x cycle that no npm script or CI job ran.
  Their still-relevant assertions (slash commands, mirror URLs) now live in
  `npm test`.

## 2.2.0 — 2026-10-24

### Added
- **Watch on your phone.** `l` on the stream screen (or `--phone` at launch)
  prints a QR code for the file you are already streaming. Scanning it opens a
  dependency-free mobile web player on the same Wi-Fi and playback moves to the
  phone: the desktop player closes, the engine keeps downloading and seeding,
  and the turbo playhead follows the phone's reads instead. Nothing is saved on
  the handset.
- **LAN-only, token-scoped sharing.** While sharing is off, every non-loopback
  request is refused on every route. While it is on, only `/p/<random-token>`
  and its media route are reachable — `/webtorrent/<hash>/…` never leaves the
  machine. `l` again revokes the token immediately.
- **Native player hand-off** from the phone page — Android `intent://`, iOS
  `vlc-x-callback://` — for containers a browser refuses (MKV, HEVC, AC3), plus
  a copy-link button and a best-effort screen wake lock.
- **`--lan-ip <addr>`** pins the address advertised on the QR for multi-NIC or
  VPN machines; detection otherwise prefers 192.168 → 172.16 → 10 and ranks
  virtual adapters last.
- **Live connection feedback.** Remote HTTP readers are counted separately from
  the local machine, so the stream screen shows `○ waiting for your phone…`
  until the phone actually starts reading, then
  `● phone connected — playback moved to your phone`. A share that never arrives
  is now visibly a network/permission problem instead of a silent failure.
- **`--doctor` phone-sharing section** — ranked LAN addresses (plus alternates
  to pin with `--lan-ip`), a LAN bind test, the macOS firewall state and the
  Local Network permission reminder.
- Tests for LAN address selection/ranking, loopback classification, share-token
  gating, the phone page, Range responses on the share route, remote
  connection counting and QR rendering. `tools/render-smoke.tsx` now asserts
  the QR, the waiting state and the connected state render inside Ink.

### Changed
- **Finishing an episode returns to the episode grid**, cursor on the next
  episode, instead of the torrent pre-flight card for the episode just watched.
  Stopping early still returns to the card. The decision lives in
  `utils/playback.ts` so it is unit-tested.
- `qrcode-terminal` (Apache-2.0, no runtime dependencies) renders the QR as
  Unicode half blocks — no ANSI escapes, so Ink measures and wraps it normally.

### Fixed
- Player-exit → teardown wiring is suppressed during a phone hand-off, so
  closing the desktop player no longer kills the stream the phone just started
  using.

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
