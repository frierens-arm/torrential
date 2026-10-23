# Configuration reference

torrential reads a single JSON file, created with defaults on first run:

| Platform | Path |
|---|---|
| Linux / macOS (default) | `~/.config/torrential/config.json` |
| Linux / macOS (XDG set) | `$XDG_CONFIG_HOME/torrential/config.json` |
| Windows | `%APPDATA%\torrential\config.json` |
| Any (CLI override) | `torrential --config /path/to/file.json` |

Cache location (used for piece storage while streaming):

| Platform | Default `cache_directory` |
|---|---|
| Linux / macOS | `~/.cache/torrential` (honors `$XDG_CACHE_HOME`) |
| Windows | `%LOCALAPPDATA%\torrential\cache` |

Invalid values are never fatal: torrential reports them as a `⚠` banner in the
TUI and falls back to the matching default. Unknown keys produce a warning too.

## Fields

### `default_player` — string, default `"system"`

Who receives the stream URL.

| Value | Behavior |
|---|---|
| `"system"` | OS URL handler: `xdg-open` (Linux), `open` (macOS), `start` (Windows). Detached — close the player yourself and press `q` in torrential when done. |
| `"mpv"` / `"vlc"` / `"iina"` | Launch that player directly; its exit automatically stops the engine. |
| `"/usr/bin/mpv"` (any path) | Launch that binary with the URL as first argument plus `player_flags`. |

When the preferred player is missing or fails to spawn, the `player_fallbacks`
chain is tried in order. If nothing launches, the stream URL is displayed so
you can open it manually.

The `--player` CLI flag overrides this for one session.

### `player_flags` — string[], default `[]`

Extra command-line flags passed to **binary** players (not used for
`"system"`). Examples:

```json
{ "player_flags": ["--force-window=immediate", "--cache=yes"] }
```

torrential automatically appends `--play-and-exit` for VLC (so closing
playback tears down the stream) and `--no-stdin --keep-running` for `iina-cli`
(verified against iina-cli's own help: the URL must be positional, and
`--keep-running` keeps the CLI alive until the IINA app quits — which is the
exit event that stops our engine).

### `player_fallbacks` — string[], default `["mpv", "vlc", "iina"]`

Ordered fallback chain of player names. Each is only used if it is actually
installed (probed via `PATH`, `PATHEXT`, and standard install locations such
as `/Applications/VLC.app/...` or `C:\Program Files\VideoLAN\VLC\vlc.exe`).

### `cache_directory` — string, default per-OS (see table above)

Where the WebTorrent piece store writes while streaming. Each torrent gets its
own subfolder named after the torrent. On teardown (player closed, `q`, or
`Ctrl+C`) that subfolder is wiped — the whole directory is never blindly
deleted, and the engine refuses to wipe anything that resolves outside the
cache root. `--clear-cache` (CLI) wipes the entire directory once at startup.

### `port` — number, default `8000`

Preferred port for the local streaming server (bound to `127.0.0.1` only).
Before listening, torrential probes the port and moves up to ten ports higher
when busy (`8001`, `8002`, …); if all are taken the OS assigns an ephemeral
one. The effective port is shown on the stream screen as the `endpoint` URL.
`--port` overrides per session.

### `keep_cache` — boolean, default `false`

Keep the cached pieces after exit instead of wiping them. Useful on slow
connections when you plan to re-watch or finish a download later with another
tool. `--keep-cache` (CLI) overrides per session.

### `keep_directory` — string, default per-OS

Where `--keep` / `-k` parks the streamed file when playback ends:

| Platform | Default `keep_directory` |
|---|---|
| macOS | `~/Movies/torrential` |
| Linux | `~/Videos/torrential` |
| Windows | `%USERPROFILE%\Videos\torrential` |

The folder is created on demand, name collisions get a ` (2)` suffix, and
cross-volume moves (cache and movies on different disks) fall back to
copy+delete. A partially-downloaded file is kept too — the `saved → …` line
reports how much of it arrived. Overrides: `--keep=<dir>` and
`--keep-dir <dir>` (CLI).

