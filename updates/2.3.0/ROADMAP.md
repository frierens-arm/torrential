# 2.4 roadmap — what 2.3.0 deliberately left out

The 2.3.0 review surfaced four feature candidates and two maintainability
items. They were not shipped with the hardening release because each one adds
user-facing surface and needs its own testing pass (and, for subtitles, a
decision about sidecars vs. an external service).

## Features

### Sidecar subtitles (`S01E02.mkv` → `S01E02.srt`)
Detect subtitle files inside a torrent that is already being streamed, select
their pieces (they are tiny), serve them from the turbo server, and hand them
to the player (`--sub-file=` for mpv, `:sub-file` for VLC, `<track>` on the
phone page).

Why it needs its own release: the engine currently selects exactly one video
file, so this is the first change to the "one active file" assumption in
`engine/stream.ts`, and the phone page needs a second range-served resource.

### Resume position per episode
`state.json` already remembers the last-watched episode per series. Adding a
playback offset means capturing the turbo playhead at teardown (the server
already tracks it per connection) and offering "resume at 12:34" on the
pre-flight card.

Why it needs its own release: it touches the teardown ordering that 2.2.0
established for phone hand-off, and a stale offset is worse than none — it
needs a sanity rule (same file, ≥90% watched → start over).

### Phone playhead in the TUI
Tourbo already exposes `remoteConnections`; showing `phone: 12:34 / 45:00`
would make the hand-off visible and turn "buffers forever" into a number you
can read.

Why it needs its own release: it requires the turbo snapshot to carry a
position, which is a change to the stats contract every screen consumes.

### Non-interactive output (`--json`, `--no-tui`)
Make the hunt scriptable: emit merged results as JSON and skip Ink.

Why it needs its own release: it is a second output surface, so it needs its
own tests and a stability promise for the schema.

## Maintainability

### Lint / format gate
No ESLint or formatter config exists (there is already an
`eslint-disable-next-line` in `src/ui/App.tsx`). A dependency-light linter
(Biome or oxlint) plus one CI step would catch unused imports and drift that
plain `tsc` misses. Deferred because adopting one reformats the whole tree in
one commit and would bury this release's diff.

### `noUncheckedIndexedAccess`
The UI indexes `rows[selected]` in every screen. Turning the flag on module by
module (start with `utils/`) would convert a class of windowed-list crashes
into compile errors. Deferred because it is only worth doing alongside the
linter adoption so the mechanical fixes happen once.
