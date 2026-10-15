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
