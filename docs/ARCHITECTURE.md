# Architecture

torrential is a layered terminal application: **providers** feed a
**streaming search aggregator**, the **engine** turns a magnet into a local
HTTP stream, the **player layer** hands that URL to whatever can play it, and
the **Ink TUI** binds it all into one interactive surface.

```
┌───────────────────────────────────────────────────────────────────────┐
│                              cli.tsx                                  │
│  args → config load → EngineHost (pre-warmed client) → <App/> (Ink)   │
└──────────────────────────────┬────────────────────────────────────────┘
                               │
┌──────────────────────────────▼────────────────────────────────────────┐
│                          ui/App.tsx                                    │
│  screen router: search ⇄ results ⇄ detail ⇄ stream                    │
│  consumes runSearch() events · owns engine + player lifecycle         │
│  global ctrl+c → shutdown hub (player kill → engine stop → exit)      │
└───────┬──────────────────────────────┬────────────────────────────────┘
        │ search events                │ stats / ready / error / stopped
┌───────▼────────────────┐   ┌─────────▼─────────────────────────────────┐
│ providers/              │   │ engine/host.ts — EngineHost               │
│  piratebay (apibay API) │   │  one WebTorrent client for the session    │
│  x1337 (scrape+mirrors) │   │  created at CLI boot (DHT pre-warm)       │
│  nyaa (scrape, magnets  │   │  maxConns · uploadLimit                   │
│        in rows)         │   └─────────┬─────────────────────────────────┘
│  index.ts: aggregator   │   ┌─────────▼─────────────────────────────────┐
│  (AsyncGenerator events)│   │ engine/stream.ts — StreamEngine           │
└─────────────────────────┘   │  metadata cache (cacheDir/meta/*.torrent)│
                              │  add(deselect:true) → pick video file    │
                              │  head-start critical(0..4MB)              │
                              │  tail prefetch (moov/Cues/idx1)           │
                              │  stats @4Hz + stall detection             │
                              │  stop() → client.remove (client survives) │
                              └─────────┬─────────────────────────────────┘
                                        │
                        ┌───────────────▼──────────────────┐
                        │ turbo ON  → engine/turbo-server  │
                        │  playhead tracking (min read     │
                        │  position across connections)    │
                        │  rolling window (priority 3      │
                        │  stream selections, adaptive)    │
                        │  stall escalation → critical()   │
                        │  full Range/206/416/HEAD/CORS    │
                        │  aliases /stream[/ext], /<index> │
                        ├───────────────┬──────────────────┤
                        │ turbo OFF → webtorrent           │
                        │  client.createServer() + HEAD    │
                        │  route probe (750ms cap)         │
                        └───────────────┬──────────────────┘
                                        │ http://127.0.0.1:<port>/webtorrent/<hash>/<file>
                        ┌───────────────▼──────────────────┐
                        │ utils/players.ts                 │
                        │  resolveLaunchChain():           │
                        │   preference → fallbacks         │
                        │  per-player buffering defaults   │
                        │  (mpv cache-secs, VLC netcache)  │
                        │  trySpawnPlayer() → ChildProcess │
                        │  killPlayer() → SIGTERM→SIGKILL  │
                        └──────────────────────────────────┘
```

## Module map

