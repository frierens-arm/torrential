# torrential 2.3.0 — a safer, faster hunt

This folder tracks the release that follows 2.2.0 (phone streaming). 2.3.0 is a
hardening release: no new surface area, every change makes an existing feature
honest, cheaper, or testable.

## What shipped

| # | Item | Where |
|---|---|---|
| 1 | `max_results` actually caps the merged table | `src/ui/hooks/useSearch.ts`, `docs/CONFIG.md` |
| 2 | `@types/node` bumped to 22 to match `engines` | `package.json` |
| 3 | `src/ui/hooks.ts` folded into `src/ui/hooks/useTerminal.ts` | `src/ui/**` |
| 4 | Dead 1.3.x verification scripts removed | `tools/` |
| 5 | Search cancellation reaches the network (`AbortSignal`) | `useSearch` → `runSearch` → `fetchText` |
| 6 | Tests for players, `--sources`, slash commands, mirror URLs | `test/players.test.ts` + 3 more |
| 7 | One bounded retry for transient provider failures | `src/providers/index.ts` |
| 8 | Version-drift guard (`version.ts` ↔ `package.json` ↔ `CHANGELOG.md`) | `test/version.test.ts` |
| 14 | Dependency audit job + Dependabot | `.github/workflows/ci.yml`, `.github/dependabot.yml` |

## Notes on the two behavioural changes

**Cancellation.** Before this release, abandoning a search (typing a new query,
switching `/mode`, quitting) left every scrape running until `search_timeout`;
the results were discarded, but the indexers still saw the traffic. The signal
now travels the whole way down, so abandoned requests are dropped, and a hunt
started for a previous query is aborted rather than racing the new one.

**Retry.** One retry, 250 ms apart, and only for genuinely transient failures.
A Cloudflare block, a timeout, or a cancellation is a verdict — retrying those
costs another request and teaches nothing.

## Verification

```bash
npm run typecheck
npm test
npm run build
npm run smoke
```

CI runs the same set on Linux/macOS/Windows × Node 22/24, plus the new
`dependency audit` job (runtime deps only, `--audit-level=high`).

## Deferred to 2.4

See [ROADMAP.md](ROADMAP.md) for the four feature candidates from the same
review that were *not* shipped here, with the reason each one needs its own
release.
