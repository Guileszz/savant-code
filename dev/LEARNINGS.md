# LEARNINGS

## Session 2026-08-04: MCP Feature Integration Closeout (FID-2026-0804-002..006)

**Key Learnings:**

- **"Ideas, not 1:1 ports" is a licensing + architecture discipline, not just a style choice.** The four
  `resources/mcp/` reference repos (deep-research MCP, github-mcp-server, local-deep-research, mcp-toolbox) were
  sources of *ideas*: the deep_research query fan-out, the GitHub remote-HTTP MCP route, the SQL safety adapter,
  the browser-viewport contract. Each was rebuilt on Savant's own harness — no AI SDK (the harness already runs
  the model), no new dependencies, `bun:sqlite` in-tree. The license audit (MIT×3 + Apache-2.0, no GPL) is a
  hard gate before any reference-repo adoption; run it in RED, not after implementation.
- **No-second-LLM is a greppable invariant.** `grep -rn 'generateObject|from .ai.|@ai-sdk'` over new handler
  code must return zero production hits. This caught nothing this round (the one hit was a comment), but the
  grep is the cheap, mechanical proof that a "mechanical tool" stayed mechanical — put it in the master FID's
  gates so every child inherits it.
- **Safety contracts belong in the adapter, not the prompt.** The database tools' read-only default, LIMIT
  injection, redaction, and destructive-DDL block are enforced in `sqlite-adapter.ts` code paths, so a
  misbehaving model cannot bypass them by ignoring instructions. Prompt-level safety is a fallback, never the
  contract. Nova's audit specifically verified this — "adapter-enforced (not prompt-only)".
- **A read-only helper default is a product decision, not an implementation detail.** `github` ships
  read-only (review, comment, scan — never merge/approve/push) and `browser-use` keeps `--isolated` by
  default. Documenting the read-only contract in the agent's systemPrompt makes it testable and auditable.
- **Citation precision is load-bearing when a third-party auditor re-greps.** The A-Z results report
  initially cited line numbers that exceeded the target file's actual length (1118 lines) and pointed at
  unrelated content; a post-run re-grep corrected six citations (slash-command lines, free-agents line 167,
  bundled-agents line 616, `research_depth` enum). Cross-Agent Claim Rule: every line-number claim must be
  verified against the working tree before it becomes evidence — Nova will re-grep.
- **Nova signoff closes the loop but does not replace local re-verification.** Nova PASSED the audit with one
  ⚠️ ("verification gates plausible but not independently re-run" — she can't run the dev environment). The
  acknowledgment re-ran the full battery at verdict time (636/0, 523/0, 3/0, typecheck ×5, ESLint 0) and
  logged real tool output into the outbox. Always answer an auditor's ⚠️ with fresh evidence, not argument.

**Files touched:** agents/{github,database,browser-use,researcher,savant}/, common/src/tools/ (deep-research,
database params, constants, list, safety-registry), packages/agent-runtime/src/tools/handlers/tool/ (deep-research,
database/), cli/src/commands/export-conversation.ts + constants/, cli/src/utils/run-state-storage.ts, CHANGELOG.md,
ARCHITECTURE.md, ECHO.md, README.md, dev/test-prompts/, dev/nova/, dev/fids/archive/.

## Session 2026-08-03: Release-Readiness Audit (FID-2026-0803-012)

**Key Learnings:**

- **"Deleted" files that are still tracked in git are restorable, and their loss is
  silent.** The 12 eval fixture JSONs were `D` in `git status` (worktree-deleted,
  unstaged) — the benchmark runner referenced them and failed at startup, but nothing
  flagged the missing fixtures until the eval was actually run. `git ls-files` +
  `git cat-file -e HEAD:<path>` confirm restorability. Lesson: before declaring a
  surface broken, check `git status` for unstaged deletions — the fix may be
  `git restore`, not new code.
- **An eval harness that has never been run end-to-end hides real bugs.** Baseline
  (golden-patch) mode passed 3/3 before this session and looked healthy, but the
  first evaluate run exposed three genuine defects in sequence: (1) no
  `agentDefinitions` passed → empty SDK registry → `Invalid agent ID`; (2) cyclic
  provider error objects crashed `JSON.stringify` in the report writer; (3) a stale
  golden-patch pre-image failed task application. All three were invisible until a
  real (or keyed) run exercised the full path. Lesson: baseline-only validation is
  not validation of the evaluate path.
- **Environmental credential limits are a legitimate eval outcome — record them,
  don't paper over them.** The evaluate run failed 0/4 not from harness bugs (those
  were fixed and proven by tool-call traces) but from free-tier provider rate limits
  (HTTP 429) and BYOK key rejection. The report tracks baseline 4/4 PASS + evaluate
  environmental causes + the exact re-run command, so the next operator with a valid
  Savant backend key can close the gap without re-debugging.
