# Development Records

`dev/` contains development-time records and validation material. Keep active
work separate from historical evidence and generated output.

| Area | Purpose |
|---|---|
| [`fids/`](fids/) | Active Feature Implementation Documents awaiting resolution |
| [`fids/archive/`](fids/archive/) | Closed FIDs and immutable historical records |
| [`scratchpad/`](scratchpad/) | Short-lived experiments and reusable local validation scripts |
| [`nova/`](nova/) | Third-party audit inbox/outbox and research channel |
| [`session-summaries/`](session-summaries/) | Historical session audit trail |
| [`test-prompts/`](test-prompts/) | Reusable test prompts and live validation harnesses |
| [`exports/`](exports/) | Generated export artifacts; never treat as source documentation |
| [`releases/`](releases/) | Release-specific development records |
| [`LEARNINGS.md`](LEARNINGS.md) | Cross-session lessons |
| [`YAGNI-LEDGER.md`](YAGNI-LEDGER.md) | Intentional-debt and scope ledger |

## Hygiene rules

- Do not place generated exports, databases, dumps, or browser captures in an
  active source directory.
- Closed FIDs belong in `fids/archive/` and require a CHANGELOG entry.
- Preserve historical FID and audit prose; document corrections separately
  rather than rewriting the record.
- Use `scratchpad/active/` for current reusable experiments and
  `scratchpad/archive/` for retained historical experiments.
