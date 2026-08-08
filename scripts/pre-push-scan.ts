#!/usr/bin/env bun
// Pre-push credential scan: materializes the exact commit range being pushed
// and scans it with scanStagedCredentials (the same fail-closed scan that
// guards automation-mode release commits, audit finding F-A). This closes the
// leak window for committed content: a secret added in an earlier commit and
// pushed later with unrelated work is caught here even though the working
// tree is clean.
//
// Git invokes the pre-push hook with one line per ref being pushed on stdin:
//   <local ref> <local sha> <remote ref> <remote sha>
// The scan is fail-closed: any credential-shaped content blocks the push.

import { spawnSync } from 'child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import os from 'os'
import path from 'path'

import { scanStagedCredentials } from './public-release'

export type PushRef = {
  localRef: string
  localSha: string
  remoteRef: string
  remoteSha: string
}

const SHA_HEX = /^[0-9a-f]{40,64}$/i

/**
 * Parses hook stdin strictly: every non-empty line must be a well-formed
 * `<local ref> <local sha> <remote ref> <remote sha>` line, or the scan fails
 * closed. Git always emits well-formed lines, so a malformed line means an
 * unexpected git format or tampering — never a reason to scan less.
 */
export function parsePrePushRefs(stdin: string): PushRef[] {
  const refs: PushRef[] = []
  for (const line of stdin.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const parts = trimmed.split(/\s+/)
    const [localRef, localSha, remoteRef, remoteSha] = parts
    if (
      parts.length !== 4 ||
      !SHA_HEX.test(localSha) ||
      !SHA_HEX.test(remoteSha)
    ) {
      throw new Error(
        `unparseable pre-push ref line on stdin: ${JSON.stringify(trimmed)}`,
      )
    }
    refs.push({ localRef, localSha, remoteRef, remoteSha })
  }
  return refs
}

function runGit(root: string, args: string[]): string {
  const result = spawnSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    stdio: 'pipe',
    windowsHide: true,
  })
  if (result.status !== 0) {
    const detail = String(result.stderr ?? '').trim() || 'unknown git error'
    throw new Error(`git ${args[0] ?? ''} failed: ${detail}`)
  }
  return String(result.stdout ?? '')
}

/**
 * The commit range being pushed, oldest first. For an existing ref this is
 * `remote..local`; for a brand-new ref it is the commits since the merge-base
 * with origin/HEAD, or the entire local history when origin/HEAD is absent.
 * Scanning per-commit (not just a net tip-vs-tip diff) catches secrets that
 * were committed and later reverted inside the pushed range: the blob still
 * reaches the remote's history even when the final tree is clean.
 */
export function pushedRangeCommits(root: string, ref: PushRef): string[] {
  const isNewRef = /^0{40}$/i.test(ref.remoteSha)
  let base: string | undefined
  if (!isNewRef) {
    base = ref.remoteSha
  } else {
    try {
      base = runGit(root, ['merge-base', ref.localSha, 'origin/HEAD']).trim()
    } catch {
      base = undefined
    }
  }
  const args = base
    ? ['rev-list', '--reverse', `${base}..${ref.localSha}`]
    : ['rev-list', '--reverse', ref.localSha]
  const output = runGit(root, args)
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
}

/** Files touched by a single commit (vs its parents; merge commits include
 *  both parents via `-m`). */
export function commitChangedFiles(root: string, commitSha: string): string[] {
  const output = runGit(root, [
    'diff-tree',
    '-m',
    '--root',
    '-r',
    '--no-commit-id',
    '--name-only',
    commitSha,
  ])
  return [
    ...new Set(
      output
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0),
    ),
  ]
}

const SCAN_SIZE_CAP_BYTES = 2 * 1024 * 1024

/**
 * Materializes the pushed content of every changed file into a fresh temp
 * mirror (path structure preserved), so the scan reads exactly what the remote
 * would receive — never the working tree, which may already be clean.
 * Blobs over the scan cap are counted as oversized and skipped up front: they
 * cannot be content-scanned anyway, and size-checking avoids blowing the
 * spawn buffer on huge blobs (which would otherwise fail the whole push with
 * an opaque error instead of a bounded "oversized" notice).
 */
