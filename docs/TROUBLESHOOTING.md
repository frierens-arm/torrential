# Troubleshooting

Start with `torrential --doctor`. It checks the runtime, config, cache,
players, stream port and every indexer, and prints a report you can paste into
a bug report. Add `--debug` to write a log next to the cache, then include the
last few dozen lines of `<cache dir>/torrential.log`.

## Install

### `ReferenceError: File is not defined` (often after `EBADENGINE` warnings)

You are on Node 18 or 20. `webtorrent@3` and `undici@7` need **Node ≥ 22** —
the stack trace never mentions your runtime:

```
node_modules/undici/lib/web/webidl/index.js:537
webidl.is.File = webidl.util.MakeTypeAssertion(File)
                                               ^
ReferenceError: File is not defined
```

Upgrade with [nvm](https://github.com/nvm-sh/nvm) (`nvm install 22 && nvm use 22`),
[fnm](https://github.com/Schniz/fnm), or `brew install node@22`, then rerun
`npm install && npm run build`. The repo's `.npmrc` sets `engine-strict=true`,
so a too-old Node now fails at install time instead.

### `npm ERR! code EACCES` / `permission denied`

`npm link` or `npm install -g` is writing into a root-owned global prefix
(`/usr/local`, or Homebrew's Node prefix). **Do not use `sudo`** — it leaves
root-owned files behind and makes the next install fail differently. Point npm
at a prefix you own:

```bash
mkdir -p ~/.npm-global
npm config set prefix ~/.npm-global
echo 'export PATH="$HOME/.npm-global/bin:$PATH"' >> ~/.zshrc   # ~/.bashrc on bash
source ~/.zshrc

cd torrential && npm link
torrential --version
```

Other options: run from the checkout with `node dist/cli.js` (no global
install, no config changes), or fix a previous `sudo` install with
`sudo chown -R "$(id -u):$(id -g)" "$(npm config get prefix)/lib/node_modules" "$(npm config get prefix)/bin"`.

If `./dist/cli.js` itself says permission denied, the executable bit is
missing: `chmod +x dist/cli.js`, or prefix it with `node`.

## Runtime

| Symptom | What it means / what to do |
|---|---|
| `✗ 1337x blocked` chip, dim `⚠ 1337x: … (HTTP 403)` | Cloudflare challenge, common on VPN/datacenter IPs. Other sources are unaffected; retry, toggle the VPN, or `--sources tpb,nyaa`. |
| `--doctor` reports a failing indexer | That source is blocked or broken on your network right now. Use `--sources` to drop it, or a VPN/mirror for 1337x. |
| `no metadata after 45s — swarm looks dead` | Nobody is seeding. Pick a result with more seeders (the SEED column is colour-coded; red = dead). |
| Playback stalls at 0% | Rare swarm hiccup: press `q` and retry, or pick a better-seeded release. Check `⚠ warnings` and `buffer ≈ Ns ahead`. |
| `could not start the local stream server` | Port range occupied — set `port` in config; torrential probes nearby ports automatically. |
| `no player found — open the endpoint above` | Install mpv/VLC, or set `default_player` / `--player`. `--list-players` shows what was detected. |
| `system default` opened my browser | That is the OS URL handler. For a real player: `torrential -df mpv` (or `-df iina`). |
| IINA says it cannot open the file | Install the CLI (IINA menu → Install CLI Tool) and quit IINA when done to trigger teardown. |
| A movie-heavy search opened the series view | The auto router saw more episode-ish rows. Run with `--mode movies` (or `/mode movies`) and search again. |
| A movie never appears in the series list | Expected in `tv` mode — the strict filter drops non-episodic rows. Use `auto` or `movies`. |
| Want the old streaming behavior | `--no-turbo` (or `"turbo": false`) restores webtorrent's built-in server. |

## Still stuck?

Reproduce with a log and open an issue:

```bash
torrential --doctor
torrential --debug "the show"      # then reproduce
```

The log lives at `<cache dir>/torrential.log` — `~/.cache/torrential` on
Linux/macOS (or `$XDG_CACHE_HOME/torrential`), `%LOCALAPPDATA%\torrential\cache`
on Windows.
