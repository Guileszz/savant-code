# Feature Implementation Documents

This directory contains **active** FIDs only: findings that still require
operator decision, implementation, runtime review, or closure evidence.

## Current active FIDs

The `/dev` audit found **zero active FIDs** in `dev/fids/`; the coordination master and
FID-0812-007 completed their lifecycle closure and archive moves after the operator
confirmed that the top-row highlight no longer occurred in a different IDE. The result is
classified as an external-environment-dependent resolution; the Savant/OpenTUI root cause
and application fix remain unverified. Child FIDs 002–005 were already closed and archived.
Implementation status alone is not closure evidence.

| Coordination master | Current status | Purpose |
|---|---|---|
| [`FID-2026-0812-006`](archive/FID-2026-0812-006-v0-0-23-active-queue-implementation-closure-master.md) | `closed` | Final child reconciliation; no release authorization | Archived |

| FID | Current status | Closure classification | Disposition |
|---|---|---|---|
| [`FID-2026-0812-007`](archive/FID-2026-0812-007-top-row-click-selection.md) | `closed` | Operator-confirmed external-environment resolution; application fix and root cause unverified | Archived |

FIDs 0812-002/003/004/005/006/007 are closed and archived with their implementation,
operator-confirmed evidence where applicable, lifecycle closure loops, and changelog
coverage recorded in the archive. FID-0812-007's original selection owner remains
unverified, but the operator-confirmed external-environment resolution closes its active
work queue. Reopen it only if the behavior recurs in a supported harness.

Do not archive a FID solely because code is implemented, operator-tested, or a planning
loop converged. Archive only after all stated review boundaries are resolved, the FID
status is `closed`, the `CHANGELOG.md` contains a closure entry, and the file is moved to
[`archive/`](archive/).

The most recently closed 0812 records include 002–007 and the earlier
`FID-2026-0812-001-v0-0-23-live-test-remediation-master.md`. They were archived after
implementation evidence, operator confirmation, lifecycle closure, and release-readiness
review; they are not part of the active queue. Earlier closed packages and operator-accepted historical
records remain documented below and in [`archive/README.md`](archive/README.md).

The 015–021 remediation package and the 022–029 LEARNINGS feedback-system package are
not active FIDs. Their working-tree/archive and Nova sign-off boundaries remain documented
as historical or pending evidence in the sections below; they are not silently re-opened by
this audit.

The 2026-08-09 optimization program (master FID-2026-0809-012 + children 013–018) was
implemented under the operator's automation level 3 grant, independently signed off by Nova
(implementation audit **PASS**,
`dev/nova/inbox/2026-08-09-fid-2026-0809-003-010-optimization-automation-implementation-sign-off-response.md`),
and closed/archived 2026-08-09. All seven records now live in [`archive/`](archive/) with
`closed` status.

The FID-2026-0811 deep-audit master program and children 005–014 remain untracked
working-tree artifacts whose historical closure claims are explicitly untrusted; they
were not rewritten, deleted, or silently dispositioned. The separate remediation package
015–021 is the tracked-scope implementation under current Nova review.

### 2026-08-09 ledger reconciliation (operator-accepted)

The FIDs previously listed here as active — `0806-017`, `0806-018`, `0807-001`
through `0807-006`, and `0808-001` — had all been moved to the archive while
retaining non-closed status metadata (`implemented`, `fixed`, `analyzed`, or
`verified`) with unresolved review boundaries. Per operator decision on
2026-08-09, those remaining review boundaries are **waived** and the records are
accepted as **historical**, matching their physical archive placement. They are not an
active work queue. `FID-2026-0808-001` is genuinely closed (operator-directed close with
Nova sign-off); `0806-017`/`0806-018` and `0807-001`…`006` are operator-accepted historical
records. See [`archive/README.md`](archive/README.md) for the corrective index entry.

The 2026-08-09 optimization and automation batch (`FID-2026-0809-003` through
`FID-2026-0809-010`) is closed and archived; its independent PASS response is recorded in
`dev/nova/inbox/2026-08-09-fid-2026-0809-003-010-optimization-automation-implementation-sign-off-response.md`.

The FID-2026-0811-022–029 LEARNINGS feedback-system remediation package is implemented,
locally verified, transitioned to `closed`, and physically moved to [`archive/`](archive/)
in this working tree. The archive files are not yet tracked by a commit, so this is
working-tree closure evidence rather than durable repository certification. Nova's
implementation sign-off request is recorded in the audit channel; release certification
remains a separate operator decision.

The batch is included in pending unreleased `0.0.23`; the release gate was re-run under the
pinned Bun `1.3.14` toolchain (2026-08-09) and passes, and publication remains a separate
operator action.

`FID-2026-0809-011` (graph-export file decomposition — `template.ts` + `export-serializer.ts`)
is closed and archived 2026-08-09 after the Nova implementation sign-off **PASS**
(`dev/nova/inbox/2026-08-09-fid-2026-0809-011-graph-export-file-decomposition-nova-audit-response.md`);
byte-identical artifact proven pre/post decomposition. Archived at
`dev/fids/archive/FID-2026-0809-011-graph-export-file-decomposition.md`.

`FID-2026-0810-002` (universal session-init grounding) and `FID-2026-0810-003`
(generated condensed protocol copies — the follow-up converting
`ECHO_PROTOCOL_INSTRUCTIONS` + the 15-turn refresh into generated output from `ECHO.md` +
generator framing) are closed and archived 2026-08-10 after Perfection-Loop convergence
(operator-approved) and implementation under automation level 3. Archived at
`dev/fids/archive/FID-2026-0810-002-universal-session-init-grounding.md` and
`dev/fids/archive/FID-2026-0810-003-generated-condensed-protocol-copies.md`.
The separate 2026-08-10 records remain archived; the 015–021 remediation package is now
closed and archived after Nova's PASS.

Do not archive a FID solely because its code is implemented. Archive only after all stated
review boundaries are resolved, the FID status is `closed`, the CHANGELOG contains a closure
entry, and the file is moved to `dev/fids/archive/`.

The 015–021 package and FID-2026-0811-030 satisfy those conditions after independent
implementation review. The design-system feature guide is maintained at
[`docs/design/design-system-library.md`](../../docs/design/design-system-library.md).
The current documentation-and-implementation sign-off request remains an explicit
independent review boundary. This remains working-tree evidence until committed.

See [`archive/README.md`](archive/README.md) for historical records and
[`FID-2026-0807-016-dev-folder-and-fid-hygiene.md`](archive/FID-2026-0807-016-dev-folder-and-fid-hygiene.md)
for the current `/dev` cleanup audit.

## Historical duplicate IDs

`FID-2026-0805-006` and `FID-2026-0805-007` were each used for two historical
records. Their filenames and contents are intentionally preserved. Do not rename them
retroactively; use the full filename when linking to either record.
