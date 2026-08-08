<!-- markdownlint-disable MD013 -->
# Savant Code

**A terminal-native multi-agent AI coding assistant that audits every change before it touches your repo.**

Built with TypeScript/Bun, governed by the ECHO Protocol, and designed for local-first use with Ollama or any OpenAI-compatible provider.

---

## Why Savant Code?

Most coding agents work as a single model guessing at your code. They generate changes, maybe run a linter, and hope for the best. When they fail, they fail silently — or worse, they fail confidently.

Savant Code takes a different approach. It uses **10 specialized agents** with strict separation of duties to audit every change before it reaches your files.

**The core insight:** Code quality isn't a model problem, it's a configuration problem. Models will keep getting smarter, but they'll also keep failing in unexpected ways because unexpected failure modes are fundamental to non-deterministic systems. The solution isn't waiting for GPT-6 — it's engineering a harness that catches mistakes structurally.

---

## Quick Start

```bash
npm install -g savant-code
cd your-project
savant-code
```

If Ollama is installed and running, it is detected automatically:

```bash
ollama serve
savant-code
```

---

## The 10 Agents

Savant Code deploys 10 specialized agents, each with a distinct role and restricted tool permissions:

| Agent | Role | What It Does |
|-------|------|--------------|
| **Savant** | Orchestrator | Routes work, enforces protocol, spawns agents |
| **Detective** | RED Phase | Discovers bugs and issues with evidence before code is written |
| **Forge** | GREEN Phase | Implements code changes from a converged plan |
| **Verifier** | AUDIT Phase | Independent double-audit after implementation |
| **Adversary** | ADVERSARIAL Phase | Read-only devil's advocate that refutes every audit claim and re-checks PASSes with evidence |
| **Thinker** | Planning | Deep sequential reasoning for complex problems |
| **Scout** | Explore | Explores codebases to gather context |
| **Researcher** | Research | Web search and documentation lookup |
| **Recorder** | FID Lifecycle | Manages FID creation, tracking, and archiving |
| **Scribe** | Documentation | Session summaries and knowledge capture |

Each agent has exactly the tools it needs — no more. Detective gets read-only access. Forge gets write access. Thinker gets sequential thinking. No agent has more power than its role allows.

---

## The ECHO Perfection Loop

Every code change follows a strict pipeline:

1. **RED** — Identify ALL failures and issues with evidence (Detective phase)
2. **GREEN** — Fix with minimal, surgical changes (Forge phase)
3. **AUDIT** — Independent verification by a separate agent (Verifier phase)
4. **ADVERSARIAL** — Read-only adversarial review that refutes every claim and re-checks PASSes (Adversary phase)
5. **SELF-CORRECT** — Fix any blockers found during audit
6. **COMPLETE** — Document results, archive tracking (Recorder phase)

No code is written without a plan. No plan is accepted without audit. No audit passes without evidence. This isn't optional — it's enforced by the protocol.

---

## Key Features

- **Multi-agent orchestration** — 10 canonical agents coordinate through ECHO with explicit separation of duties
- **Tool permission boundaries** — Each agent gets exactly the tools it needs via strict allowlist filtering
- **Context compaction** — 4-layer progressive auto-compaction keeps sessions running through large codebases
- **Checkpoint & Rewind** — Persistent per-turn edit checkpoints with `/rewind` modes for code, conversation, both, or session fork
- **Fail-closed streaming** — Incomplete or malformed tool calls are rejected, not coerced
- **Provider flexibility** — Works with Ollama (local-first), OpenRouter (default boot provider, free tier `openrouter/free`), OpenCode Go, TokenHarbor, NVIDIA NIM, CommandCode, or any OpenAI-compatible API
- **Deep research** — Multi-query web research with concurrency control, URL dedup, and domain scoring
- **GitHub integration** — Read-only PR/issue/CI review via official MCP server
- **Database helper** — 4 native tools with adapter-enforced safety (read-only by default, LIMIT injection, SQL redaction)
- **Knowledge graph** — Deterministic, incremental codebase graph with blast-radius/node-edge/cluster queries and a branded interactive offline export
- **HTML export** — Fully self-contained branded HTML reports of conversations

---

## Technical Stack

- **Runtime:** TypeScript/Bun
- **Agent System:** ECHO Protocol v0.2.0
- **License:** Apache 2.0 (fully open source)
- **Architecture:** Monorepo with shared packages

---

## Links

- [GitHub](https://github.com/savant0x/savant-code)
- [npm](https://www.npmjs.com/package/savant-code)
- [ECHO Protocol](echo-protocol.md)
- [Agent Roster](agents.md)
- [Features](features.md)
- [Knowledge Graph](knowledge-graph.md)
- [Export Workflows & Code Universe](code-universe-export.md)
- [Installation](installation.md)

### Reference

- [Agents & Tools](agents-and-tools.md) · [Modes](savant-code-modes.md) · [Testing](testing.md) · [Privacy](privacy.md) · [Installation](installation.md) · [Versioning](SAVANT-VERSIONING.md) · [Public Release Workflow](public-release.md) · [Gravity Index starter](gravity-integration-starter.md)

### Archives

- [Design](design/) · [Launch](launch/) · [Reports](reports/) · [Research](research/)
