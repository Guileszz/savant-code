<!-- markdownlint-disable MD013 -->
# Features

**Everything you need for AI-assisted coding with structural quality guarantees.**

---

## Multi-Agent Orchestration

Ten canonical agents coordinate through ECHO with explicit separation of duties. Child agents receive only their authorized tool subset through strict allowlist filtering. Parallel agent work supports exploration, research, implementation, and independent review.

---

## ECHO Perfection Loop

Every code change follows a formal Finite State Machine:

1. **RED** — Identify ALL failures and issues with evidence
2. **GREEN** — Implement minimal, surgical changes
3. **AUDIT** — Independent verification by a separate agent
4. **ADVERSARIAL** — Read-only Adversary refutes Verifier findings, re-audits
   unevidenced PASSes, and resolves citations — its verdicts override
5. **SELF-CORRECT** — Fix any blockers found during audit
6. **COMPLETE** — Document results, archive tracking

No code is written without a plan. No plan is accepted without audit. No audit passes without evidence.

---

## Tool Permission Boundaries

Each agent gets exactly the tools it needs via strict allowlist filtering. Detective gets read-only access. Forge gets write access. Thinker gets sequential thinking. No agent has more power than its role allows.

---

## Context Compaction

Four-layer progressive auto-compaction keeps large repositories within model limits. Success is silent, failures are surfaced. Sessions can run through massive codebases without hitting context limits.

---

## Checkpoint and Rewind

Each user turn can persist the pre-edit content of every first-touched file, including subagent writes. `/rewind` supports:

- **Code only** — restore files while keeping the conversation
- **Conversation only** — restore the transcript boundary without changing files
- **Both** — restore code and conversation together
- **Fork** — restore the selected turn into a fresh chat

Retention is bounded to the most recent 20 turns. No Git repository is required.

---

## Fail-Closed Streaming

Incomplete or malformed tool calls are rejected, not coerced. Stale-fragment replacement for placeholder arguments. Tool errors, cancellation, retry, and child-agent failures are surfaced rather than silently treated as success.

---

## Provider Flexibility

Works with multiple inference providers:

- **Ollama** — Local-first, free, no API key required
- **OpenRouter** — Multi-provider gateway (**default boot provider**; the free
  tier `openrouter/free` is the boot default, and any `openrouter/` model slug
  routes to `https://openrouter.ai/api/v1` with the resolved key)
- **OpenCode Go** — Hosted gateway
- **TokenHarbor** — OpenAI-compatible hosted gateway at `https://tokenharbor.ai/v1`
- **TokenRouter** — Multi-provider gateway
- **NVIDIA NIM** — NVIDIA-hosted inference
- **CommandCode** — OpenAI-compatible hosted inference
- **Cloudflare** — Env-only gateway (Workers AI); requires `CLOUDFLARE_API_TOKEN`
  + `CLOUDFLARE_ACCOUNT_ID`, not in the `/provider` picker
- **Custom endpoint** — Any OpenAI-compatible API

Gateway model context lengths can be resolved from the live catalog. In
BYOK/direct mode (`DIRECT_PROVIDER` or `INFERENCE_BASE_URL` set) every backend
call is short-circuited — inference routes straight to the configured endpoint
(FID-2026-0806-009/010).

---

## Headless / Non-Interactive Mode

`--print` runs a single prompt without the TUI and prints the final answer to
stdout (FID-2026-0806-011):

- `savant-code --print "refactor the error handling"` — run one prompt
- Exit codes: `0` success, `1` error or timeout, `2` usage error
- When stdin is piped or the environment is CI, the CLI auto-enters headless
  mode and uses stdin as the prompt
- `SAVANT_CODE_RUN_TIMEOUT_MS` (default 10 minutes) bounds hung runs; the
  headless client never blocks on interactive `ask_user`
- Output is ANSI-stripped when piped, so results stay script-friendly

---

## Consent-Gated Auto-Update

The launcher never stops a running session (FID-2026-0806-014):

- A newer version is staged and a pending-update marker is written
- The update is applied on the **next launch** after an interactive y/N prompt
- Non-TTY launches defer the prompt
- `SAVANT_CODE_NO_AUTO_UPDATE=1` opts out entirely

---

## Deep Research

The Researcher role ships a mechanical `deep_research` tool:

- Multi-query web research with concurrency limits
- URL dedup and domain scoring
- Citations and graceful degradation
- Pure search facade — no second LLM

---

## GitHub Integration

A read-only GitHub helper connects to the official MCP server for:

- PR/issue/CI review
- Code search
- Secret scanning
- Audit trail

Requires `SAVANT_CODE_GITHUB_TOKEN` environment variable.

---

## Database Helper

Four native tools with adapter-enforced safety:

- `list_tables` — List all tables in the database
- `describe_table` — Get schema information
- `execute_query` — Run SQL queries (read-only by default)
- `analyze_query` — Get query execution plans

**Safety contract:**

- Read-only by default
- LIMIT injection for queries without LIMIT
- SQL redaction for telemetry
- Destructive DDL blocking

---

## Browser Automation

Supports:

- Viewport presets (mobile/tablet/desktop)
- Offline WCAG accessibility scan
- Optional session persistence

---

## HTML Export