Note the difference to `keep_cache`: `--keep` **moves the finished movie out**
and still wipes the throwaway cache; `--keep-cache` leaves the raw piece store
untouched where it is.

### `max_results` — number, default `40` (5–250)

Cap on the merged, seed-sorted results table.

### `providers` — string[], default `["piratebay", "1337x", "nyaa"]`

Which indexers are queried. Any subset; results are merged and deduped by
info-hash (falling back to normalized title + size), then sorted by seeders.
One failing source never poisons the others — it shows a compact `✗ blocked`
chip with the full reason in a dim footnote under the results.

The `--sources tpb,nyaa` CLI flag filters providers for one session (aliases:
`tpb`/`piratebay`, `1337x`/`1337`/`x1337`, `nyaa`).

### `metadata_timeout` — number, default `45` (seconds, 5–600)

How long to wait for torrent metadata before declaring the swarm dead and
surfacing an error with hints.

### `search_timeout` — number, default `12` (seconds, 3–120)

Per-provider deadline. One slow or blocked source never stalls the others;
its chip simply turns `✗` with the reason.

## Content mode

### `mode` — string, default `"auto"`

What the hunt targets:

| Value | Behavior |
|---|---|
| `"auto"` | Shows + movies: indexers answer with everything; rows are tagged by shape |
| `"tv"` | Episodic hunts — 1337x scrapes its TV category (`/category-search/…/TV/`) |
| `"movies"` | Movie hunts — 1337x uses the plain catalogue search (`/search/…/`) |

Rows are **tagged, not filtered**, in this release: the mode picks the
provider routes (and movie rows now survive the aggregator as generic rows),
while mode-aware filtering of the result lists lands in the next roadmap
step. Persisted by `/mode <auto|tv|movies>` in the search bar; `--mode
<name>` overrides for one session. Unknown values warn and fall back to
`"auto"` — the same graceful handling as an unknown `theme`.

## Speed engine (v1.2)

These keys tune the startup and playback accelerations. The defaults are
already sensible for most networks — you rarely need to touch them.

### `turbo` — boolean, default `true`

Turbo serving: torrential hosts the media through its own HTTP layer that
**tracks the player's playhead** and continuously re-prioritizes which swarm
pieces are downloaded next (a rolling window of ~30 seconds of video ahead,
plus hard-priority escalation when the swarm falls behind). This concentrates
scarce bandwidth on the frames the player needs next instead of spreading it
across the whole file.

The turbo server speaks the exact same HTTP dialect as the built-in one —
`Range`/206/416, HEAD, OPTIONS, no chunked encoding, no redirects, direct
alias routes, correct `Content-Type` and `Content-Length` — so every player
that worked before keeps working: mpv, VLC, IINA, Kodi, PotPlayer, MPC-HC,
Windows Media Player, browsers, and DLNA-style renderers. Set it to `false`
(or pass `--no-turbo`) to fall back to webtorrent's plain built-in server; if
the turbo server cannot bind a port, torrential falls back automatically.

### `max_conns` — number, default `200` (5–2000)

Maximum peer connections per torrent. Higher values buy more aggregate
bandwidth on swarms with many slow peers (typical for slow networks) at a
cost of a few sockets. webtorrent's own default is 55.

### `ram_cache_mb` — number, default `256` (0–8192)

RAM budget, in megabytes, for the in-memory piece cache that sits in front
of the disk store. Players re-read constantly (container headers, seeks,
rewinds) — RAM hits avoid the disk round-trip. `0` disables it (webtorrent
defaults to ~20 pieces).

### `upload_limit_kbps` — number, default `0` (0 = unlimited)

Cap for seeding upload, in kilobits per second. On **asymmetric** links
(ADSL/cable), an unthrottled upload can saturate the uplink and starve the
TCP ACKs your downloads depend on — capping it around 60–70% of your uplink
often *raises* download speed. Don't set it to zero throughput: BitTorrent's
tit-for-tat needs some upload for reciprocity.