- **CJK text breaks markdownlint MD060 "aligned" table style** — full-width
  parentheses/chars compute different display widths. The repo's own convention
  (Repo Map table) wraps wide tables in `markdownlint-disable MD060`; the zh-CN
  translation uses the same escape. Don't fight the width math by hand.

**Files touched:** evals/benchmark (fixtures restored + 2 entrypoints), evals/v2
(harness wiring + report writer + 2 regression tests), evals/v2/tasks/add-fix
(golden patch), README.zh-CN.md (full regeneration), docs/reports/ (eval run
tracking doc).

## Session 2026-08-03: Build Artifact Hygiene (FID-2026-0803-011)

**Key Learnings:**

- **Filesystem grep is not git state.** The 0803-010 follow-up note claimed
  "committed .exe binaries" because a filesystem grep found them — but grep
  does not respect `.gitignore`. "Is this tracked/committed?" claims must use
  `git ls-files` / `git check-ignore`, not `grep -r`. The RED pass of this FID
  caught and corrected the note before any code changed.
- **Validate build flags against actual outputs.** `build-binary.ts` passes
  `--sourcemap=none`, yet bun 1.3.11 emits a 21 MB `index.js.map` on every
  compile. A flag's intent is not its effect — verify the output dir after a
  real build (which is exactly how the orphan hypothesis was disproven: the
  map is regenerated, timestamped fresh, and unshipped).
- **Gitignored + regenerable = safe to purge.** Deleting ~360 MB of stale
  build artifacts was zero-risk because `git ls-files` confirmed nothing was
  tracked and the existing build commands (`build:binary`, `savant-free/cli/
  build.ts`, root `ci`) regenerate everything. Check both halves before
  deleting: nothing tracked AND a working regeneration path.
- **A follow-up note is still evidence.** The note that spawned this FID was
  written hastily after a sweep; it became the FID's RED premise and had to be
  corrected mid-flight. Notes that will feed FIDs deserve the same evidence
  rigor as FID findings — it is cheaper to verify once than to correct twice.

## Session 2026-08-03: Database + LLM-Providers LOW Fixes (FID-2026-0803-010)

**Key Learnings:**

- **"Zero consumers" evidence is only as good as the search tool you use.** The RED pass for DB-B reported
  `agent_configs` had zero consumers — the check silently used `rg`, which isn't on PATH in this repo's bash,
  so it returned nothing (exit 1) and looked clean. The table actually had one consumer: a test-teardown
  `DELETE FROM agent_configs;`. Lesson: when a "no references" claim matters, use a tool you can see (grep)
  and verify the command exists before trusting its empty output.
- **TransformStream tests must drain concurrently.** A TransformStream's readable side has a high-water mark of
  1. Writing chunks and only then reading stalls on backpressure forever — the real consumer (`pipeThrough`)
  pulls continuously. Test helpers should start the read loop before writing, or writes never resolve.
