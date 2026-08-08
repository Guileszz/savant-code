# Feature Implementation Documents

This directory contains **active** FIDs only: findings that still require
operator decision, implementation, runtime review, or closure evidence.

## Current active FIDs

| FID | State | Boundary |
|---|---|---|
| `0806-017` | implemented | Pending operator push/closure language remains |
| `0806-018` | fixed | Pending operator decision explicitly remains |
| `0807-001` | analyzed | Proposal/analysis remains open |
| `0807-002` | implemented | GPU visual review remains open |
| `0807-003` | fixed | Browser click persistence/visual review remains open |
| `0807-004` | implemented | Browser runtime review remains open |
| `0807-005` | fixed | Browser runtime review remains open |
| `0807-006` | verified | Browser runtime review remains open |
| `0808-001` | implemented | Canonical reversible public release workflow implemented; independent audit and operator release execution remain pending |

Do not archive a FID solely because its code is implemented. Archive only after
all stated review boundaries are resolved, the FID status is `closed`, the
CHANGELOG contains a closure entry, and the file is moved to [`archive/`](archive/).

The active FID table may use descriptive transitional wording from historical
records (`implemented`, `fixed`, or `verified`); these are not closure evidence
until the unresolved review boundary is explicitly cleared.

See [`archive/README.md`](archive/README.md) for historical records and
[`FID-2026-0807-016-dev-folder-and-fid-hygiene.md`](archive/FID-2026-0807-016-dev-folder-and-fid-hygiene.md)
for the current `/dev` cleanup audit.

## Historical duplicate IDs

`FID-2026-0805-006` and `FID-2026-0805-007` were each used for two historical
records. Their filenames and contents are intentionally preserved. Do not
rename them retroactively; use the full filename when linking to either record.
