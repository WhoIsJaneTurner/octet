# Octet desktop shell (scaffold)

**Status: unbuilt and untested.** Electron is a large dependency and could not be installed where this was written, so `main.cjs` has never been run. It is a plain-JavaScript sketch of the design in [hardening-and-gaps.md](../../docs/hardening-and-gaps.md) section 6.2. Treat it as a starting point, not a feature.

This folder is deliberately **not** a pnpm workspace member (`pnpm-workspace.yaml` excludes `packages/desktop`), so `pnpm install` at the repo root neither installs Electron nor changes the lockfile. It has its own `package.json`.

## What the code does

1. Generates an API token in memory (`crypto.randomBytes`), never written to disk.
2. Spawns the daemon with system Node: `node packages/daemon/src/main.ts --port=0`, with the token in `OCTET_TOKEN`. The daemon takes the token, removes it from its own environment so agents never inherit it, and serves the UI with the token injected, as it does in a browser.
3. Waits for the daemon's `listening on http://127.0.0.1:<port>/` line, then opens a window on that URL. The window has context isolation on, Node integration off and the sandbox on; links to other origins open in the default browser.
4. On quit it sends the daemon SIGTERM, which releases the daemon lock file (`<data>/daemon.lock`). If another daemon already owns the database, the daemon exits with a message naming its pid and port, and the shell shows that message instead of a window.

## Trying it (untested)

```bash
pnpm ui:build                              # the daemon serves packages/ui/dist
cd packages/desktop
pnpm install --ignore-workspace            # installs Electron here only
OCTET_NODE=$(command -v node) pnpm start   # Node 24+ is required by the daemon
```

## What remains before this is a product

- **Run it.** Nothing here has executed. Expect fixes.
- **Node.** The daemon runs TypeScript directly with Node 24 type stripping and uses `node:sqlite`. The shell relies on a system Node 24 (found through a login shell, because a Finder-launched app has no shell PATH). A distributable app needs either a bundled Node 24, or the daemon compiled to JavaScript (for example with esbuild) and run under Electron's own Node if that version has `node:sqlite`. Check before relying on `ELECTRON_RUN_AS_NODE`.
- **Packaging.** Add electron-builder or Electron Forge, and decide how `packages/*` and `ui/dist` are laid out inside the app bundle (the daemon locates the UI relative to its own source path).
- **Signing and notarization (macOS).** Needs an Apple Developer ID certificate, the hardened runtime with entitlements, and notarization through `notarytool`. Without them Gatekeeper blocks the app on other machines. This costs money and a few days of fiddling.
- **Updates.** Needs signed builds and an update feed (electron-updater with a release host, or `update.electronjs.org` for public GitHub releases). Not started.
- **Agents and credentials.** The app starts the daemon with the user's environment, so `git`, `gh`, `claude` and the SSH keys must be found exactly as they are from a terminal. A Finder launch has a smaller environment; verify, and consider capturing the login-shell environment.
- **Security review.** The renderer is a normal web page talking to a loopback server with a bearer token. That is fine for one user on one machine, but review the window options, the navigation guards and the Content-Security-Policy before shipping to anyone else.
