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
```

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

A non-secret receipt is written under the operating system temporary directory. It records
completed stages, failures, restoration status, the automation commit, and the committed
file list; credentials are redacted before serialization. If publication fails after GitHub
creation, the workflow does not delete public history or unpublish packages. Use the
explicit resume command after reviewing the receipt.

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
- npm installed and authenticated with publish access to both public packages.
- The process is allowed to create the release commit; all current tracked and untracked
  worktree changes are intentionally included by policy.

Both modes require the current version to be present exactly once as a
reverse-chronological `CHANGELOG.md` heading and all checked package manifests to match
`VERSION`. The script never copies API, GitHub, or npm credentials into the release
profile.

## Safety boundaries

The automation mode is not a hidden background release: it is enabled only by an explicit
environment flag and fails closed on missing credentials, unexpected GitHub HTTP statuses,
malformed API responses, mismatched tags, changed resume HEADs, failed local gates, and npm
publication errors. Preview never commits or calls a mutating external endpoint.
