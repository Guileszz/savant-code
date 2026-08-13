# Embedded Learning Guidance

This file is the curated runtime-facing subset of the internal learning history.
It contains durable engineering invariants and release guardrails, not operator
identity, credentials, or session transcripts.

## Lesson: Generated artifacts require source-shape validation

- **Date:** 2026-08-11
- **Failure:** A generator can silently accept the wrong source shape and emit incomplete guidance.
- **Evidence:** scripts/generate-protocol-bundle.ts → symbol:runContentAssertions
- **Invariant:** Generated content is trustworthy only when extraction validates the source's observed structure.
- **Guard:** `bun run generate:protocol-bundle:check`
- **Verification:** Regenerate twice and compare the generated files byte-for-byte.
- **Scope:** embedded
- **Owning FID:** FID-2026-0811-022
- **Status:** active
- **Canonical rule:** generated-artifact-drift

## Lesson: Release gates must preserve the original environment

- **Date:** 2026-08-11
- **Failure:** A release preflight can pass while leaving environment or artifact state changed after a failure.
- **Evidence:** scripts/public-release.ts → symbol:restoreLocalState,
  scripts/validation-manifest.ts → symbol:repositoryValidationGates
- **Invariant:** Local release checks are reversible and must report direct
  command outcomes.
- **Guard:** `bun run validate:repository`
- **Verification:** Exercise success, failure, timeout, and signal paths and
  compare environment/settings/artifact identity.
- **Scope:** embedded
- **Owning FID:** FID-2026-0811-027
- **Status:** active
- **Canonical rule:** release-preflight-restoration

## Lesson: Superseded guidance must point to a current rule

- **Date:** 2026-08-11
- **Failure:** Incident notes can leave an obsolete recipe looking like current operational guidance.
- **Evidence:** scripts/learnings-validation.ts → symbol:validateLearnings
- **Invariant:** Superseded guidance retains its history but names an existing replacement and canonical rule.
- **Guard:** `bun run learnings:check`
- **Verification:** Reject missing, circular, or unresolved supersession targets.
- **Scope:** embedded
- **Owning FID:** FID-2026-0811-025
- **Status:** active
- **Canonical rule:** learning-supersession

## Lesson: Governance contracts require explicit selection

- **Date:** 2026-08-11
- **Failure:** Broad governance wording can cause a valid contract to be treated as absent.
- **Evidence:** common/src/util/boot-contract.ts → symbol:resolveBootContract,
  scripts/generate-protocol-bundle.ts → symbol:runContentAssertions
- **Invariant:** Each governance branch is explicit and must not silently fall
  through to another contract; harness-injected context selects only the
  harness contract.
- **Guard:** `bun run generate:protocol-bundle:check`
- **Verification:** Test local-first resolution, fail-closed mismatch behavior,
  and scoped exclusion of the alternate protocol from embedded harness context.
- **Scope:** embedded
- **Owning FID:** FID-2026-0811-026
- **Status:** active
- **Canonical rule:** protocol-variant-boundary