`/export` writes a fully self-contained branded HTML report of the conversation:

- Offline fonts (no network required)
- Collapsible tool rows
- Per-message and copy-all buttons
- Branded with Savant Code identity

---

## Knowledge Graph

A deterministic, incremental, SQLite-backed codebase knowledge graph:

- **In-process indexing** — no daemon. Built on `packages/code-map` (tree-sitter)
  with sha256 hash-compare so unchanged files are skipped.
- **Structural metadata only** — paths, symbols, edge types, hashes. No file
  contents, so no secrets can leak.
- **Three edge types** — `IMPORTS`, `CALLS`, and `EXTENDS` with deterministic
  weights.
- **Deterministic domain clustering** — graphology Louvain with seeded RNG, so
  cluster ids are reproducible across runs.
- **Incremental updates** — `/graph refresh` re-indexes changed files only;
  `--full` forces a complete rebuild.
- **Agent-accessible** — Detective and Scout can query `query_blast_radius`,
  `query_node_edges`, and `query_domain_clusters`; the Verifier's Law 4
  reachability check is harness-computed and injected into its message history
  (its zero-tool contract is unchanged).
- **Graph export** — `/graph-export` serializes the graph into a self-contained,
  branded HTML file (the Code Universe) rendered on an interactive
  Sigma.js/Graphology WebGL canvas with a precomputed ranked search index,
  cluster color-coding, and a full document viewer. Fully offline.
  Documents are unlimited by default (gzip+base64 embedded payload,
  decompressed lazily off the critical path).

---

## Token Optimization & YAGNI

Structural cost controls layered onto the ECHO runtime (FID-2026-0806-003):

- **Four-layer context compaction** — per-role token budgets, verbatim recent
tail pinning, tool-result snip pre-pass with byte/line caps, and
`<compaction-summary>`/`<structured_state>` tags that preserve exact
identifiers and decisions instead of collapsing them into prose.
- **Amortization** — optional per-turn fold mode (one oldest exchange folded
per step), idle-compaction and force-ratio triggers, and anti-thrash scoring.
- **Token telemetry** — per-agent prompt/completion/cached token events, a
cache-hit monitor, and a live context meter in the CLI sidebar (green/amber/
red thresholds).
- **YAGNI ladder** — the Forge must clear a six-rung decision ladder (need →
codebase reuse → stdlib → platform → installed dependency → one-liner) and
emit a `yagni_check` before writing code; deliberate shortcuts are tagged
`ponytail:` and harvested into `dev/YAGNI-LEDGER.md`.
- **Opt-in Caveman mode** — telegraphic output rules for Orchestrator /
Detective / Scribe with Auto-Clarity byte-exact bypasses for code, security
warnings, and error paths.

Tunable via `compression` / `yagni` / `caveman` / `telemetry` sections in
`protocol.config.yaml`.

---

## Contributor System

`/contribute [github-username]` adds you to the repo's `CONTRIBUTORS.md` and
opens a PR via the `gh` CLI (FID-2026-0806-004):

- No-arg form reads `git config user.name`
- Duplicate-safe append (the table is created with a header when missing)
- Runs git branch → commit → push → `gh pr create`, committing only
  `CONTRIBUTORS.md` and returning to your original branch
- Git/gh calls use argv-array execution (no shell interpolation) with
  Law-14 error wrapping — a failed PR step keeps the local append and prints
  recovery hints
- Ships in the Savant-Code build

---

## Slash Commands

| Command | Purpose |
|---------|---------|
| `/help` | Show command help and tips |
| `/new` | Start a fresh conversation |
| `/history` | Browse and resume previous sessions |
| `/copy` | Copy the complete conversation to the clipboard |
| `/export` | Write a self-contained branded HTML report |
| `/graph refresh` | Re-index the code knowledge graph and show summary stats |
| `/graph-export` | Write a branded, interactive HTML report of the code knowledge graph |
| `/interview` | Create a structured specification |
| `/plan` | Create an implementation plan |
| `/review` | Review code changes |
| `/goal` | Iterate toward a verifiable goal |
| `/loop` | Schedule recurring checks |
| `/verify` | Run typechecks |
| `/permissions` | View or set the tool permission mode |
| `/rewind` | Restore code and/or conversation from a prior turn |
| `/health` | Check provider, Ollama, model, and permission status |
| `/mode` | List the four modes and their contracts |
| `/model` | Select or switch the active model |
| `/provider` | Configure a hosted provider key |
| `/bash` | Run a shell command |
| `/image` | Attach an image for multimodal models |
| `/init` | Create starter agent types and knowledge.md |
| `/login` / `/logout` | Authenticate or end the current session |
| `/contribute` | Add yourself to CONTRIBUTORS.md and open a PR |
| `/telemetry` | Show or change remote analytics consent |
| `/diagnostics` | Show local CLI resource usage |
| `/ads:enable` / `/ads:disable` | Toggle contextual ads |
| `/theme:toggle` | Toggle between light and dark mode |
| `/exit` | Quit the CLI |

---

## Learn More

- [ECHO Protocol](echo-protocol.md) — The governance system
- [Agent Roster](agents.md) — The 10 agents and their roles
- [Installation](installation.md) — Getting started
- [GitHub](https://github.com/savant0x/savant-code) — Source code