export function materializePushedContent(
  root: string,
  commitSha: string,
  files: readonly string[],
): { mirror: string; materialized: string[]; oversized: number } {
  const mirror = mkdtempSync(path.join(os.tmpdir(), 'savant-push-scan-'))
  const materialized: string[] = []
  let oversized = 0
  try {
    for (const file of files) {
      const size = spawnSync(
        'git',
        ['cat-file', '-s', `${commitSha}:${file}`],
        {
          cwd: root,
          encoding: 'utf8',
          stdio: 'pipe',
          windowsHide: true,
        },
      )
      // Deleted or unreadable paths yield nothing to scan.
      if (size.status !== 0) continue
      const blobSize = Number(String(size.stdout ?? '').trim())
      if (!Number.isFinite(blobSize)) continue
      if (blobSize > SCAN_SIZE_CAP_BYTES) {
        oversized += 1
        continue
      }
      const shown = spawnSync('git', ['show', `${commitSha}:${file}`], {
        cwd: root,
        encoding: 'buffer',
        stdio: 'pipe',
        windowsHide: true,
        maxBuffer: 16 * 1024 * 1024,
      })
      if (shown.status !== 0) continue
      const target = path.join(mirror, file)
      mkdirSync(path.dirname(target), { recursive: true })
      writeFileSync(target, shown.stdout)
      materialized.push(file)
    }
  } catch (error) {
    rmSync(mirror, { recursive: true, force: true })
    throw error
  }
  return { mirror, materialized, oversized }
}

/**
 * Runs the fail-closed credential scan over every ref on the hook stdin.
 * Returns the flagged descriptions; an empty array means the push is clean.
 * Any malformed ref line (or an unexpected hook format) throws so a git
 * version change or tampering can never silently disable the scan.
 */
export function runPrePushSecretScan(
  root: string,
  stdin: string,
): { flagged: string[]; scanned: number; oversized: number } {
  const refs = parsePrePushRefs(stdin)
  const flagged: string[] = []
  let scanned = 0
  let oversized = 0
  for (const ref of refs) {
    // A deletion ref (local sha all zeros) pushes no content — nothing to scan.
    // Accept 40- or 64-zero shas to stay consistent with SHA_HEX (SHA-256 repos).
    if (/^0{40,64}$/i.test(ref.localSha)) continue
    for (const commitSha of pushedRangeCommits(root, ref)) {
      const files = commitChangedFiles(root, commitSha)
      const {
        mirror,
        materialized,
        oversized: batchOversized,
      } = materializePushedContent(root, commitSha, files)
      try {
        oversized += batchOversized
        scanned += materialized.length
        flagged.push(...scanStagedCredentials(materialized, mirror))
      } finally {
        rmSync(mirror, { recursive: true, force: true })
      }
    }
  }
  return { flagged, scanned, oversized }
}
function main(): void {
  const root = process.cwd()
  let stdin = ''
  try {
    stdin = readFileSync(0, 'utf8')
  } catch {
    // No stdin available (e.g. manual invocation) — scan nothing, fail closed
    // with an explicit message instead of silently skipping.
  }

  if (!stdin.trim()) {
    console.error(
      'pre-push: no refs on stdin; refusing to push without a scan target.',
    )
    process.exitCode = 1
    return
  }
  try {
    const { flagged, scanned, oversized } = runPrePushSecretScan(root, stdin)
    if (flagged.length > 0) {
      console.error(
        `pre-push: ${flagged.length} credential-shaped file(s) in the pushed range:`,
      )
      for (const file of flagged) console.error(`  - ${file}`)
      console.error(
        'pre-push: refusing to push. Remove the secret, recommit, and retry (or use --no-verify if you accept the risk).',
      )
      process.exitCode = 1
    } else {
      console.log(
        `pre-push: credential scan passed (${scanned} file(s) scanned).` +
          (oversized > 0
            ? ` ${oversized} file(s) over the 2MB scan cap were not content-scanned.`
            : ''),
      )
    }
  } catch (error) {
    console.error(
      `pre-push: credential scan failed closed: ${error instanceof Error ? error.message : String(error)}`,
    )
    process.exitCode = 1
  }
}

if (import.meta.main) {
  main()
}
