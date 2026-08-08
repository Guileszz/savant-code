# Single-Agent ECHO Protocol

**For single-agent sessions on this repository, this file is the protocol marker.**

The full single-agent ECHO protocol is maintained at:

```text
dev/nova/specs/echo-v0.1.2-single-agent.md
```

Its machine-readable configuration is `single_agent.protocol` in
`protocol.config.yaml` (`version: 0.1.2-single-agent`, `strict_mode: true`).
Read that file completely before any work session. Do not use `ECHO.md` (Savant-Code harness protocol) for single-agent
governance.

See `FREEREADME.md` for the full session directive.

## Signing Policy

Agents sign every authored/modified document (FIDs, session summaries, CHANGELOG entries, knowledge files) as
**`Savant`** only — never with any product/harness/assistant name. See "Document Signing &
Attribution" in `dev/nova/specs/echo-v0.1.2-single-agent.md`.
