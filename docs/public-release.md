# Public Release Workflow

The canonical public release command is `scripts/public-release.ts`. It is the only
supported path for publishing the public Savant-Code release and SDK together.

## Commands

```bash
# Validate repository identity, version metadata, and the current CHANGELOG section.
# This never changes settings, stages files, commits, tags, GitHub, or npm.
bun run release:public:preview

# Manual mode: run the complete release transaction after an interactive RELEASE confirmation.
bun run release:public

# Continue a recorded partial release after a failure.
bun run release:public:resume

# Run the exact local build/typecheck/test/lint/format/package gates read-only.
# This never tags, pushes, creates a GitHub release, or publishes npm packages.
bun run release:public:diagnose
```

## CLI command flow

The same operations are available as CLI commands — interactively via the `/release`
slash command in the Savant-Code TUI, or standalone in any shell via
`savant-code release <op>` (both share one handler):

```bash
savant-code release status      # version, git position, tag, last receipt + diagnostic evidence
savant-code release preview     # read-only sanity check — never mutates
savant-code release diagnose    # read-only 8-gate manifest with evidence (investigate failures)
savant-code release go          # full release: gates → tag → push → GitHub release → npm publish
savant-code release resume      # continue a recorded partial release after a failure
```

In the TUI, `/release <op>` streams the engine's output into the chat as it runs and
finishes with a summary bubble. The full release runs under the pinned-Bun
self-bootstrap and writes the same `release-receipt/v2` evidence as the npm script
forms. Exit codes for the standalone subcommand: `0` ok, `1` release failure,
`2` usage error.

For the zero-command public-development workflow, set
`SAVANT_CODE_RELEASE_AUTOMATION=1` in the already-configured release environment.
The automation path consumes `GITHUB_TOKEN` (falling back to `GH_TOKEN`), uses the
GitHub REST API directly, performs a token-safe Git push, stages and commits all current
tracked and untracked changes, and does not require the `gh` executable or an interactive
prompt. npm continues to use its existing authentication configuration.

Automation is deliberately opt-in. Without that flag, the normal command remains
interactive and requires `gh` authentication plus a clean worktree. Preview mode always
wins over automation and remains mutation-free.

## Public targets

The workflow is intentionally limited to:

1. `@savant-code/sdk` from `sdk/`
2. `savant-code` from `cli/release/`

The SDK is published first. `savant-free` is not public and is never included.

By default both packages are published. To scope a release to a subset of the public
packages, set `SAVANT_CODE_RELEASE_PACKAGES` to a comma-separated list of package names;
the npm-pack dry-run gates, npm access verification, not-already-published checks,
publishing, and post-publish verification all follow the scope. Names that match no
public package abort the run fail-closed (a typo can never silently publish nothing).
For example, release only the CLI package without publishing the SDK:

```bash
SAVANT_CODE_RELEASE_PACKAGES=savant-code SAVANT_CODE_RELEASE_AUTOMATION=1 bun run release:public
```

## Transaction order

Manual mode and automation mode share the same release stages:

1. Verify the public `savant0x/savant-code` remote and aligned version metadata.
2. Extract exactly one current-version section from `CHANGELOG.md` for GitHub notes.
3. Validate GitHub and npm authentication. Automation validates the GitHub token with
   the REST API; manual mode validates `gh auth status`.
4. Snapshot the release routing environment and persisted settings file.
5. In automation mode, stage all current changes and create one
   `chore(release): prepare v<version>` commit. The receipt records the commit and file list.
6. Apply non-secret OpenRouter direct defaults (`openrouter/free`).
7. Run build, typecheck, test, ESLint, Markdownlint, Prettier, and package dry-run gates.
8. Manual mode asks for confirmation listing exact targets. Automation records its explicit
   environment approval and continues without a prompt.
9. Create the annotated tag and push `main` plus the tag with Git. Automation supplies a
   process-only Git extraheader; the token is never placed in argv, URLs, files, or logs.
10. Create or verify the GitHub release. Automation uses the GitHub REST API with the
    extracted changelog section; manual mode uses `gh`.
11. Publish the SDK, then the CLI package, and record each completed stage.
12. Restore the original local settings and environment in a `finally` path.
13. Verify the public tag, GitHub release, npm artifacts, and package contents.

