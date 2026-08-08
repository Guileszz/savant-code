# Nova Audit Channel

`nova/` is the third-party audit and research exchange channel.

- [`inbox/`](inbox/) — incoming audit responses and active review material
- [`outbox/`](outbox/) — prompts and requests sent for external review
- [`reports/`](reports/) — retained research/report artifacts
- [`specs/`](specs/) — protocol and feature specifications
- `inbox/archive/` and `outbox/archive/` — historical exchanges

Preserve audit messages and specifications as historical records. New active
requests belong at the inbox/outbox roots; completed exchanges move to the
matching archive without rewriting their contents.