### `head_start_mb` — number, default `4` (0–512)

Megabytes fetched from the file's head (marked critical) the moment metadata
lands — before the player opens any connection. This is the first-frame path.

### `tail_prefetch_mb` — number, default `2` (0–512)

Megabytes fetched from the file's **end** in parallel with the head. MP4
files written without faststart keep their `moov` index at the tail, MKV
often keeps `Cues` there, and AVI keeps `idx1` — players must read these
before playback starts, and on a slow link that used to mean a second,
serial wait. `0` disables it.

### `window_secs` — number, default `30` (5–600)

Target size of the turbo rolling window, in seconds of video ahead of the
playhead. The window adapts to measured swarm speed (clamped to 8–192 MB).

## Appearance

### `theme` — string, default `"rain"`

Active UI skin. Built-in skins:

| id | look |
|----|------|
| `rain` | violet → cyan downpour (default) |
| `matrix` | phosphor-green CRT |
| `sunset` | warm orange → pink dusk |
| `ocean` | deep blue tide |
| `ember` | crimson coals |
| `candy` | pastel sugar |
| `amber` | retro amber terminal |
| `mono` | paper-white minimal |

The easiest way to change it is from inside the app — type `/theme` in the
search bar for a live color-chart picker, then `/theme <name>` to apply AND
save. `/skin` is an alias; friendly aliases (`red`, `blue`, `green`, `pink`,
`gold`, `default`, …) resolve to the skins above. For one-off sessions use
`--theme <name>` / `--skin <name>` (CLI wins over the file; nothing is
persisted). Unknown names fall back to `rain` with a warning.

## Resilience

### `x1337_mirrors` — string array, default `[]`

Extra 1337x mirrors tried **before** the built-in list
(`1337x.to`, `www.1377x.to`, `www.1337xx.to`, `1337x.st`, `x1337x.ws`). Use
this when every built-in domain is blocked on your network (ISP court-blocks
and Cloudflare both look the same from the search screen):

```json
{
  "x1337_mirrors": [
    "https://unblockit.example/1337x.to",
    "https://proxy.example/search?q={query}"
  ]
}
```

Two shapes are accepted:

- **plain origin** — the standard `/search/<query>/1/` path is appended, so
  reverse-proxy mirrors (unblockit-style) work as-is;
- **`{query}` template** — for sites whose search URL differs; `{query}` is
  replaced with the URL-encoded search term.

Before any mirror is tried, a DNS-level failure (the signature of ISP
blocking) automatically retries over **DNS-over-HTTPS** (Cloudflare
`1.1.1.1`, then Google `8.8.8.8`) and connects to the resolved IPs directly
with correct SNI. If every mirror still fails, the error names the reason
per mirror and suggests a VPN, `x1337_mirrors`, or `--sources tpb,nyaa`.
Note: a Cloudflare "Just a moment…" interstitial is detected and reported as
such — no scraper gets through it; that is what VPNs and mirrors are for.

## Precedence

```
CLI flags  >  config file  >  built-in defaults
```

## A tuned example

Slow ADSL-style link (8 Mbps down / 768 kbps up):

```json
{
  "default_player": "mpv",
  "player_fallbacks": ["vlc", "iina"],
  "cache_directory": "/data/torrential-cache",
  "keep_directory": "/data/movies/torrential",
  "port": 8000,
  "keep_cache": false,
  "max_results": 60,
  "providers": ["piratebay", "1337x", "nyaa"],
  "metadata_timeout": 60,
  "search_timeout": 10,
  "turbo": true,
  "max_conns": 250,
  "ram_cache_mb": 512,
  "upload_limit_kbps": 550,
  "head_start_mb": 4,
  "tail_prefetch_mb": 2,
  "window_secs": 45
}
```

`player_flags` still wins over everything: when it is non-empty, torrential
stops injecting its own per-player buffering defaults (`--cache-secs=90 …`
for mpv, `--network-caching=10000` for VLC) and passes yours verbatim.
