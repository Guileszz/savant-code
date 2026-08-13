# Archived FIDs

This directory contains closed or historically completed FIDs. Files here are
an audit record, not an active work queue.

## 2026-08-12 archive index — FID-2026-0812-001

`FID-2026-0812-001-v0-0-23-live-test-remediation-master.md` was closed by
operator direction on 2026-08-12 and archived here after the A-Z v0.0.23
harness live-test program reached ledger closure (85 rows: 46 PASS +
33 OPERATOR-CONFIRMED + 1 FAIL\* fixed post-run + 5 SKIP, 0 NEEDS-REVIEW) and
the release-readiness review passed. Closure was recorded with a dedicated
addendum inside the file; historical planning content was preserved and no
section was rewritten. Clean-release certification remains a separate operator
action pending a committed tree.

## 2026-08-12 queue closure batch — FIDs 002–007

The following children of master FID-2026-0812-006 completed their narrowed implementation/evidence, lifecycle closure, and archive moves on 2026-08-12:

- `FID-2026-0812-002` — Savant terminal surface/sidebar and existing chat scrollbar; focused CLI tests 7/7 and CLI typecheck passed; sidebar confirmed fine by the operator.
- `FID-2026-0812-003` — Nous Research direct provider; provider-focused validation 90/90, common/SDK/CLI typechecks, provider-doc drift check, and operator-confirmed live inference passed; Portal OAuth remains out of scope.
- `FID-2026-0812-004` — `/model` ranking and picker visibility/navigation; focused picker evidence and CLI typecheck passed; residual short-terminal, scrolling, resize, focus, keyboard/mouse, Enter/Escape, and persistence checks were operator-confirmed.
- `FID-2026-0812-005` — adaptive grounding refresh/resume; agent-runtime enforcement 27/27 and loop tests 16/16 passed, common/agent-runtime/SDK typechecks passed, and live grounding was operator-confirmed.
- `FID-2026-0812-006` — coordination master; reconciled the child closure records and preserved the no-release/no-GitHub boundary.
- `FID-2026-0812-007` — top-row click/highlight forensics; the operator confirmed no highlight in a different IDE. Closure is classified as an external-environment-dependent resolution; the responsible IDE/extension/terminal condition, application root cause, and Savant fix remain unverified.

The active queue is now empty. Reopen 007 only if the behavior recurs in a supported harness with reproducible evidence.

## Archive invariants

The FID-2026-0811-004 master program and children 005–014 are present as untracked working-tree artifacts with untrusted historical closure claims; they are not certified repository closure evidence and remain untouched pending explicit operator disposition. The separate FID-2026-0811-015–021 remediation package was implemented, independently audited by Nova with **PASS — implementation approved for closure**, transitioned to `closed`, and archived on 2026-08-11. The FID-2026-0811-022–029 LEARNINGS feedback-system remediation package was implemented and locally verified under automation level 3, transitioned to `closed`, and physically archived in this working tree on 2026-08-11; the archive files are not yet tracked by a commit, so durable certification remains pending. Its Nova implementation sign-off is requested in a separate audit-channel record. The implementation entries are recorded in `CHANGELOG.md`; v0.0.23 itself remains pending and unreleased.


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

## 2026-08-09 operator-accepted records (corrective index)

The following archived records retain non-closed status metadata
(`implemented`, `fixed`, `analyzed`, or `verified`) with review boundaries that
were never formally closed. On 2026-08-09 the operator **waived** those remaining
boundaries and accepted the records as historical, matching their physical
archive placement. They are not an active work queue; do not resurrect them as
open FIDs without operator direction.

| FID | Stated status | Waived boundary |
|---|---|---|
| `FID-2026-0806-017-graph-export-performance-precomputed-layout.md` | implemented | pending operator push/closure language |
| `FID-2026-0806-018-graph-export-visible-overview-fit.md` | fixed | pending operator decision |
| `FID-2026-0807-001-spatial-knowledge-graph-experience.md` | analyzed | proposal/analysis (superseded by 0807-002) |
| `FID-2026-0807-002-code-universe-webgl-renderer.md` | implemented | GPU visual audit NEEDS-REVIEW |
| `FID-2026-0807-003-graph-universe-post-click-navigation-and-comet-physics.md` | fixed | browser click persistence review |
| `FID-2026-0807-004-code-universe-hierarchical-browser-and-document-view.md` | implemented | browser runtime review |
| `FID-2026-0807-005-offline-graph-initialization-and-loader-failure.md` | fixed | browser runtime review |
| `FID-2026-0807-006-code-universe-document-and-image-viewer.md` | verified | browser runtime review |

`FID-2026-0808-001-reversible-public-release-pipeline.md` is genuinely closed
(2026-08-09 operator-directed close with Nova sign-off). The active queue is
[`../`](../); its reconciliation record is in [`../README.md`](../README.md).

The active queue is [`../`](../). The current `/dev` lifecycle audit is recorded in
[`../README.md`](../README.md); the historical cleanup FID remains
[`FID-2026-0807-016-dev-folder-and-fid-hygiene.md`](FID-2026-0807-016-dev-folder-and-fid-hygiene.md).

`FID-2026-0811-030-loadable-design-system-skill-library.md` was closed and archived on
2026-08-11 after implementation, focused verification, all-wrapper packaging evidence,
and an independent PASS review. Its extensive product documentation is maintained at
[`docs/design/design-system-library.md`](../../docs/design/design-system-library.md).
The documentation-and-implementation sign-off request remains an explicit independent
review boundary for the current working-tree evidence; no release or publication was
performed.
