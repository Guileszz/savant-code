# Test Prompts

This directory contains reusable validation prompts and live harnesses.

- Root-level files are active prompts or current harnesses.
- The comprehensive `0.0.23` regression prompt is
  [`v0.0.23-comprehensive-live-test.md`](v0.0.23-comprehensive-live-test.md).
  It uses the changelog as its coverage index and writes its report to
  `dev/scratchpad/v0.0.23-comprehensive-live-test-report.md`.
- The in-harness A–Z prompt is
  [`az-v0.0.23-harness-live-test.md`](az-v0.0.23-harness-live-test.md). It is
  executed by the harness agent itself inside `bun dev` (no tmux, no binary
  build, no isolated copy) using the local Ollama backend for model-dependent
  tests, and writes its report to
  `dev/scratchpad/az-v0.0.23-harness-live-test-report.md` (template:
  `az-v0.0.23-harness-live-test-report.template.md`).
- [`archive/`](archive/) contains historical prompts and result records.
- Generated result dumps should live with the relevant archived benchmark
  material, not beside active prompts.

Keep prompt files deterministic and document the command used to run executable
harnesses near their header.
