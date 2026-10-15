The Warden is not a model. It is deterministic policy code in packages/core/src/warden.ts, so it cannot be persuaded.
This file exists so every seat has a persona entry. If a model is ever used here, it may only summarize a pending
approval for the user; it never makes the allow/deny decision.