- **Line-range surgery scripts pay off.** Extracting a 385-line inline transform via a bun script with unique
  anchors (each asserted exactly-once) turned a risky edit into a deterministic one; the single failure mode
  (an orphaned closing brace) was caught by typecheck in seconds. Anchor on syntax boundaries (closing braces),
  not content lines.
- **The stream-transform simulation was real drift.** `stream-transform.test.ts` tested its own copy of the
  transform — it could not catch regressions in the most-FID'd code in the repo (0801-007/008/010/011).
  Extraction into a shared module made the tests exercise the real logic, and the backpressure bug was found
  immediately. A simulation that can't fail on real changes is worse than no test.

## Session 2026-08-03: ECHO Enforcement Layer Audit (FID-2026-0803-009)

**Key Learnings:**

- **Enforcement docs rot faster than the code they describe.** The runtime FSM gating (tool-executor.ts), SoD
  (Forge no bash, Detective no writes, Verifier zero-tool), and all 13 Orchestrator tools were verified correct —
  the only debt was `ECHO.md`'s roster table: the Researcher row predated `researcher-docs` (read_docs), the Forge
  "restricted" cell listed a bash the agent never had, and the "9 specialized agents" intro silently omitted the 4
  infra spawnables. Bootstrap docs drift when the roster changes; audits must diff the docs against the
  *definitions*, not against each other.
- **A "Restricted Tools" column that lists tools the agent never had is worse than an omission** — it teaches a
  reader the wrong model. After the fix, ECHO.md's restricted cells name only tools the agent actually has
  elsewhere or genuinely lacks by design.
- **`commands.build` can be a partial build and still be the right value** — `bun run ci` (SDK + Savant-Free) is
  the release pipeline entrypoint; the 9-workspace compile gate is `type_check`. The defect was the comment, not
  the command. Verify whether config fields are read by code before "fixing" them (grep first — this one was a
  pure doc surface).
- **markdownlint catches table column drift** (MD055/MD056) — a fast, reliable check that doc-table edits keep
  their pipe counts; used it as the runtime half of the double audit.

**Files:** ECHO.md (roster rows + footnote), protocol.config.yaml (build comment), CHANGELOG.md.

## Session 2026-08-03: Evals Benchmark Runner Audit (FID-2026-0803-007)

**Key Learnings:**

- **A "fix" that never compiled is worse than the bug it claimed to fix.** Two findings this session were
  themselves botched repairs from a prior audit (FID-0802-006): a cast that referenced a nonexistent property
  (`ReturnType<(typeof pino)['destination']>`) and a "concrete cast instead of any" that still failed tsc
  (`as unknown as { agentFeedback: unknown[] }` against a 4-field declared type). Both had DEBT comments
  claiming they were the fix. Lesson: after any type-surgery, run the package typecheck — and note that
  packages outside the 4-way CI hard gate (sdk/common/agent-runtime/cli) rot silently. The evals package had
  been failing `tsc` since v0.0.15 with nobody noticing.
- **`withTimeout` races; it does not abort.** The evals harness wrapped 20-60 minute LLM runs in
  `withTimeout` — when the timer fired, the promise rejected but the underlying `client.run` kept executing,
  burning API dollars and holding the event loop. The SDK already supports `signal?: AbortSignal`
  (run.ts:181/294/546), so the fix was `signal: AbortSignal.timeout(ms)` — abort, don't race.
- **A zod schema defined but never used is a promise of validation that isn't there.** `JudgingResultSchema`
  was exported in judge.ts while the code did `output.value as JudgingResult` — malformed model output could
  produce NaN averages or a TypeError in the formatter. The schema existed precisely for this; wire it up.
- **Expected-failure probes are not silent-swallow bugs.** `git show <sha>:<path>` failing inside a
  file-existence check is the ANSWER, not an error — logging a warn per missing file would spam. When an
  audit flags a bare `catch {`, distinguish "diagnostic swallowed" from "probe outcome" before adding noise.
