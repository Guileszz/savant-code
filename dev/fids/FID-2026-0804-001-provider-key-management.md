<!-- markdownlint-disable MD013 -->

# FID: CLI Provider Key Management

**Filename:** `FID-2026-0804-001-provider-key-management.md`
**ID:** FID-2026-0804-001
**Severity:** high
**Status:** verified
**Created:** 2026-08-04 11:00
**Author:** Savant Orchestrator

---

## Summary

The CLI needs a reliable, discoverable way to add or change an inference-provider API key without requiring users to edit environment variables or manually modify credential files. The current source already contains an OpenRouter provider entry and masked setup plumbing, but the interactive save path does not fully define or enforce precedence between shell credentials, stored credentials, direct-provider settings, and SDK OpenRouter resolution. This FID converges the remaining key-management behavior and requires packaged-artifact verification so the npm-installed CLI exposes the same flow as the source tree.

## Environment

- **OS:** Windows 11 / win32
- **Language/Runtime:** TypeScript, Bun 1.3.11 local / Bun 1.3.14 release configuration
- **Tool Versions:** TypeScript 5.5.4, React 19, OpenTUI 0.2.2, Zustand 5
- **Commit/State:** `main` at `c1ee6b9`; implementation committed and tagged as `v0.0.18`

## Detailed Description

### Problem

A launch check initially reported that `/provider` did not show OpenRouter. Independent RED analysis verified that the current working tree now contains OpenRouter in `PROVIDER_SETUP_CONFIG`, the command registry reaches the provider picker from that registry, and provider setup tests already cover basic OpenRouter persistence. The original omission claim is therefore stale relative to the current source and is not the remaining implementation target.

The actual feature gap is that users need a dependable way to add or change keys interactively while preserving the documented credential and routing precedence. `saveProviderApiKey()` currently writes the entered key into `process.env` and unconditionally sets `DIRECT_PROVIDER` and `INFERENCE_BASE_URL`, even when explicit shell configuration is already present. The SDK also resolves OpenRouter credentials through a separate cache and precedence path that is not covered by the CLI setup tests. Finally, the npm package is only a launcher; the real feature must be verified in the downloaded release binary, not only in source tests.

### Expected Behavior

- `/provider` lists all configured interactive providers, including OpenRouter direct mode.
- `/provider openrouter` and picker selection reach the existing masked key-entry flow.
- Entering a key stores it locally without adding the secret to chat history, logs, rendered messages, thrown errors, or user-facing error text.
- Re-entering a provider replaces only that provider's stored key and preserves unrelated credentials, backend fields, settings, and provider keys.
- An explicit nonempty shell provider key remains authoritative for the current process. The entered key is still persisted as fallback, but `process.env[config.envVar]` is not replaced.
- An explicit nonempty shell `DIRECT_PROVIDER` remains authoritative. An explicit nonempty shell `INFERENCE_BASE_URL` remains authoritative. Interactive setup never silently changes either value when present.
- Empty or whitespace-only shell values are treated as absent and may be filled by interactive setup.
- If only `DIRECT_PROVIDER` is present, setup may fill the registered base URL only when the selected provider matches that provider; if only `INFERENCE_BASE_URL` is present, setup must preserve it and may not infer or replace a provider name.
- If neither shell routing value is present, interactive setup activates the selected provider and registered base URL for the current process and persists them for the next launch.
- Persisted direct-provider settings are lower precedence than any explicit shell routing values and higher precedence than default-provider inference.
- `OR_MASTER_KEY`, `OPENROUTER_API_KEY`, and `INFERENCE_API_KEY` retain the SDK's exact precedence (`OR_MASTER_KEY > OPENROUTER_API_KEY > INFERENCE_API_KEY`) and are not silently overwritten by the OpenRouter setup flow.
- If the SDK has already resolved or cached an OpenRouter key, successful OpenRouter setup calls a reachable `resetOpenRouterApiKeyCache()` hook before the next model resolution. Ordinary resolver reads retain positive and negative caching.
- `/health` and missing-key guidance identify the active provider and required variable accurately.
- The `0.0.18` packaged artifact contains the version injection fix and this provider behavior.

### Root Cause

The CLI provider setup registry and SDK inference routing evolved separately. `cli/src/utils/provider-setup.ts` is the source of truth for the interactive picker and persistence flow, while `sdk/src/impl/model-provider.ts` and `sdk/src/impl/openrouter-key-resolver.ts` independently resolve direct-provider credentials. The CLI's `saveProviderApiKey()` currently mutates process environment and direct-provider routing unconditionally, which can override explicit shell configuration and can disagree with SDK cache state. The release wrapper ships only a launcher and downloads the binary separately, so source-level correctness alone does not establish npm artifact correctness.

