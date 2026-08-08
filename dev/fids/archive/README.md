# Archived FIDs

This directory contains closed or historically completed FIDs. Files here are
an audit record, not an active work queue.

## Archive invariants

- A closed FID is moved here only after implementation and verification evidence
  is recorded and a CHANGELOG entry exists.
- Historical content and filenames are preserved. Older records may use legacy
  status wording such as `fixed`, `verified`, or `complete`; do not mass-rewrite
  those records.
- Duplicate historical IDs are intentional legacy collisions. Always reference
  the full filename when the numeric ID is ambiguous.
- If an archived record is discovered with stale lifecycle metadata, add a
  corrective note or index entry rather than rewriting its historical evidence.

## Legacy status exception

Some older archived records predate the current closure gate and retain statuses
such as `created`, `fixed`, `verified`, or transition prose even though the file
was archived as a historical release record. For example,
`FID-2026-0806-016-v0.0.21-post-audit-fix-batch.md` retains its original
`created` metadata. This is documented drift, not a current active-FID claim;
do not mass-rewrite the historical record.

The active queue is [`../`](../); its current cleanup audit is
[`FID-2026-0807-016-dev-folder-and-fid-hygiene.md`](FID-2026-0807-016-dev-folder-and-fid-hygiene.md).