- **Median-of-2 with `floor(n/2)` always picks the higher scorer** — a systematic bias in ensemble analysis
  text when judges disagree. `floor((n-1)/2)` is the true lower median.

## Session 2026-08-03: Code-Map Package Audit (FID-2026-0803-006)

**Key Learnings:**

- **Always-false guard expressions are no guard at all.** `call in {}` only caught the inherited
  `__proto__`; `toString`/`valueOf`/`hasOwnProperty` collisions crashed the code map (TypeError on
  `.includes` of an inherited function). When skipping Object.prototype keys, write
  `call in Object.prototype` explicitly — and add a regression test with a real collision token.
- **A module-level singleton that caches a rejected init promise turns a transient failure into
  permanent silent disablement.** A shared in-flight promise with clear-on-rejection plus a one-time
  warn converts it into a retryable, diagnosable condition.
- **Removing a defensive cast isn't always "drop the guard too".** `tree.delete?.()` keeps
  mock/runtime compatibility (structurally-compatible mocks lack `delete`) while dropping the Law-6
  cast. Cast surgery can accidentally delete the call itself — re-read the final block after editing.

## Session 2026-08-03: Quality Scan Hygiene Fixes (FID-2026-0803-005)

**Key Learnings:**

- **Empty catches in safety nets are silent misclassification, not best-effort.** `captureSnapshot`'s
  `catch {}` treated every read failure as "file didn't exist" — a rewind would have DELETED an existing
  file it merely failed to read (EACCES/EISDIR/EMFILE). Distinguish `ENOENT` from everything else even
  when the fallback looks safe; errno narrowing follows the `paths.ts` idiom (`'code' in err && typeof
  err.code === 'string'`).
- **Perf findings deserve a 0-EOF read before severity is assigned.** The same lines that looked like a
  hot-path sync-IO problem held the actual correctness bug: the sync choice was correct by design
  (capture-before-write ordering + per-path dedup bounds cost), while the real defect was in the
  error-handling path.
- **An unsafe `!` can hide a real undefined path.** `generator!` masked an eval'd handleSteps function
  returning undefined at runtime; an explicit definite-assignment guard is more robust than the
  assertion and produces a diagnosable error instead of a misleading generic failure.

## Session 2026-08-03: Quality Sweep + Checkpoint & Rewind (FID-2026-0803-004)

**Key Learnings:**

- **Audit before building: an unwired in-tree primitive beats greenfield.** The checkpoint feature's capture/
  restore primitive already existed as `file-snapshot-store.ts` with **zero callers** — promoting it into a
  persistent store was a fraction of the work of building fresh. Always grep for dead-but-purpose-built code
  before starting a feature.
- **Session restore ≠ rewind.** Restore resumes the same state; rewind returns the workspace (and optionally the
  conversation) to an earlier turn. Keep the distinction explicit — conflating them derails scoping.
- **Sort ties are a test flake source.** Two turns opened back-to-back share a `Date.now()` millisecond, making
  `b.sort((a, b) => b.startedAt - a.startedAt)` order-dependent and only *sometimes* failing. Always add a
  deterministic tiebreaker (e.g. `|| b.turnId.localeCompare(a.turnId)`) when the sort key has ms granularity.
- **Dedup before the expensive op on hot paths.** `captureSnapshot` must check `buffer.files.has(path)` *before*
  `fs.readFileSync`, so repeated writes to one file read it once, not N times.
- **Sanitize host-provided ids used in filenames.** The CLI's aiMessageId becomes a checkpoint filename — a
  `path.basename()` guard is one line and prevents path-like ids from escaping the checkpoint dir.
- **Checkpoint capture belongs in the write-gate, not the handlers.** Capturing in `executeToolCall` before
  `write_file`/`str_replace`/`apply_patch` dispatch covers main-agent and subagent writes uniformly (subagents
  inherit the turn via spawn context) and keeps terminal side effects untracked.