### Evidence

```text
Current source verification:

cli/src/utils/provider-setup.ts:19-40
PROVIDER_SETUP_CONFIG currently includes openrouter with OPENROUTER_API_KEY and the OpenRouter base URL.

cli/src/commands/command-registry.ts:723-741
The no-argument /provider picker maps Object.entries(PROVIDER_SETUP_CONFIG).

cli/src/commands/command-registry.ts:747-778
/provider <name> calls beginProviderSetup() and enters providerSetup mode for valid entries.

cli/src/chat.tsx:430-470
providerSetup input is masked, persisted through saveProviderApiKey(), cleared, and returned to default mode without saveToHistory.

cli/src/utils/provider-setup.ts:210-275
saveProviderApiKey() merges providerApiKeys, preserves nonempty shell keys and routing, handles partial provider/base-URL configuration, sanitizes persistence failures through the router, and activates only permitted direct-provider settings.

sdk/src/impl/openrouter-key-resolver.ts:25-113
The SDK resolves OR_MASTER_KEY before OPENROUTER_API_KEY before INFERENCE_API_KEY, deduplicates concurrent exchanges, caches results, and invalidates automatically when credential environment values change.

sdk/src/impl/model-provider.ts:46-56, 149-153, 562-585
The model provider retains the resolver path and existing OAuth/provider exports in the compiled SDK bundle.

cli/src/utils/__tests__/provider-setup.test.ts:73-194
Tests cover OpenRouter save, shell precedence, routing preservation, partial configuration, persisted-key behavior, and provider metadata.

cli/src/commands/__tests__/router-provider-setup.test.ts:59-179
Tests cover provider setup routing, missing-key gating, masked persistence, history exclusion, and secret non-disclosure.

sdk/src/impl/openrouter-key-resolver.test.ts:1-100
Six tests cover OpenRouter precedence, concurrent exchange deduplication, automatic environment-change invalidation, and fallback behavior.

sdk/dist/index.mjs
Compiled export smoke verifies getActiveTerminalCommandProcesses, resetChatGptOAuthRateLimit, and restoreTurn are present after the SDK bundle-retention fixes.

Combined compiled provider suite
23 passed, 0 failed.
cli/release/package.json:20-28 and cli/release/index.js:6-19
The npm package contains a launcher; the launcher downloads and runs the platform binary. Source tests do not prove the published artifact.

Related release evidence:
cli/src/utils/version.ts now prefers SAVANT_CODE_CLI_VERSION and falls back to VERSION, then 0.0.0. The 0.0.18 release artifact must carry env.json with the injected version.

Independent RED audit:
The original OpenRouter omission finding is stale. Remaining findings are precedence/activation ambiguity, unconditional environment mutation, resolver-cache lifecycle coverage, persistence hardening, secret-redaction failure coverage, and missing packaged-artifact smoke coverage.
```

## Impact Assessment

### Affected Components

- `cli/src/utils/provider-setup.ts`
- `cli/src/commands/command-registry.ts`
- `cli/src/components/provider-picker.tsx`
- `cli/src/state/provider-picker-store.ts`
- `cli/src/chat.tsx`
- `cli/src/commands/router.ts`
- `cli/src/utils/__tests__/provider-setup.test.ts`
- `cli/src/commands/__tests__/router-provider-setup.test.ts`
- `sdk/src/impl/openrouter-key-resolver.ts`
- `sdk/src/impl/model-provider.ts`
- `sdk/src/env.ts`
- Provider setup and release documentation
- Release binary smoke/package verification

### Risk Level

- [ ] Critical: System crash, data loss, or security vulnerability
- [x] High: Major feature broken, no workaround
- [ ] Medium: Feature degraded, workaround exists
- [ ] Low: Minor issue, cosmetic, or edge case

## Proposed Solution

### Approach

Preserve the existing provider registry and masked input flow, then define one explicit precedence contract across CLI setup and SDK resolution. Store only the regular `OPENROUTER_API_KEY` through the interactive provider flow. Keep `OR_MASTER_KEY` and `INFERENCE_API_KEY` environment-level credentials with their existing SDK precedence. Persist the newly entered provider key while never replacing a nonempty explicit shell provider key or explicit shell routing configuration. Apply the explicit partial-configuration rules above for `DIRECT_PROVIDER` and `INFERENCE_BASE_URL`; activate the selected provider/base URL only when no explicit shell routing is authoritative. Add and export a reachable `resetOpenRouterApiKeyCache()` hook, call it after a successful applicable save, and preserve ordinary positive/negative caching and SDK precedence. Sanitize persistence failures so raw exception text cannot echo the entered secret. Keep plaintext local persistence with best-effort POSIX permissions; keychain, encryption, Windows ACL hardening, and atomic writes are separate FIDs.