| Path | Responsibility |
|---|---|
| `src/cli.tsx` | Arg parsing (`--magnet`, `--player`, `--port`, `--sources`, `--mode`, `-k/--keep[=<dir>]`, `--keep-dir`, `--no-player`, `--phone`, `--lan-ip`, `--list-players`, `--doctor`, `--offline`, `--debug[=<path>]`, `--config`, `--keep-cache`, `--clear-cache`, `--turbo/--no-turbo`, `--max-conns`, `--upload-limit`, `--ram-cache`, `--help`, `--version`), config load + CLI overrides, debug-log activation, metadata-cache pruning at boot, `EngineHost` construction (client pre-warm at boot), `--list-players` / `--doctor` utilities, SIGINT → shutdown bridge, EPIPE safety. |
| `src/doctor.ts` | `--doctor`: one plain-text pass over runtime, paths, cache writability, disk space, player detection, port availability and a live probe of each indexer. Network probes are skipped with `--offline`; the report is safe to paste into a bug report and the command exits non-zero when a hard failure is found. |
| `src/config.ts` | XDG/Windows paths, JSON load/validate/save with friendly warnings; defaults are materialized on first run. v1.2 speed keys: `turbo`, `max_conns`, `ram_cache_mb`, `upload_limit_kbps`, `head_start_mb`, `tail_prefetch_mb`, `window_secs`. `mode` (`auto` \| `tv` \| `movies`, default `auto`) is validated like `theme` — unknown values warn and fall back to `auto`. Legacy configs load unchanged (missing keys take defaults). |
| `src/providers/*` | One module per indexer + `index.ts` aggregator. `runSearch()` accepts one query or a list (SxxExx / 1xx variants), fans every provider across all of them, dedupes cross-query, and shapes each row through `toTvResult()`: episodic rows get show/scope tags, non-episodic rows survive as GENERIC rows (`scope === undefined`) — tagged, not dropped, so the auto/movies modes can use them. `opts.mode` flows to providers: 1337x scrapes its TV category (`/category-search/<q>/TV/1/`) in tv mode and the plain catalogue search (`/search/<q>/1/`) in movies/auto (and as the mirror-compat fallback in tv mode). `ProviderInfo.kind` ('torrent' \| 'api') is the slot a future API-based backend plugs into. |
| `src/engine/host.ts` | `EngineHost` — owns the session-wide WebTorrent client; constructed at boot so DHT bootstrap + first tracker announces happen before the user picks a result. Reused across streams; destroyed on app exit. |
| `src/engine/stream.ts` | The streaming pipeline: metadata cache (load/save `.torrent` per info-hash), `client.add` (with `storeCacheSlots` RAM budget; `announce` merge for cached metadata, skipped for private torrents), **TV target resolution** (`StreamTarget`: auto / episode / exact file — `pickEpisodeFile()` matches SxxExx, 1xx and absolute numbering against FILE names; ambiguous multi-file packs flip to `awaitingFile` until `selectFile()` answers from the interactive picker), head-start + tail prefetch (`select(…, 3)` + `critical()`), server bring-up, stats at 4 Hz, teardown via `client.remove(torrent, { destroyStore: false })` so the client (and its warm DHT state) survives. |
| `src/engine/turbo-server.ts` | Turbo HTTP serving layer, including the 2.2.0 phone share: `remotePathAllowed()` gates every non-loopback request (nothing while sharing is off; only `/p/<token>` + `/p/<token>/media.<ext>` while it is on), `enableSharing()`/`disableSharing()` own the token, and the tokenized page is a self-contained mobile web player with a VLC hand-off. Core serving: RFC 7233 Range parsing (206/416, suffix + open-ended + multi-range→first), HEAD/OPTIONS, always `Content-Length` (never chunked), no redirects, direct alias routes (`/stream`, `/stream.<ext>`, `/<fileIndex>`), canonical `/webtorrent/<hash>/<path>`, DLNA marker, CORS, `setNoDelay`/keep-alive socket hygiene, dual-stack bind with `127.0.0.1` fallback, playhead tracking (`selectPlayhead()`: minimum position across *hot* readers, with a two-tier activity window so paused players and EOF probes cannot drag it), adaptive rolling window (priority-3 *stream selections* — exact-match removable, never clip the whole-file selection), stall escalation via `critical()`. Structurally typed against minimal interfaces so `tools/smoke-turbo.mjs` can exercise it with fakes. |
| `src/utils/lan.ts` | Pure LAN helpers: `pickLanAddress()` ranks interface IPv4s (192.168 → 172.16 → 10, physical names boosted, docker/utun/vEthernet demoted, loopback/link-local/IPv6 skipped), `isLoopbackAddress()`/`normaliseRemoteAddress()` unwrap `::ffff:` peers, `createShareToken()` makes the 8-char share path. |
| `src/utils/qr.ts` | Terminal QR rendering (`qrcode-terminal`, smallest EC level, half blocks with no ANSI) plus a per-URL memo so the 4 Hz stats tick never re-encodes. |
| `src/utils/playback.ts` | `planPlaybackReturn()` — pure post-playback routing. A finished episode lands on the episode grid with the cursor on the next one; an early stop keeps the pre-flight card. |
| `src/utils/players.ts` | Player detection (memoized per session), launch chain resolution, spawn + graceful kill. Per-player argv: VLC gets `--play-and-exit` (+ `--network-caching=10000` when no user flags), mpv gets buffering defaults (`--cache-secs=90`, `--demuxer-readahead-secs=90`, …) when no user flags, IINA gets `iina-cli --no-stdin --keep-running <url>` (URL positional — unknown `--flags` are forwarded to mpv and break loading, verified against iina-cli's source). User `player_flags` always override the injected defaults. |
| `src/utils/keep.ts` | `--keep` file rescue: collision-safe `rename()` with EXDEV copy+delete fallback. |
| `src/utils/log.ts` | Opt-in debug logger. Path resolution (`--debug[=<path>]`, `TORRENTIAL_DEBUG`, `TORRENTIAL_LOG`), append-only ISO-timestamped lines, truncation at 2 MB, and a hard "never throw, never touch stdout" contract so a broken path cannot corrupt the TUI or slow a stream tick. |
| `src/utils/state.ts` | `state.json`: recent-search history (20) and the last-watched episode per series (200 max). Pure, tolerant normalize/push/record helpers plus atomic write-then-rename persistence; corrupt files degrade to an empty state. |
| `src/utils/cache.ts` | Metadata-cache layout (`<cache>/meta/<infoHash>.torrent`) and boot pruning: drop entries older than 30 days, cap at 300 by mtime, never throw, dry-run mode for diagnostics. |
| `src/utils/sources.ts` | `--sources` flag parsing with aliases (`tpb` → `piratebay`…) and loud validation. |
| `src/utils/format.ts` | Size/speed/ETA formatting, quality parsing, table padding helpers. |
| `src/utils/tv.ts` | The episodic brain: `parseTvTitle()` regex battery (SxxExx, 1xx, 2x05, Season words, 2nd Season, absolute anime numbering, batch ranges, Complete Series), `toTvResult()` shaping, `buildSeriesIndex()` grouping (series → seasons → episodes + packs), `episodeQueries()` / `seasonQueries()` smart query generation, season/episode row builders for the TUI. |
| `src/utils/magnet.ts` | Magnet construction (with tracker list), parsing, `looksLikeTorrentId` for the paste-a-magnet UX. |
| `src/utils/http.ts` | `fetchText`/`fetchJson` with timeouts, browser-ish UA, friendly network errors. |
| `src/utils/ascii.ts` | Wordmark variants (ANSI Shadow / double-block / Calvin S), spinner + wave frames, gradient math. |
| `src/ui/*` | Screens (`SearchScreen`, `SeriesScreen`, `SeasonScreen`, `EpisodeScreen`, `DetailScreen`, `FilePickerScreen`, `StreamScreen`), animated components (`Logo`, `Spinner`, `WaveLine`, `ProgressBar`, `TextInput`, `ProviderChips`), hooks (`useTerminalSize`, `useTick`). |
| `src/ui/hooks/*` | Session logic pulled out of `App.tsx`: `useSearch` (provider aggregator, dedupe, supplemental hunts, status chips), `useStreamSession` (engine + player hand-off, phone share state, teardown), `usePreferences` (skin picker, `/theme`, `/mode`, session content mode). Callbacks travel through refs so in-flight searches/streams are never restarted by a re-render. |
| `src/webtorrent.d.ts` | Ambient typings for the exact webtorrent surface used. |

## Data flows

### Search (streaming, torlink-style)

`runSearch()` is an **async generator**. All enabled providers start
concurrently; each pushes events (`provider-start` → `results` →
`provider-done` | `provider-error`) into a queue the generator drains. The
React effect in `App.tsx` consumes the generator and updates state per event,
so rows appear the moment a source answers — no waiting for stragglers.
Per-provider timeouts are enforced by racing the provider promise; a failing
source only turns its status chip red.

Dedupe: info-hash when known (Pirate Bay, magnet-carrying Nyaa rows),
otherwise normalized-title + size. Every row is shaped at the aggregator
(`toTvResult`): episodic rows carry show/scope, generic (movie/junk) rows
pass through untagged. App accumulates everything into
`buildSeriesIndex()` — which only consumes the episodic rows — and derives
the tier views (series summaries → season rows → episode rows + pinned
packs) with `useMemo`. When a view looks thin, App fires a
**supplemental hunt** — `episodeQueries()` / `seasonQueries()` inject SxxExx
/ 1xx nomenclature and the merged rows live-update the open screen (hunt
keys are deduped per main search).

Magnet resolution strategy per provider:

- **Pirate Bay** — apibay.org returns info hashes; magnets are built locally
  with the tracker list. Zero extra requests.
- **Nyaa** — the magnet link is embedded in the results row HTML; extracted
  during the scrape. Zero extra requests.
- **1337x** — the search page only links detail pages. The magnet is fetched
  **lazily** when you open the detail card (memoized, retriable) so the
  results table stays instant.

### Streaming engine

Verified against webtorrent v3 (2.8.x has an upstream crash: hex-string
`infoHash` fed to uint8-util 2.x `arr2hex`; v3.0.x is required):

1. `EngineHost` owns one `WebTorrent` client for the whole session,
   constructed at CLI boot — DHT bootstrap is already warm when a magnet
   arrives.
2. Metadata fast path: `engine/stream.ts` derives the info-hash from the
   magnet (hex or base32 via `utils/magnet.ts`), looks for
   `cacheDir/meta/<hash>.torrent`, validates it with `parse-torrent`, and
   adds the torrent **from the cached file** when it matches (the public
   tracker roster is re-merged via the `announce` add option; skipped for
   private torrents). On fresh metadata the `.torrent` is saved back for
   next time.
3. `client.add(id, { path: cacheDir, deselect: true, storeCacheSlots })` —
   the torrent starts with **nothing selected**; `storeCacheSlots` sizes the
   in-memory piece cache from `ram_cache_mb`.
4. `torrent.on('metadata')` (raced against `metadata_timeout`) → resolve the
   `StreamTarget`: `episode` targets match the wanted SxxExx / absolute
   number against the parsed FILE names (`pickEpisodeFile`); `auto` plays a
   lone video file (or one that dwarfs the rest — a feature upload with
   samples) and hands genuine multi-file season packs to the interactive
   picker (`awaitingFile` + `files` in stats until `selectFile()` answers).
   The chosen file gets `file.select()` (whole file, priority 0) → **head-start**:
   `select(head, priority 3) + critical(head)` for the first
   `head_start_mb` (default 4 MB); **tail prefetch**: the same treatment for
   the last `tail_prefetch_mb` (default 2 MB — MP4 `moov`, MKV `Cues` and
   AVI `idx1` live there). Both run before the player opens a single
   connection.
5. Serving, two paths:
   - **turbo (default)** — `engine/turbo-server.ts` binds early (while the
     swarm is still being contacted, so port probing costs nothing) and is
     attached once the file is known. Every served Range updates a per-
     connection read position; the playhead is the minimum position across
     active connections (so an end-of-file index probe from VLC can't drag
     the window away). A 500 ms tick keeps a priority-3 **stream selection**
     window ahead of the playhead (sized `clamp(speed × window_secs, 8 MB,
     192 MB)`, moved only when it drifts by a quarter-window), estimates
     buffered-seconds from `torrent.bitfield` contiguity, and escalates with
     `critical()` on the next ~8 MB when the swarm falls behind. Stream
     selections are used because webtorrent removes them by exact match and
     never lets them clip other selections.
   - **`--no-turbo`** — webtorrent's built-in `client.createServer()` exactly
     as v1.1 shipped, with the route probe shortened to a 750 ms HEAD race.
6. Stats snapshot at 4 Hz (progress, speeds, peers, ETA, plus the turbo
   buffer-ahead estimate) plus event-driven phase changes; a quiet swarm
   (0 peers / no data for 25 s) escalates to a visible `⚠`.

### Phone hand-off

Pressing `l` (or `--phone`) never opens a second streaming path — it reuses the
turbo server and just changes who may talk to it and where the bytes go:

1. `StreamEngine.enablePhoneShare()` asks `utils/lan.ts` for the advertised
   IPv4 (unless `--lan-ip` pinned one), mints an 8-character token and hands both
   to `TurboServer.enableSharing()`.
2. `useStreamSession` closes the desktop player with the exit handler
   suppressed, then reports `{active, url, error}` to `StreamScreen`, which
   renders the QR from `utils/qr.ts`.
3. `GET /p/<token>` returns the mobile page; its `<video>` points at
   `/p/<token>/media.<ext>`. That route calls the same `serveMedia()` as every
   other consumer, so Range/206/416, HEAD, MIME and playhead tracking are
   unchanged — the phone's reads simply become the playhead, and the rolling
   piece window follows them.
4. The gate runs before routing: with no token, non-loopback peers get 404 on
   every route; with a token, only the page and its media route are visible.
   `l` again clears the token, and teardown drops it with the server.
   `--phone` additionally makes the server bind `0.0.0.0` first, so a machine
   without IPv6 never falls back to a loopback-only socket.

MKV/HEVC/AC3 cannot be decoded by mobile browsers, so the page carries
`intent://` (Android) and `vlc-x-callback://` (iOS) links, plus a copy-link
fallback. Nothing on the page offers a download or sets
`Content-Disposition` — it is a stream from beginning to end.

### Teardown

Three triggers converge on the same path: player process exit (binary
players only), `q` on the stream screen, and `Ctrl+C`/SIGINT.

```
--keep? move file → keep_directory   ← rename first (instant on POSIX even
                                        with open handles); retried after
                                        destroy when Windows locks blocked it
turbo.close() | server.destroy()   client.remove(torrent, {destroyStore:false})
        └────────────┐                  └──────────────────┬───────────────┘
                     ▼                                     ▼
              (up to 1.5 s grace)         store handles closed (files kept;
                                          wipe happens below); the client +
                                          its warm DHT state survive for the
                                          next stream of the session
                                          → wipe cacheDir/<torrent.name>
                                            (path-escape guarded)  → App.exit()
```

On app exit (`Ctrl+C`/SIGINT), `App.shutdown` additionally destroys the
`EngineHost` client. `destroyStore: false` closes the store handles without
deleting data — Windows can then rename/`rm` the files, and `keep_cache`
semantics are preserved.

Rescuing *before* the destroy gauntlet matters: the destroy timeouts can add
up to ~5 s, and a fast teardown (or process exit) must never cost the user
their kept movie. The source path and progress are snapshotted before destroy
nulls the refs. The engine's `stopped` event (and `stop()` return value)
carries the rescued `KeptFile`, which the App renders as a `saved → …` line
on the results and search screens.

System openers (`xdg-open`/`open`/`start`) exit immediately after handing the
URL to the OS, so they are marked *detached*: teardown is driven by the `q`
key instead, and the UI says so. IINA is the exception among GUI players:
`iina-cli --keep-running` stays alive until the IINA *app* quits, so teardown
waits for that (press `q` in the TUI to force it earlier).

## Design decisions worth knowing

- **Ink v5** removed `Box#backgroundColor`; row highlighting is applied per
  `Text` span, and table rows are single nested-`Text` runs so column padding
  is exact string concatenation (immune to flex spacing quirks).
- **The engine is version-pinned** (`webtorrent@^3.0.21`) because of the
  upstream 2.8.x crash described above; the ambient `.d.ts` documents the
  exact API surface used. The turbo rolling window drives webtorrent's
  *stream selection* internals (`torrent._select/_deselect`) behind a runtime
  guard with a no-op fallback — a future webtorrent without them degrades to
  plain serving instead of crashing.
- **One `listen()` per built-in server**: port availability is probed with a
  throwaway `net.createServer` first, avoiding the duplicate-handler bug that
  a naive retry-on-EADDRINUSE would cause. The turbo server binds through a
  candidate ladder instead (dual-stack `::` first — or `0.0.0.0` when
  `--phone` asks for LAN-first binding — then `127.0.0.1`; ports +0…+10; then
  an OS-assigned one).
- **The turbo server is HTTP-dialect-strict** so the "everything with an
  HTTP URL box" compatibility bar holds: always `Content-Length` (no chunked
  encoding — DLNA renderers and smart TVs choke on it), never a redirect for
  media (dumb clients drop `Range` on the second hop), extension-bearing
  URLs (WMP sniffs the format from the path), `416` with
  `Content-Range: bytes */size` so players can reset their offsets, and
  byte-identical headers for HEAD. `tools/smoke-turbo.mjs` verifies the
  whole matrix with real curl against a fake torrent — no swarm needed.