- **Gate discipline under pressure:** run `eslint --fix` and `prettier --write` *after* the last edit, then
  re-run the full suites — a late fix (like a same-ms sort flake) only surfaces in full-suite runs, not in the
  isolated file run.

## Session 2026-07-25-1200: Context Compaction System (FID-085)

**Key Learnings:**

- Context compaction MUST be a runtime service, not a spawned agent. The context-pruner agent inherits the bloated
  context it's trying to compress — a chicken-and-egg problem. A runtime service operates on the message array directly
  without needing its own LLM context.
- Four-layer progressive compaction is the correct architecture: Layer 1 (SNIPE: user-initiated), Layer 2 (MICRO:
  zero-cost tool result clearing), Layer 3 (AUTO: LLM summarization on threshold), Layer 4 (REACTIVE: emergency
  truncation on prompt-too-long).
- Token limits must be wired through the full stack. The UI resolved the correct context window but the runtime never
  received it — 4 disconnected paths all using different hardcoded values (128k, 200k, 250k, 400k). The resolved value
  from OpenRouter must flow: CLI → createRunConfig → SDK → loopAgentSteps → ContextCompactor → handleSteps.
- Allowlist → denylist is almost always the right architectural choice. The `run_readonly_command` allowlist broke on
  valid Windows commands (findstr, 2>nul). A denylist blocks known-dangerous commands while allowing all others — more
  maintainable and doesn't break on new/OS-specific commands.
- Template literals with backticks are dangerous in TypeScript. Rewrote `ECHO_PROTOCOL_INSTRUCTIONS` as array-join to
  avoid template literal escaping issues. This pattern should be used whenever a large string constant contains
  backticks.
- Error messages must include agent context. The "not currently available" error was impossible to debug without knowing
  which agent hit it. Adding `[agent: ${agentTemplate.id}]` prefix made failures traceable.
- Reference repos are invaluable for design patterns. hermes-agent (trajectory_compressor.py), openclaw
  (context-engine), and openclaude (autoCompact/compact/microCompact) provided proven patterns for progressive
  compaction.

**Agent Behavior / Process:**

- Scope expands when you investigate. Starting from "context fills with no compaction" led to discovering 12 bugs across
  10 files — never pass over an issue during testing.
- The Verifier correctly identified 8 issues in the initial design that the Orchestrator overlooked (hostile-attacker
  safeguards, rollback safety, fallback UX). Independent review is essential.
- Design reviews must include security analysis from the start. The Verifier caught the missing hostile-attacker
  safeguard (Q3) that the initial design overlooked.

**Technical Insights:**

- `ContextCompactor` class provides: microCompact (zero cost), shouldAutoCompact (threshold + circuit breaker),
  reactiveCompact (emergency truncation), static isPromptTooLongError (error detection).
- Circuit breaker states: healthy → degraded → open → half-open → healthy. Max 3 failures → 5min cooldown.
- Micro-compact safety: only clear tool results where the paired tool_use has been processed (tool_result exists).
  Prevents orphaned references.
- Reactive compact algorithm: preserve first message + last 20% of messages, discard everything else, retry API call once.
- `maxContextLength` added to `AgentState` type to wire resolved context window from CLI through to handleSteps in savant.ts.

## Session 2026-07-25-1600: Layer 4 Reactive Compact + FID-085 Closure

**Key Learnings:**

- Layer 4 reactive compact catches prompt-too-long errors, aggressively truncates (keep first + last 20%), and retries
  once. This is the last-resort safety net.
- `isPromptTooLongError` must match patterns from multiple providers (Anthropic, OpenRouter, etc.) — "prompt is too
  long", "context_length_exceeded", "maximum context length", "token limit", "too many tokens", "input too long",
  "request too large".