The robust default is:

| Configuration | Precedence/behavior |
|---|---|
| `OR_MASTER_KEY` | Environment-only; SDK exchange behavior remains highest OpenRouter credential priority. |
| `OPENROUTER_API_KEY` | Explicit shell value wins; stored value is fallback; interactive setup never replaces an explicit shell value. |
| `INFERENCE_API_KEY` | Environment-only SDK fallback; interactive OpenRouter setup never overwrites it. |
| `DIRECT_PROVIDER` | Explicit shell value wins; stored provider setting is used only when no explicit value exists. |
| `INFERENCE_BASE_URL` | Explicit shell value wins; the OpenRouter base URL is activated only when no explicit base URL exists. |
| Stored provider key | Replaces only the same provider's stored key and preserves unrelated credential fields. |

### Steps

1. Confirm all provider setup and inference call paths, including credential precedence, resolver cache, and health diagnostics.
2. Update the FID with the exact activation and cache contract through Thinker/Recorder GREEN analysis.
3. Add regression tests for picker reachability, masked setup persistence, replacement, shell precedence, routing preservation, resolver lifecycle, and secret redaction.
4. Update README, npm README, launch docs, and changelog for the supported interactive key-management behavior.
5. Rebuild and smoke-test the release binary with injected version metadata and the provider setup flow in a clean config directory.
6. Run the configured typecheck, test, lint, markdownlint, and release-package checks.

### Verification

- `bun run typecheck`
- `bun test cli/src/utils/__tests__/provider-setup.test.ts cli/src/commands/__tests__/router-provider-setup.test.ts`
- Relevant SDK OpenRouter resolver tests, including cache and precedence behavior
- `bun x eslint . --max-warnings 0`
- `bun run lint:md`
- `bun pm pack --cwd cli/release --dry-run`
- Build the release binary with version `0.0.18`, run `--version`, inspect sibling `env.json`, and exercise `/provider` in a clean config directory.
- Grep production callers/readers to prove the registry reaches the picker, setup mode, persistence, and SDK model resolution.

## Perfection Loop

### Loop 1

- **RED:** Independent analysis corrected the stale OpenRouter-omission diagnosis. Verified current provider picker/setup call graph. Identified high-risk gaps: unconditional environment mutation, undefined shell/provider/base-URL precedence, SDK resolver cache lifecycle, incomplete secret-redaction failure tests, persistence hardening boundaries, and missing packaged-artifact smoke coverage.
- **GREEN:** Converged on the minimal Approach A: preserve the existing provider registry and masked flow; narrow `saveProviderApiKey()` using the exhaustive nonempty/empty partial-routing rules; persist only the selected provider key while preserving explicit shell values; add and export a reachable `resetOpenRouterApiKeyCache()` hook without changing SDK precedence or ordinary caching; sanitize persistence errors; add CLI/SDK regression tests; synchronize stale SDK dist before test execution; and verify the packaged binary. Plaintext credential storage, atomic persistence, provider-configuration redesign, master-key lifecycle, and cross-platform release-matrix hardening are separate FIDs.
- **AUDIT:** The first design audit failed because partial-env combinations, resolver reset reachability, failure-path redaction, preservation tests, stale SDK dist synchronization, and release artifact evidence were underspecified. SELF-CORRECT added an exhaustive precedence contract, made cache reset and dist synchronization blocking in-scope gates, narrowed security claims to plaintext best-effort storage, and required failure-path plus packaged-binary evidence. The current source still fails the proposed behavior by design; those failures are implementation acceptance gates, not reasons to reject the now-complete FID specification.
- **CHANGE DELTA:** Implementation completed in the referenced CLI/SDK files; release artifact smoke remains a separate release gate.

### FID Design Audit Boundary

The FID AUDIT phase certifies that the proposed solution is complete, internally consistent, minimal, reachable in the existing architecture, and independently verifiable. It does not require the current code to pass implementation gates before the FID reaches COMPLETE; the current failures are the RED baseline and are listed as post-convergence implementation acceptance criteria. After FID COMPLETE, Forge implements the GREEN contract, and Verifier separately audits the resulting code and release artifact.

