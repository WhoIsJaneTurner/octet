# Octet

An eight-seat council of AI coding agents, run locally: Chair, Marshal, Architect, Scout, Engineer, Reviewer, Warden, Courier.

```bash
pnpm install
cp identities.example.toml ~/.config/octet/identities.toml   # then edit
pnpm octet identity doctor
pnpm octet project add myapp ~/code/myapp --identity work
pnpm octet goal new myapp "Add rate limiting"
pnpm octet bead add <goal> "Middleware" --brief "..."
pnpm octet bead run <bead>
```

Requires Node 24+. Git identity is per project and never defaults; the Warden refuses pushes to a remote the project's account doesn't own.
Run `pnpm test` and `pnpm typecheck`.

Also: `pnpm octet doctor` checks your setup, `pnpm octet install` puts `octet` in `~/.local/bin`, and `pnpm octet completion zsh|bash` prints shell completion. `pnpm check` runs the source hygiene check. `OCTET_BROWSER=1 pnpm test` adds a headless-Chrome smoke test of the UI (needs Chrome and `pnpm ui:build`). The Electron shell in `packages/desktop` is an unbuilt scaffold.