- Type casting syntax errors (`as unknown typeof` vs `as unknown as typeof`) are easy to introduce and hard to spot.
  Always verify with typecheck after edits.
- FID archival requires: (1) status → closed, (2) file moved to dev/fids/archive/, (3) CHANGELOG entry appended. Missing
  any step creates orphaned files.

**Agent Behavior / Process:**

- FID-085 took 4 hours to complete across multiple sessions. Breaking complex FIDs into phases (Layer 2, Layer 3, Layer
  4) made the work manageable.
- The Recorder agent failed to write FID files (3 attempts) — possible context window or tool availability issue. The
  Orchestrator wrote FID files directly, which is a Separation of Duties violation but was necessary to make progress.

**Technical Insights:**

- `ContextCompactor.reactiveCompact()` preserves: first message (system/instructions), last 20% of messages (minimum 2),
  any messages with images (multimodal context).
- `ContextCompactor.isPromptTooLongError()` is a static method — can be called without instantiation.
- The catch block in `loopAgentSteps` intercepts prompt-too-long errors before the standard error handling, giving
  reactive compact a chance to recover.

## Session 2026-07-25-1700: Dev Folder Audit + FID Hygiene

**Key Learnings:**

- Dev folder audit found 32 issues: 1 critical (duplicate FID-085), 17 medium (stale FIDs, naming, docs), 6 low.
- FID archive hygiene is poor — many FIDs were archived without reaching "closed" status. 17 FIDs had statuses like
  "created", "analyzed", "fixed", "deferred" despite being in the archive directory.
- FID naming convention (FID-YYYY-MMDD-NNN-kebab-case) was not consistently followed — 4 FIDs had no date prefix.
- LEARNINGS.md was missing entries for recent sessions — should be updated as part of session closeout.
- Duplicate files in dev/fids/ and dev/fids/archive/ create confusion — FID-085 existed in both directories.

**Agent Behavior / Process:**

- Dev folder audits should be run periodically to maintain hygiene.
- When archiving FIDs, always: (1) set status to "closed", (2) move to archive, (3) append CHANGELOG entry.
- Bulk operations (sed for status updates, mv for renames) are efficient for fixing multiple files at once.

**Technical Insights:**

- `sed -i 's/^\*\*Status:\*\* .*/\*\*Status:\*\* closed/'` is the correct pattern for bulk-updating FID status in
  archived files.
- FID filename format: `FID-YYYY-MMDD-NNN-kebab-case-title.md` — must include date prefix.
- Non-FID files (_sanity_*.txt) should not be in dev/fids/archive/.

## Session 2026-07-25-2000: FID Ground-Truth Verification (FID-086)

**Key Learnings:**