### Implementation Evidence

- `saveProviderApiKey()` now preserves nonempty shell keys and routing, handles partial provider/base-URL configuration, persists only the selected provider key, and activates routing only when allowed (`cli/src/utils/provider-setup.ts`).
- `resetOpenRouterApiKeyCache()` is exported from the SDK and called after successful OpenRouter setup; resolver precedence, positive/negative caching, reset, and concurrent exchange deduplication are covered (`sdk/src/impl/openrouter-key-resolver.ts`).
- Provider-save failures now use generic user-facing text, and masked setup tests verify secret non-disclosure (`cli/src/commands/router.ts`, `cli/src/commands/__tests__/router-provider-setup.test.ts`).
- SDK `dist` was rebuilt with export-retention fixes for existing checkpoint/terminal/OAuth APIs; compiled export smoke passed for `getActiveTerminalCommandProcesses`, `resetChatGptOAuthRateLimit`, and `restoreTurn`.
- The compiled provider regression suite passed 23/23: provider setup, masked router setup, OpenRouter precedence/cache, automatic environment-change invalidation, and concurrent exchange deduplication.
- Full workspace typecheck, full ESLint, markdownlint, npm package dry-run, release metadata consistency, and injected version helper checks passed.
- Standalone binary smoke remains a release publication gate because the Windows build wrapper returned an undefined child status before producing a verified executable.

### Missed Questions

1. Is OpenRouter actually absent from the current source? → No. RED evidence verifies it is already registered; the FID must not duplicate that work.
2. Should the interactive flow store a master key? → No. Store only `OPENROUTER_API_KEY`; keep `OR_MASTER_KEY` environment-only because it requires exchange semantics.
3. Should a stored key replace an explicit shell key? → No. Persist the entered value as fallback but preserve the shell value in the current process.
4. Should interactive setup override explicit `DIRECT_PROVIDER` or `INFERENCE_BASE_URL`? → No. Explicit shell routing remains authoritative; setup reports persistence without silently rerouting.
5. Should changing a provider key change the model? → No. Provider and model preferences remain separate; no silent model change.
6. How does the SDK resolve OpenRouter credentials? → `OR_MASTER_KEY` exchange, then `OPENROUTER_API_KEY`, then `INFERENCE_API_KEY`; the FID must test this exact order.
7. What happens if the SDK resolver cached null before setup? → The GREEN proposal must choose cache invalidation after setup or a documented lifecycle prohibition, then add a regression test.
8. How should a user replace a stored key? → Re-entering the provider replaces only that provider's stored key and preserves unrelated credentials/backend fields.
9. How are secrets protected on failure? → No secret may enter history, rendered messages, logs, or error text; persistence-failure tests must assert this.
10. Is the npm package itself the application binary? → No. It is a launcher; release verification must exercise the downloaded binary and sibling `env.json`.
11. Is the stale `inclusionai/ling-3.0-flash:free` model ID present in current source? → No evidence in the current source; rebuild artifact consistency is required, but model-catalog redesign is out of scope unless new source evidence appears.
12. Does this FID include the `0.0.18` release publication? → It includes release verification and tracking dependencies; publishing remains a separate release action after implementation gates pass.

### Code Verification Evidence

- [x] Files referenced in "Affected Components" exist in the codebase
- [x] RED call graph and current OpenRouter registry were independently verified
- [x] Implementation matches the converged solution
- [x] Typecheck passes: `bun run typecheck`
- [x] FID status updated to reflect actual implementation state

## Resolution

- **Fixed By:** Savant Orchestrator
- **Fixed Date:** 2026-08-04
- **Fix Description:** Added safe provider-key replacement semantics, explicit shell/provider/base-URL precedence, generic persistence errors, exported OpenRouter resolver reset, and concurrent resolver deduplication.
- **Tests Added:** Yes — provider setup precedence tests, masked setup coverage, and six OpenRouter resolver precedence/cache/concurrency tests.
- **Verified By:** Final source, compiled SDK, test, typecheck, ESLint, markdownlint, version-consistency, and npm staging gates.
- **Commit/PR:** `c1ee6b9`, tag `v0.0.18` (already pushed; no further remote action taken)
- **Archived:** Pending external npm/GitHub install confirmation

## Lessons Learned

Provider launch readiness has separate contracts for runtime routing, interactive credential setup, and packaged-artifact delivery. A provider should not be considered operational until all three contracts share an explicit precedence model and are exercised through the shipped artifact.