- **Cache wipe is conservative**: only the torrent's own subfolder inside
  `cache_directory`, only when the resolved path stays inside the cache root.
  The metadata cache lives in `cache_directory/meta/` — outside the per-
  torrent subfolders, so per-stream wipes never erase it (`--clear-cache`
  does, by design).
- **Per-source search failures are demoted, not bannered**: a Cloudflare 403
  from one indexer shows a compact `✗ <source> blocked` chip (category word
  from `shortProviderError`), with the full message moved to a dim footnote
  under the results table. Only an all-sources failure gets the big red block.

## Tests

`test/*.test.ts` uses Node's built-in runner through `tsx` (`npm test`; the
file list is expanded in `tools/run-tests.mjs` so Windows works too). It covers
the TV parser and series index, the classifier vote, RFC 7233 Range parsing,
playhead selection (hot vs. idle readers), config validation warnings, the
history/last-watched ledger, metadata-cache pruning and the doctor report.

Behavioural smokes stay in `tools/`: `smoke-turbo.mjs` (HTTP matrix against
fake torrents), `classify-smoke.mjs`, `tv-smoke.mjs`, `render-smoke.tsx`,
`tv-render.mjs`, and `app-smoke.tsx`, which mounts the real `App` headlessly
and asserts history recall plus the `state.json` round-trip.