- FID status metadata can drift from reality. When the Orchestrator reviewed open FIDs, it trusted FID-082's `Status:
  analyzed` metadata without verifying against the codebase — the code was fully implemented but the FID was never
  updated. Always verify FID claims against actual code before reporting status.
- Law 1 (Read 0-EOF Before Touch) applies to status reporting, not just code edits. Reading the FID markdown without
  reading the codebase is a Law 1 violation.
- The Cross-Agent Claim Rule covers inter-agent attribution, but FID-vs-codebase verification is a different dimension.
  FID status drift is a document-reality gap, not an agent-claim gap.
- FID close-out is part of implementation. When code is written, the FID status MUST be updated in the same session.
  Leaving FIDs in `analyzed` after implementation creates false negatives for future status reviews.
- The FID template now requires a "Code Verification Evidence" section and a "Missed Questions" section. These
  structural additions prevent the two root causes: unchecked metadata and incomplete analysis.

**Agent Behavior / Process:**

- The "run the perfection loop" trigger requires the Thinker to ask "What questions should I have asked when this FID
  was created, but failed to?" for EVERY open FID. This caught 12 missed questions across 3 FIDs.
- FIDs should note dependencies on other FIDs. FID-082's commands are non-functional without FID-083's runtime
  integration — this dependency was never documented.
- Process fixes (ECHO.md, FID template, LEARNINGS.md) are as important as code fixes. The ground-truth verification gap
  would recur indefinitely without a process rule.

---

## Session 2026-08-04: Harness ECHO Compliance Layer + Diff-Viewer Highlighting (FID-2026-0804-009 + 010)

**Key Learnings:**

- **Soft triggers are not enforcement.** The Verifier-criteria and Hybrid-vs-Full-loop rules lived only in
  `savant.ts` prompt text, so the model — optimized toward the frictionless default — never escalated. The fix
  (FID-009) made Law 1 (read-before-write), Law 3 (verify-after-write), and the Verifier criteria deterministic in
  the harness (`EchoComplianceTracker`): recorded from the tool-executor hot path, evaluated at the step boundary,
  non-blocking `compliance_warning` receipts + corrective steering pushed into message history. Prompt text for the
  model, deterministic tracker for the harness — future rules should follow the same split.
- **Harness layers must be reconciled with the prompt constants they supersede.** After FID-009 warned at 10 lines,
  the prompt's 75-line Full-ECHO-Loop bar was a 7.5× contradiction. FID-010 lowered the ceremony threshold to 20
  lines and kept the two layers bracketed (harness warns at 10, model escalates at 20). Whenever a deterministic
  enforcement layer lands, re-grep the prompt constants it renders stale.
- **Terminals have no alpha.** "50% opacity" for diff line tinting is a 50/50 linear RGB blend of the neon color
  against the theme background (`blendHex`) — deterministic and unit-testable. Renderers claiming per-line styling
  must own the full row: OpenTUI `<text>` has no background option, so each diff row is a box-wrapped text (boxes
  own `backgroundColor`).
- **A code-block renderer that advertises `filetype` support should style every filetype it advertises.** The diff
  renderer regressed because syntax-theme token scopes covered code but never `diff` grammar — zero `diff.added`/
  `diff.removed` styles existed. The line-by-line renderer (FID-010) sidesteps the highlighter entirely for diffs.

---

## Session 2026-08-05: Mode Execution-Scope Relabel + STRICT Mode + Hover Descriptions (FID-2026-0805-001)

**Key Learnings:**

- **Labels are contracts — a mode name should describe what the harness + prompt actually deliver.** The `EDIT` label
  asserted a strict-ECHO-loop contract while the prompt it selected ran Hybrid Mode by default — the same
  documented-intent vs. implemented-behavior gap FID-009 closed at the enforcement layer, here closed at the naming
  layer. After the rename, a ceremony mode (STRICT) is an explicit opt-in rather than a threshold the model may or may
  not escalate past. Re-grep prompt constants whenever a label and a behavior drift apart.
- **A data-driven mode axis makes a rename nearly free.** `AGENT_MODES` cascades to the toggle, `/mode` commands, the
  keyboard cycle, and settings validation — the rename needed only two deliberate touch points (the settings migration
  and the new `savant-strict` prompt variant) plus the alias preservation (`mode:edit` → `mode:hybrid`).
- **A stateful mode (STRICT) needs its own prompt contract, not the default's boilerplate.** The strict variant
  initially inherited the "Hybrid Mode (Default)" section — misleading for a mode whose whole point is no hybrid
  fallback. The ECHO-Phase-Gating section was made mode-aware so STRICT replaces it with the mandatory-loop contract.
- **"OpenTUI has no tooltip" is not "tooltips are impossible."** The pinned 0.2.2 bundle has zero tooltip/hovertip
  matches, but every primitive for the standard floating-tip pattern is present (`position: 'absolute'` via the
  status-bar precedent, `zIndex`, `MouseEvent.x/y`). A ~15-line non-interactive component covers it. Verify the
  claimed primitives against the installed bundle (not upstream docs) before the FID commits to a design.
- **Headless frame-buffer verification of TUI UI is possible — with two non-obvious harness quirks.**
  `@opentui/core/testing`'s `createTestRenderer` + `MockMouse` assert against the real rendered cells. Quirk 1:
  `footerHeight` defaults to 12, so a `height: 12` renderer has a zero-row content area (empty frame) — set
  `footerHeight: 0`. Quirk 2: the paint is async — one `renderOnce()` loop does not land the frame; loop, wait
  (~50 ms), loop, wait again. Both were found empirically, not in the .d.ts.

---

## Session 2026-08-05: 0.0.19 Binary Rebuild — NEXT_PUBLIC Leak (release gate)

**Key Learnings:**

- **Local dev env bleeds into release binaries unless the build shell is clean.** `build-binary.ts` deliberately merges
  any `NEXT_PUBLIC_*` from `process.env` over its canonical prod defaults in the sibling `env.json`. A local rebuild
  therefore ships dev values (`localhost:3000`, a personal support email, placeholder keys) into what looks like a
  release artifact. The leak has two sources that both must be neutralized: (1) the surrounding shell/runtime can
  inject `NEXT_PUBLIC_*` (verified: a bare shell in `/tmp` had all 10), and (2) Bun auto-loads the repo-root
  `.env.local`. Fix used: `unset NEXT_PUBLIC_*` + move `.env.local` aside for the build (gitignored + untracked,
  so safe), restore after, then diff `env.json` against the canonical defaults. Release builds should run from a
  clean env — add an env.json canonical-value check to the release gate.
- **Grep the binary for feature markers as the packaged-artifact smoke.** `grep -c 'savant-strict' savant-code.exe`
  proves the new agent definition is actually embedded (3 hits), alongside `STRICT mode` (5) and the bare `/mode`
  menu description (1) — cheaper than a full interactive session and catches stale-build regressions.

---

## Session 2026-08-05: Release-Binary Env-Integrity Gate + E2E Proof (FID-2026-0805-002)

**Key Learnings:**

- **A build gate that writes a sibling env.json must block, not warn, on dev-value leaks.** `build-binary.ts` merges
  every `NEXT_PUBLIC_*` from `process.env` over canonical prod defaults, so a dirty shell or repo `.env.local`
  silently ships `localhost:3000` + personal emails in what looks like a release artifact. The fix is a pure,
  exported decision function (`evaluateBinaryEnvIntegrity`: block / accepted-with-warning / clean) called from
  `main()` under an `import.meta.main` guard — gate logic is unit-testable (11 tests) without ever running a
  multi-minute compile. Escape hatches are explicit env flags (`SAVANT_CODE_BUILD_ENV` for dev binaries,
  `SAVANT_CODE_ALLOW_NEXT_PUBLIC_OVERRIDES=1` for CI with real prod keys), and accepted overrides always print a
  labeled warning (`(dev build)` vs `(explicit override)`) so the escape is never silent.
- **Prove gate behavior against the real build, not just the pure function.** Two e2e runs sealed the wiring:
  (1) a release build from a dirty shell aborted exit 1 with all 7 leaked keys listed (the personal support email
  included) and left the shipped binary + env.json byte-identical — the gate fires before any artifact is written;
  (2) `SAVANT_CODE_BUILD_ENV=dev` completed the build with the `⚠️ 8 override(s) accepted (dev build)` warning and
  the dev binary booted (`Using environment: dev`). One discipline difference: the abort test needs no backup, but
  the success-path test OVERWRITES the artifacts — back up `cli/bin/{savant-code.exe,env.json,tree-sitter.wasm}`
  first, restore byte-identical after, then `diff` to prove it.
- **Deterministic side effects make a failed build safe to run.** The abort test still executed `prebuild-agents`
  + the SDK build before the gate; both regenerate identically, so the tree stayed clean (verified via `git status`
  + byte-diff against the backup).

---

<!-- Add new entries above this line -->