A non-secret `release-receipt/v2` receipt is written under the operating system temporary
directory. Gate commands use file-backed capture and write complete, secret-redacted transcripts
outside the repository; the receipt stores each command's exit/signal/spawn classification,
attempt, bounded summary, transcript path/hash, and manifest hash. Receipt and transcript writes
are atomic, and resume rejects incomplete or legacy evidence. If publication fails after GitHub
creation, the workflow does not delete public history or unpublish packages. Use the explicit
resume command only after reviewing the receipt and diagnostic transcript.

The diagnostic command is the safe way to investigate a failed gate. It runs the canonical
read-only manifest and writes evidence without changing settings or invoking any public mutation.
The diagnostic is bound to the current HEAD and tracked worktree state: it fingerprints every
tracked file (and untracked, non-ignored path) before and after the gates and rejects the
evidence if any tracked path changed. Ignored artifacts that gates legitimately regenerate (for
example the CLI `debug/` logs or SDK build output) do not reject the evidence; instead, when the
full gate manifest completes, the receipt records the exact ignored paths the gates added or
removed as `ignoredChanges` so an auditor can distinguish expected generated output from
contamination. A worktree that is already
dirty before the diagnostic runs is captured in both fingerprints and does not by itself fail the
run. The release path applies the same tracked-state fingerprint around its gate manifest, so a
concurrent writer that changes tracked files mid-release fails the release before any push; note
that the guard covers the gate window only, so a writer that mutates tracked files after the last
gate but before `git push` is outside the fingerprint boundary (the residual window is seconds,
and resume re-binds to HEAD with the same guard). Timed-out gate children are cleaned up on
Windows only: the full owned descendant tree is
enumerated through the Win32 process table (up to ~20 seconds), terminated with `taskkill /T /F`,
and every enumerated owned PID is verified gone before cleanup is reported successful. Stragglers
are only killed after a fresh process-table read confirms they are still parented inside the
owned tree, so a PID reused by an unrelated process is never terminated. On non-Windows
platforms timeout cleanup remains evidence-only (recorded in the receipt) and the release never
proceeds after a timeout. The release path does not automatically retry a failed gate.
Bun `1.3.14` and npm `10.x` are required before the gate manifest is accepted.

## Release prerequisites

Manual mode requires:

- The operator has prepared and committed the version, changelog, README, and source
  changes before starting the workflow.
- The worktree is clean and `origin` is exactly
  `https://github.com/savant0x/savant-code.git`.
- `gh` is installed and authenticated for the public repository.
- npm is installed and authenticated with publish access to both public packages.

Automation mode requires:

- `SAVANT_CODE_RELEASE_AUTOMATION=1`.
- `GITHUB_TOKEN` or `GH_TOKEN` with repository release/write permission.
- npm installed and authenticated with publish access to the public packages being
  released.
- (Optional) `SAVANT_CODE_RELEASE_PACKAGES` to scope npm targets to a subset of
  `@savant-code/sdk` / `savant-code`.
- The process is allowed to create the release commit; all current tracked and untracked
  worktree changes are intentionally included by policy.

Both modes require the current version to be present exactly once as a
reverse-chronological `CHANGELOG.md` heading and all checked package manifests to match
`VERSION`. The script never copies API, GitHub, or npm credentials into the release
profile.

Bun `1.3.14` (pinned by `.bun-version`) and npm `10.x` are required for every gate
manifest. The script self-bootstraps the pinned Bun: at startup it verifies the `bun`
on PATH; if it is not `1.3.14`, it probes the version-pinned install
(`~/.bun-1.3.14/bin/bun` first, then the standard `~/.bun/bin/bun`) and prepends the
matching install's bin directory to the process PATH so every `bun`/`bunx` gate command
resolves to the required version. When neither PATH nor a pinned install provides
`1.3.14`, the run fails closed with install guidance. No manual PATH editing is needed
for daily pushes.

## Safety boundaries

The automation mode is not a hidden background release: it is enabled only by an explicit
environment flag and fails closed on missing credentials, unexpected GitHub HTTP statuses,
malformed API responses, mismatched tags, changed resume HEADs, failed local gates, and npm
publication errors. Preview never commits or calls a mutating external endpoint.