CI runs both sets on Linux/macOS/Windows × Node 22/24. A `v*` tag publishes to
npm with provenance and attaches the tarball to the GitHub release.

## Dependency & security notes

Runtime dependencies stay deliberately few. 2.2.0 adds exactly one:
`qrcode-terminal` (Apache-2.0, pure JS, **no transitive dependencies and no
install scripts**) which only draws the QR string. The mobile page it points at
is hand-written HTML/CSS with ~30 lines of inline JS — it ships no framework and
makes no external requests, so the phone needs nothing installed.

`package.json` carries two fields that must not be removed:

- **`overrides.ip`** — the `ip` package is abandoned upstream with an
  unpatched high-severity advisory (GHSA-2p57-rm9w-gvfp: `isPublic`
  mis-classifies non-canonical addresses; no fixed release exists, and npm's
  `audit fix --force` "fix" would downgrade webtorrent to 0.7.x). It is aliased
  to `@eggjs/ip`, a maintained drop-in built on `net.isIP`/`net.SocketAddress`.
  If a future webtorrent release replaces `ip` upstream, drop the override.
- **`allowScripts`** — npm ≥ 12 skips dependency install scripts unless
  approved. The approved entries are the tooling that genuinely needs them:
  `node-datachannel` (prebuilt WebRTC binary — without it streaming cannot
  connect), `utp-native`, `bufferutil`, `utf-8-validate` (node-gyp bindings)
  and `esbuild` (tsx's installer). `ip-set` is explicitly denied: its published
  `preinstall` (`npx only-allow pnpm`) is an accidentally shipped repo guard
  that would hard-fail every npm install.

When an upgrade bumps a pinned native dependency, npm re-warns; review and
re-approve with `npm install-scripts approve <pkg>` (`npm install-scripts ls`
shows what is pending).

## Adding a provider

```ts
export const myProvider: Provider = {
  info: { id: 'my', label: 'mysite', host: 'mysite.example' },
  async search(query, opts) {
    const html = await fetchText(`https://mysite.example?q=${encodeURIComponent(query)}`,
      { timeoutMs: opts.timeoutMs })
    const $ = cheerio.load(html)
    // … map rows to SearchResult …
    return results.map(r => ({ ...r, quality: parseQuality(r.title) }))
  }
}
```

Register it in `providers/index.ts` (`ALL_PROVIDERS`), add a short label +
accent color in `constants.ts` (`PROVIDER_SHORT`, `PROVIDER_COLORS`), and
include the id in the default `providers` config array. Everything else —
streaming events, dedupe, chips, table, detail, lazy magnets — works
automatically.
