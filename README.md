<div align="center">

<!-- Swap in a recording when you have one: record search → pick → playback,
     save it as docs/demo.gif, and point the src below at it. -->
<img src="docs/demo.png" alt="torrential — search the swarm · stream the storm" width="760">

**hunt the episode · stream the storm**

A torrential downpour of TV, right in your terminal.

torlink-inspired TUI · programmatic WebTorrent engine · series → seasons → episodes, zero wait

[![CI](https://github.com/frierens-arm/torrential/actions/workflows/ci.yml/badge.svg)](https://github.com/frierens-arm/torrential/actions/workflows/ci.yml)

[Features](#features) · [Install](#install) · [Quickstart](#quickstart) · [Keybindings](#keybindings) · [Streaming](#how-streaming-works) · [Configuration](#configuration) · [Troubleshooting](#troubleshooting)

</div>

---

**torrential** unifies the clean interactive search workflow of
[torlink](https://github.com/baairon/torlink) with the streaming engine of
[webtorrent-cli](https://github.com/webtorrent/webtorrent-cli): type what you
want, pick the healthiest result, and start watching while the pieces are still
falling — no full download, no web UI, 100% terminal.

**v2.1 is the dual-mode edition**: episodic results still group into series —
browse by season, then pick an episode or a whole season pack — while movie
results land in a **flat list** you can stream in one keystroke. Every row is
classified (`movie` / `episode` / `season-pack`) and the `auto` router picks
the landing screen for each result set; `tv` keeps the strict series-only
flow, `movies` goes straight to the list. Switch with `--mode` or `/mode`.

```
  ❯ "breaking bad"  ·  1 shows · grouped by series

  ✓ piratebay 18   ✓ 1337x 9   ✓ nyaa 0

     #  SERIES                                SEED TORRENTS SEASONS  EPS
   ▸ Breaking Bad                              210        12      1-2      4

  j/k ↑↓ navigate · ⏎ browse seasons · g/G top/bottom · q new search · ctrl+c quit
```

```
  ❯ Breaking Bad  ›  Season 1

     #  EPISODE  BEST TORRENT                          SEED      SIZE  QUALITY
   ▸ E01       Breaking Bad S01E01 2008 720p…          120   1.2 GB  720p
     E02       Breaking Bad S01E02 720p BluRa…          110   1.1 GB  720p
     ── season packs ─────────────────────────────────
     PACK      Season 1 · Complete 720p                 210   9.9 GB  720p
```

```
  ❯ "oppenheimer"  ·  24 movies · flat list

  ✓ piratebay 12   ✓ 1337x 11   ✓ nyaa 1

     #  TITLE                                            YEAR  QUALITY      SEED
   ▸ Oppenheimer 2023 2160p WEB-DL DDP5.1 Atmos…         2023  2160p        421
     Oppenheimer 2023 1080p BluRay x264-GROUP            2023  1080p        318
```

```
  ▶ streaming via mpv

  Breaking.Bad.S01E01.720p.mkv — 1.2 GB (file 1 of 5 in this pack)
  endpoint http://127.0.0.1:8000/webtorrent/08ada5a7…/Breaking.Bad.S01E01.720p.mkv

  [████████████▓░░░░░░░░░░░░░░░░░░░░░░░░] 42.3% cached

  ↓ 3.8 MB/s · ↑ 120 kB/s · peers 18 · eta 41s · swarm 38%
```

## Features

- **Dual-mode search TUI (v2.1)** — every provider row is classified by a
  signal scorer: explicit episode markers (`S02E05`, `S2E5`, `2x05`, `205`,
  date episodes, absolute anime numbering) beat movie-looking release tags,
  while a movie needs at least **two** corroborating signals (year, source
  tag, codec, audio, movie-only phrase — resolution alone never counts). In
  `auto` mode the first results batch votes: a movie majority lands on the
  flat movie list, an episode/pack majority (or an unsure vote) keeps the
  series tiers. The query itself only breaks a tie, and a classifier miss
  degrades silently to the 2.0 TV flow.
- **Episodic TV tiers** — episodic results arrive **grouped by series**:
  season browser, episode grid, pinned season packs. Rows are parsed with a
  regex battery that understands `S02E05`, `205` (1xx), `2x05`, `Season 2`,
  `2nd Season`, absolute anime numbering (`Show - 28 [1080p]`), batch ranges
  (`01-12`), and `Complete Series` — with year guards so `Oppenheimer - 2023
  [1080p]` is never mistaken for E2023. 1337x is searched
  through its **TV category** in `tv` mode (plain catalogue search in
  `auto`/`movies`), Pirate Bay via the apibay.org JSON API, Nyaa via polite
  scraping with mirror fallback.
- **Flat movie list (v2.1)** — `movies` mode (or an auto-mode movie vote)
  lists one row per torrent, best swarm first: title, year, quality, size,
  seeders and source, responsive to terminal width. `⏎` opens the pre-flight
  card and streams; single-video torrents play directly, multi-video ones
  detour through the file picker.
- **Smart supplemental hunts** — when a season has no packs or an episode's
  candidate list is thin, torrential automatically re-queries every source
  with **SxxExx and 1xx nomenclature** (`breaking bad S02E05` / `breaking
  bad 205`) and merges the answers into the view you're looking at.
- **Season packs with an interactive file picker** — multi-file torrents
  (season packs, batch uploads) open a file-selection screen: video files
  listed first, sorted by episode, your target pre-highlighted. Exact
  episodes inside a pack are matched automatically when the hunt knows
  the SxxExx; only ambiguous packs ask.
- **Instant sequential streaming** — the selected magnet goes straight into an
  in-process [WebTorrent](https://webtorrent.io) engine: DHT + tracker peer
  discovery, critical-piece-first fetching driven by HTTP `Range` requests,
  and an on-disk piece cache that fills while you watch.
- **Speed engine — built for slow networks** — a pre-warmed client
  boots with the app (DHT is hot before you pick a result), the first ~4 MB of
  the file **and** its tail (MP4 `moov` / MKV `Cues`) start downloading the
  instant metadata lands — before the player even opens — metadata is cached
  on disk so re-streams skip it entirely, and a **turbo serving layer**
  tracks the player's playhead and keeps a rolling priority window of video
  ahead of it, with hard escalation when the swarm falls behind. Tune
  everything via config or `--turbo`-family flags (see `docs/CONFIG.md`).
- **Cross-platform player hand-off** — system default player (`xdg-open` /
  `open` / `start`) out of the box, with an automatic fallback chain to
  **mpv → vlc → iina** (macOS) when the system opener fails or is missing.
  IINA is invoked through `iina-cli --no-stdin --keep-running <url>` —
  quitting the IINA app stops the stream and triggers cleanup.
- **A dashboard, not a log** — violet→cyan gradient progress bar with an
  animated sheen, live download/upload speed, peers, ETA, cached percentage,
  and honest warnings for quiet or dead swarms (dead-torrent errors carry a
  concrete next step, not just a shrug).
- **`--doctor`, not guesswork** — one command checks the runtime, config,
  cache, player binaries, stream port and every indexer, prints a plain-text
  report and exits non-zero on a real problem. `--offline` skips the network
  probes, so it works on a plane and in CI. This is the first thing to paste
  into a bug report.
- **Continuity out of the box** — recent searches are recalled with `↑`/`↓`
  in the search bar, the last episode you streamed from a season is
  preselected and marked `▶`, and when an episode finishes the pre-flight card
  moves to the next one (`⏎` to keep watching).
- **`--debug` when it matters** — the TUI owns the terminal, so diagnostics go
  to `<cache dir>/torrential.log` instead of stdout. Search timings, metadata
  cache hits, turbo bind results, the chosen file, the player argv and every
  teardown land there, and the cache's `meta/` folder is pruned at boot so it
  cannot grow forever.
- **Disk stays clean by default; `--keep` when it's a keeper** — closing the
  player (or `q` / `Ctrl+C`) stops the engine and wipes the temporary piece
  cache, so watched episodes never eat your disk. Add `-k`/`--keep` and the
  watched file is rescued into your videos folder (`~/Movies/torrential` on
  macOS) instead of being deleted; `--keep=~/somewhere` or `--keep-dir`
  chooses the destination.
- **Magnet & info-hash friendly** — paste a magnet URI or a bare 40-char
  info-hash into the search bar (or pass `--magnet`) and skip search entirely;
  multi-file magnets land in the file picker.
- **Resilient multi-source search** — sources run concurrently and one being
  blocked (Cloudflare 403 on VPN/datacenter IPs) only demotes it to a dim
  footnote while the others keep filling the table. `--sources tpb,nyaa`
  trims the roster for one session. If 1337x fails at the DNS level — the
  classic ISP court-block — torrential silently retries the domain over
  **DNS-over-HTTPS** (1.1.1.1 / Google) and connects straight to the real
  IPs; you can also pin your own mirrors via the `x1337_mirrors` config key.
- **Pluggable backends** — providers and the stream engine are layered so an
  API-based streaming backend (debrid / direct media APIs) can slot in later
  without touching the UI: search rows already carry a `kind` marker and the
  engine contract is backend-agnostic.
- **Set your player in one command** — `torrential -df iina` (or
  `--default-player mpv`) validates the choice against what's actually
  installed and saves it to config. No more editing JSON. `--default-player`
  with no value shows the current setting plus everything detected.
- **Skins** — eight hermes-agent-style themes:
  `rain` (default violet→cyan), `matrix`, `sunset`, `ocean`, `ember`, `candy`,
  `amber`, `mono`. Apply for one session with `--theme matrix`, or type
  `/theme` in the search bar for the live color-chart picker — **↑/↓ or j/k
  move the highlight, ⏎ applies + saves, esc/q dismisses** — and
  `/theme matrix` to apply + save directly. Aliases like `/theme red`,
  `/theme blue`, `/theme green` work; `/skin` is an alias for `/theme`.

## Requirements

| | |
|---|---|
| Node.js | **≥ 22.0** (18 and 20 will not work — see [Install](#install)) |
| OS | Linux, macOS, Windows |
| Player | any of: system default handler, mpv, VLC, IINA (macOS) |

> **Tip:** `mpv` gives the best streaming experience — it starts playing HTTP
> streams almost immediately and honors `Range` seeking.
> `brew install mpv` · `apt install mpv` · `winget install mpv`

## Install

**Check your Node version first — 22 or newer is required:**

```bash
node -v              # must print v22.x or higher
```

`webtorrent@3` and `undici@7` no longer support older runtimes. On Node 18/20
`npm install` only prints `EBADENGINE` warnings, and the next command dies with
a stack trace that never mentions Node:

```
node_modules/undici/lib/web/webidl/index.js:537
webidl.is.File = webidl.util.MakeTypeAssertion(File)
                                               ^
ReferenceError: File is not defined
```

Upgrade with [nvm](https://github.com/nvm-sh/nvm) (`nvm install 22 && nvm use 22`),
[fnm](https://github.com/Schniz/fnm), or `brew install node@22`. The repo ships
an `.npmrc` with `engine-strict=true`, so `npm install` now stops immediately
with a clear `EBADENGINE` error on a too-old Node instead of installing anyway.

From source (clone/unzip this directory) — two commands and you're running:

```bash
cd torrential
npm install          # pulls dependencies (native bits compiled for your OS)
npm run build        # compiles dist/  (a prebuilt dist/ ships in the zip too)
npm link             # makes the `torrential` command available everywhere
```

Or run it straight without installing:

```bash
npm install && npm run build && node dist/cli.js
```

Works on **Linux, macOS and Windows** (Node.js ≥ 22). No external tools are
required — every speed feature is pure Node/WebTorrent. If the zip you got
already contains `dist/`, you can skip the build entirely.

### `permission denied` (`EACCES`) on install

`npm link` / `npm install -g` fails on macOS and Linux when npm's global prefix
(`/usr/local`, or the Homebrew `node` prefix) belongs to root:

```
npm ERR! code EACCES
npm ERR! syscall mkdir
npm ERR! path /usr/local/lib/node_modules/torrential
npm ERR! errno -13
npm ERR! Error: EACCES: permission denied, mkdir '/usr/local/lib/node_modules/torrential'
```

**Do not fix it with `sudo`** — that leaves root-owned files behind and makes
the next install fail differently. Point npm at a prefix you own instead:

```bash
mkdir -p ~/.npm-global
npm config set prefix ~/.npm-global
echo 'export PATH="$HOME/.npm-global/bin:$PATH"' >> ~/.zshrc   # ~/.bashrc on bash
source ~/.zshrc

cd torrential
npm link             # or: npm install -g .
torrential --version
```

Already installing Node through nvm/fnm or Homebrew? Then npm's prefix is
usually writable and there is nothing to change — make sure you are **not**
using the system Node, and re-check with `npm config get prefix`.

Other options, no global config changes needed:

- Run it from the checkout: `node dist/cli.js` (or `npm start`) — no global
  install, no write outside the project.
- If a previous `sudo npm install` left root-owned files in the way:
  `sudo chown -R "$(id -u):$(id -g)" "$(npm config get prefix)/lib/node_modules" "$(npm config get prefix)/bin"`.
- If `./dist/cli.js` itself says `permission denied`, the executable bit is
  missing from the build output: `chmod +x dist/cli.js`, or just prefix it
  with `node`.

## Quickstart

```bash
torrential                    # the dive-in screen: just type a show
torrential "breaking bad"    # start a show hunt immediately
torrential "oppenheimer"     # auto-routes movie-heavy results to the flat list
torrential --magnet "magnet:?xt=urn:btih:…"
torrential --magnet 08ada5a7a6183aae1e09d831df6748d566095a10
torrential --player mpv --port 9000 "better call saul"
torrential -k "the last of us"          # stream & save to ~/Movies/torrential
torrential --keep=~/watchlist "frieren"  # save into a folder you pick
torrential --sources tpb,nyaa "severance"  # skip a blocked source for you
torrential --mode movies "sintel"       # movie hunt (tv / movies / auto)
torrential --no-player --magnet '…'   # headless-ish: show the stream URL only
torrential --list-players             # what can I launch on this machine?
torrential --clear-cache              # wipe ~/.cache/torrential and run
torrential --doctor                    # check Node, player, port, sources
TORRENTIAL_DEBUG=1 torrential "severance"   # write <cache>/torrential.log

# speed tuning (defaults are already on)
torrential --no-turbo "the bear"        # plain webtorrent server instead of turbo
torrential --upload-limit 550 "succession"  # cap upload (slow ADSL uplinks)
torrential --max-conns 300 "warrior"    # more peer connections
```

The flow depends on the content mode. `auto` (default) decides per search:

- **Episode-ish result set** → series list → pick a show → season browser →
  episode grid (with pinned season packs) → torrent pre-flight → stream.
- **Movie-ish result set** → flat movie list → torrent pre-flight → stream.

`tv` always uses the series tiers (and drops movie rows); `movies` always
lands on the flat list. Thin TV views keep hunting automatically with SxxExx
/ 1xx queries until episodes surface. The search bar also accepts pasted
magnet links and bare info-hashes — torlink-style — and jumps straight to
streaming.

## Keybindings

| Key | Action |
|---|---|
| `j` / `k`, `↑` / `↓` | move the selection (series, seasons, episodes, movies, files, `/theme` picker) |
| `⏎` | open the highlighted row: series → seasons, season → episodes, episode/movie → pre-flight, confirm → stream (also applies a skin in the picker) |
| `n` / `p` | cycle next / previous torrent for the highlighted episode or movie (pre-flight) |
| `g` / `G` | jump to top / bottom |
| `↑` / `↓` (search bar) | recall recent searches, shell-style (newest first) |
| `PgUp` / `PgDn` | page through long episode lists or movie lists |
| `b` | back one tier (movie detail → movie list; episode → season → series → search); from stream: stop |
| `esc` / `q` | close the `/theme` picker · back / new search (including from the movie list) · stop streaming (stream) — wipes the cache unless `--keep` |
| `Ctrl+C` | quit anywhere — kills the player, stops the engine, wipes the cache unless `--keep` |

## What's new in 2.2

- **`--doctor`** — runtime, config warnings, cache writability, disk space,
  player detection, port availability and a live probe of every indexer in
  one report; non-zero exit on a hard failure. `--offline` skips the probes.
- **`--debug`** — opt-in diagnostic log (`--debug=/path`, or
  `TORRENTIAL_DEBUG=1` / `TORRENTIAL_LOG=<path>`). Logging never writes to the
  TUI frame; the file is truncated at 2 MB. Search timings, metadata hits,
  turbo bind results, the selected file, player argv and teardown are covered.
- **Continuity** — `state.json` remembers recent searches and where you were
  in each series. `↑`/`↓` recalls searches, the last-watched episode is
  preselected with a `▶` marker, and finishing an episode moves the pre-flight
  card to the next one instead of dumping you back on the grid.
- **Bounded metadata cache** — `<cache>/meta` is pruned at boot (30 days,
  300 entries max), so repeat streams stay instant without unbounded growth.
- **Smarter playhead** — only connections that actually served bytes in the
  last 10 s set the piece window. A paused second player (or VLC's EOF index
  probe) can no longer starve the reader that is watching.
- **Tests + CI** — `npm test` runs the `node:test` suite (parser, classifier,
  Range/playhead, config, state, cache, doctor) and CI exercises
  Linux/macOS/Windows × Node 22/24. `App.tsx` was split into
  `src/ui/hooks/*` (search, stream session, preferences) on the way.

## What's new in 2.1

- **Auto-mode movie router** — each result row now carries a classifier
  verdict (`movie` / `episode` / `season-pack` plus a confidence). The first
  results batch is voted and decides the landing screen: movie majority →
  flat list, episode/pack majority or an unsure vote → series tiers. The
  decision is made once per search; a classifier miss looks exactly like
  2.0 and simply keeps the TV flow.
- **`movies` mode is real** — `--mode movies` (or `/mode movies`) boots and
  lands on the flat movie list instead of only tagging rows. `tv` remains
  the strict firewall: non-episodic rows are dropped there, so the series
  tiers stay show-only.
- **Year guards in the TV parser** — `Oppenheimer - 2023 [1080p]` no longer
  parses as absolute episode E2023, `Blade Runner 2049` is no longer read as
  S20E49, and year-shaped 1xx tokens (1900-2099) are skipped.
- **Movie pre-flight + navigation** — `⏎` on a movie opens the same
  pre-flight card as an episode (seed warnings, `n`/`p` cycling, source
  context). After playback you land back on the card; `b`/`q`/`esc` returns
  to the movie list, and `q`/`esc` there goes back to the search bar.
- **Offline coverage for the new path** — `tools/classify-smoke.mjs` asserts
  the scorer and parser regressions, `tools/render-smoke.tsx` renders the
  movie screens headlessly, and `tools/tv-smoke.mjs` keeps the episodic
  pipeline honest.

### Previously in 2.0

- Episodic TV edition: series grouping, season browser, episode grid, season
  packs, smart SxxExx/1xx supplemental hunts, interactive file picker,
  `n`/`p` pre-flight cycling, the 1337x TV-category route, and backend slots
  (`kind: 'torrent' | 'api'`) for future streaming providers.
- Cleaner teardown: after playback stops you land back in the pre-flight
  view, ready to `n` to another torrent or `b` back to the episode grid for
  the next episode.

## Configuration

JSON config lives at `~/.config/torrential/config.json`
(`%APPDATA%\torrential\config.json` on Windows). It is created with defaults on
first run. CLI flags always win over the file.

```json
{
  "default_player": "system",
  "player_flags": [],
  "player_fallbacks": ["mpv", "vlc", "iina"],
  "cache_directory": "~/.cache/torrential",
  "keep_directory": "~/Movies/torrential",
  "port": 8000,
  "keep_cache": false,
  "max_results": 40,
  "providers": ["piratebay", "1337x", "nyaa"],
  "metadata_timeout": 45,
  "search_timeout": 12,
  "turbo": true,
  "max_conns": 200,
  "ram_cache_mb": 256,
  "upload_limit_kbps": 0,
  "head_start_mb": 4,
  "tail_prefetch_mb": 2,
  "window_secs": 30,
  "theme": "rain",
  "mode": "auto",
  "x1337_mirrors": []
}
```

- `default_player` — `"system"` (xdg-open / open / start), `"mpv"`, `"vlc"`,
  `"iina"`, or an absolute path to any player binary.
- `player_flags` — extra argv for binary players, e.g.
  `["--force-window=immediate", "--cache=yes"]` (mpv) — ignored for `"system"`.
- `cache_directory` — where pieces are cached while streaming (wiped on exit
  unless `keep_cache` is `true`).
- `keep_directory` — where `--keep`/`-k` parks saved files; the folder is
  created on demand. Defaults to `~/Movies/torrential` (macOS) or
  `~/Videos/torrential` elsewhere.
- `port` — preferred local stream port; nearby ports are picked automatically
  when busy.
- `turbo` — playhead-tracking serving layer (on by default). Falls back to
  webtorrent's built-in server with `--no-turbo` or on bind failure.
- `max_conns` — peer connections per torrent (default 200; more sockets =
  more aggregate bandwidth on many-peer swarms).
- `ram_cache_mb` — RAM piece-cache budget; player re-reads (moov, seeks,
  rewinds) are served from memory instead of disk.
- `upload_limit_kbps` — upload cap; capping helps when your uplink is much
  slower than your downlink (ADSL/cable).
- `head_start_mb` / `tail_prefetch_mb` — bytes pulled before the player
  connects: the head (first-frame path) and the tail (`moov`/`Cues`/`idx1`).
- `window_secs` — seconds of video the turbo window tries to keep ahead of
  the playhead.
- `theme` — active UI skin: `rain`, `matrix`, `sunset`, `ocean`, `ember`,
  `candy`, `amber`, `mono`. Easiest way to change it: `/theme <name>` in the
  search bar (applies live and saves). Unknown values fall back to `rain`
  with a warning.
- `mode` — content mode: `auto` (default), `tv`, `movies`. `auto` routes
  each result set (movie vote → flat list, otherwise series tiers) and picks
  provider routes (1337x TV category in `tv` mode); `tv` is series-only and
  drops movie rows; `movies` always lands on the flat list. `/mode <name>`
  in the search bar applies + saves and takes effect on the next search,
  `--mode` wins for one session. Unknown values fall back to `auto` with a
  warning.
- `x1337_mirrors` — extra 1337x mirrors/proxies tried **before** the built-in
  list. Accepts plain origins (`https://unblockit.example/1337x.to` — the
  standard search path is appended) and `{query}` templates
  (`https://proxy.example/search?q={query}`) for sites with a different URL
  shape.

See **docs/CONFIG.md** for the full reference and **docs/ARCHITECTURE.md**
for how the pieces fit together (providers → engine → player → TUI).

## How streaming works

1. Your selection resolves to a magnet (instantly for Pirate Bay/Nyaa, or via
   a detail-page fetch for 1337x). The WebTorrent client has been warm since
   the app booted — DHT and trackers already know about each other. Movie
   rows skip episode resolution: they stream with an `auto` target, which
   plays the largest video file directly and only opens the file picker for
   multi-video torrents.
2. The engine checks the **metadata cache** (`cache_directory/meta/`) — a
   torrent streamed before starts instantly, no `ut_metadata` round-trip.
   Otherwise it waits for metadata, then saves it for next time.
3. It picks the largest video file and selects only its pieces — then
   **immediately marks the first ~4 MB critical** (the first-frame path) and
   requests the last ~2 MB in parallel (where MP4 `moov`, MKV `Cues` and AVI
   `idx1` live). Your player hasn't even opened yet and the important bytes
   are already moving.
4. A local HTTP server exposes the file at
   `http://127.0.0.1:<port>/webtorrent/<infoHash>/<file>` — served with
   proper `Range` support, so players can seek. In turbo mode this is
   torrential's own serving layer: it watches every read position, keeps a
   rolling high-priority window of ~`window_secs` of video ahead of the
   playhead (sized from the measured swarm speed), and escalates to
   critical-priority fetching of the next 8 MB whenever the buffer-ahead
   estimate drops below ~12 s. `--no-turbo` swaps in webtorrent's built-in
   server; both speak the same strictly-compatible HTTP dialect (206/416,
   HEAD, no chunked, no redirects).
5. Your player opens that URL — with buffering defaults injected per player
   (mpv: `--cache-secs=90 --demuxer-readahead-secs=90 …`, VLC:
   `--network-caching=10000`) unless you configured `player_flags` yourself.
   As it reads, the engine keeps prioritizing exactly what the player needs
   next — you watch while the rest falls in. The stream screen shows a live
   `buffer ≈ Ns ahead` estimate so you know how much runway you have.
6. Stop with `q` or close the player: the engine tears down. Without flags
   the cache folder is wiped — nothing lingers on disk. With `--keep`/`-k`
   the streamed file is moved to `keep_directory` first (a partial file is
   kept too, labeled with how much of it downloaded), then the leftover
   cache is still wiped. The client itself stays warm, so the next stream of
   the session starts with hot DHT state.

## Troubleshooting

| Symptom | What it means / what to do |
|---|---|
| `ReferenceError: File is not defined` from `node_modules/undici/lib/web/webidl/index.js` (often after `EBADENGINE` warnings) | You're on Node 18 or 20; `webtorrent@3`/`undici@7` need **Node ≥ 22**. Your code is fine — the runtime is too old. Upgrade (`nvm install 22 && nvm use 22`, or `brew install node@22`), then rerun `npm install && npm run build` — no need to delete `node_modules`. See [Install](#install). |
| `npm ERR! code EACCES` / `permission denied` while running `npm install`, `npm link` or `npm install -g` | npm is writing into a root-owned global prefix (`/usr/local` is the usual culprit). Don't use `sudo`; repoint npm's prefix at `~/.npm-global` (or run `node dist/cli.js` instead). Full steps: [`permission denied` on install](#permission-denied-eacces-on-install). |
| `✗ 1337x blocked` chip / dim `⚠ 1337x: … (HTTP 403)` footnote | The indexer answered with a Cloudflare challenge — common on VPN/datacenter IPs. Results from the other sources are unaffected. Retry, toggle your VPN, or drop the source: `--sources tpb,nyaa` (or the `providers` config key). |
| IINA says it cannot open the file | The URL is passed positionally to `iina-cli`, so make sure it's installed (IINA menu → Install CLI Tool); quit IINA when done to trigger teardown. |
| `no metadata after 45s — swarm looks dead` | Nobody is seeding. Pick a result with more seeders (the SEED column is color-coded; red = dead). |
| A movie-heavy search still opened the series view | The auto router saw more episode-ish rows than movie rows. Re-run with `--mode movies` (or `/mode movies`, then search again) for the flat list. |
| A movie never appears in the series list | Expected in `tv` mode — the strict filter drops non-episodic rows. Use `auto` or `movies` for those releases. |
| `--doctor` reports a failing indexer | That source is blocked or broken on your network right now. Results from the others are unaffected; use `--sources` to drop it, or a VPN/mirror for 1337x. |
| Something is broken and the TUI shows nothing useful | Run `torrential --doctor` for a printable report, then reproduce with `--debug` and include `<cache dir>/torrential.log`. |
| `no player found — open the endpoint above` | Install mpv/VLC, or set `default_player`/`--player` to a binary you have. `--list-players` shows what was detected. |
| `system default` opened my browser | That's the OS URL handler doing its job. For a real video player set `"default_player": "mpv"` (or `"iina"` on a Mac). |
| Playback stalls at 0% | Rare swarm hiccup: press `q` and try again, or pick a better-seeded release. Check `⚠ warnings` and the `buffer ≈ Ns ahead` estimate on the stream screen. |
| `could not start the local stream server` | The port range is occupied — set `port` in config; torrential also auto-probes nearby ports. |
| Want the old streaming behavior | `--no-turbo` (or `"turbo": false` in config) restores webtorrent's plain built-in server. Everything else keeps working. |

## Privacy & legal

Everything runs on your machine: searches go directly from your terminal to
the indexers, streaming goes peer-to-peer, and nothing is routed through a
central server. The cache lives in `cache_directory` only. Only download and
share content you have the legal right to.

## Development

```bash
npm run dev        # run from TypeScript source via tsx
npm run typecheck  # strict tsc
npm run build      # emit dist/
```

Layout: `src/providers` (indexer adapters + streaming aggregator),
`src/engine` (WebTorrent wrapper, turbo HTTP serving layer, shared client
host, `--keep` file rescue), `src/utils` (tv parser, `classify.ts` media
scorer, players, http, format, keep, sources, ascii), `src/ui` (Ink screens
& animated components, `MovieResultsScreen` on the flat path), `src/cli.tsx`
(entry).

The offline checks:

```bash
npm test                             # node:test suite (test/*.test.ts, via tsx)
npm run smoke                        # turbo server HTTP compatibility matrix
node tools/classify-smoke.mjs        # classifier + year-guard regressions (after build)
node tools/tv-smoke.mjs              # episodic parser/index (after build)
npx tsx tools/render-smoke.tsx       # movie-path Ink renders
npx tsx tools/app-smoke.tsx          # mounts the real App: history + state.json
node dist/cli.js --doctor --offline  # environment report, no network probes
```

CI runs the whole set on Linux, macOS and Windows against Node 22 and 24
(`.github/workflows/ci.yml`). Pushing a `v*` tag publishes to npm with
provenance and attaches the packed tarball to the GitHub release
(`.github/workflows/release.yml`; set an `NPM_TOKEN` secret first).

### Dependency & security notes

`package.json` carries two security-oriented fields — don't remove them:

- **`overrides.ip`** — the `ip` package is abandoned upstream and has an
  unpatched high-severity advisory (GHSA-2p57-rm9w-gvfp, `isPublic`
  mis-classifies non-canonical addresses, no fixed release exists; npm's own
  `audit fix --force` "fix" would downgrade webtorrent to 0.7.x). It is
  aliased to `@eggjs/ip`, a maintained drop-in fork of the same API built on
  `net.isIP`/`net.SocketAddress` strict parsing. If a future webtorrent
  release replaces `ip` upstream, drop this override.
- **`allowScripts`** — npm ≥ 12 skips dependency install scripts unless
  approved. The approved entries are the native/build tooling that genuinely
  needs them: `node-datachannel` (downloads its prebuilt WebRTC binary —
  without it streaming cannot connect), `utp-native`, `bufferutil`,
  `utf-8-validate` (node-gyp bindings), `esbuild` (binary installer used by
  tsx). `ip-set` is explicitly denied: its published `preinstall`
  (`npx only-allow pnpm`) is an accidentally shipped repo guard that would
  hard-fail every npm install.

When an upgrade bumps a pinned native dependency, npm will re-warn; review it
and re-approve with `npm install-scripts approve <pkg>` (or run
`npm install-scripts ls` to see what is pending).

## Star history

<a href="https://star-history.com/#frierens-arm/torrential&Date">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/svg?repos=frierens-arm/torrential&type=Date&theme=dark" />
    <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/svg?repos=frierens-arm/torrential&type=Date" />
    <img alt="Star History Chart" width="600" src="https://api.star-history.com/svg?repos=frierens-arm/torrential&type=Date" />
  </picture>
</a>

## Credits

- [torlink](https://github.com/baairon/torlink) — the clean interactive search workflow
  torrential is modeled on
- [webtorrent-cli](https://github.com/webtorrent/webtorrent-cli) — the streaming-engine
  foundation this project builds on
- [WebTorrent](https://webtorrent.io) — the protocol and engine doing the heavy lifting
- Theme palettes styled after hermes-agent's terminal colors

## License

MIT — see [LICENSE](LICENSE).
