/**
 * `/contribute` command — add yourself to the repo's CONTRIBUTORS.md and open
 * a PR via the gh CLI.
 *
 * Usage:
 *   /contribute              → uses `git config user.name` (fallback: usage)
 *   /contribute <username>   → adds @<username> to CONTRIBUTORS.md
 *
 * Note: the no-arg form resolves the repo's CURRENT git identity. Once bot
 * authorship is enabled (scripts/setup-bot-authorship.sh sets user.name to
 * "savant-code"), pass your own username explicitly.
 *
 * Behavior (FID-2026-0806-004 Task 2):
 * - Appends a `| @user | date |` row to CONTRIBUTORS.md (creating the file
 *   with a header when missing). Duplicate-safe: exits early if the username
 *   is already listed.
 * - Runs a git branch → commit → push → `gh pr create` flow so the change
 *   becomes a real PR. The flow operates on the project root (not
 *   process.cwd()), returns to the operator's original branch, and commits
 *   ONLY CONTRIBUTORS.md (other staged/worktree changes are never swept in).
 * - git/gh calls use execFileSync with argv arrays (no shell interpolation →
 *   no injection surface) and every step is Law-14 wrapped: any failure posts
 *   a message explaining the local file was still updated and how to finish.
 */

import { execFileSync } from 'child_process'
import fs from 'fs'
import path from 'path'

import { getProjectRoot } from '../project-files'
import { clearInput } from './command-shared'
import { getSystemMessage } from '../utils/message-history'

import type { CommandResult, RouterParams } from './command-registry'

/** Header written when CONTRIBUTORS.md does not exist yet. */
export const CONTRIBUTORS_HEADER = [
  '# Contributors',
  '',
  'Thank you to everyone who has contributed to Savant Code!',
  '',
  '| GitHub | Added |',
  '|--------|-------|',
].join('\n')

/** Injectable process runner (defaults to execFileSync) so tests can fake git/gh. */
export type ExecFn = (cmd: string, args: string[], cwd: string) => string

const defaultExec: ExecFn = (cmd, args, cwd) =>
  execFileSync(cmd, args, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim()

/**
 * Validates and normalizes a GitHub username.
 * GitHub usernames are alphanumeric + hyphens (max 39 chars). Anything else
 * (spaces, slashes, shell metacharacters, leading `@`) is rejected — this is
 * the injection boundary for every downstream git/gh argv.
 */
export function sanitizeUsername(raw: string): string {
  const trimmed = raw.trim().replace(/^@/, '')
  return /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,38})$/.test(trimmed) ? trimmed : ''
}

/**
 * Duplicate check against the contributors table. Matches the `@user` cell
 * bounded on the right by whitespace/EOL so `savant` does not match
 * `savant0x`. Case-insensitive.
 */
export function checkContributorExists(
  content: string,
  username: string,
): boolean {
  const escaped = username.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`@${escaped}(?=\\s|$)`, 'i').test(content)
}

/** Formats a single contributors-table row. */
export function formatContributorRow(username: string, date: string): string {
  return `| @${username} | ${date} |`
}

/**
 * Builds the new CONTRIBUTORS.md content: keeps the existing content (or
 * creates the header when the file is missing) and appends the new row.
 */
export function buildContributorsContent(
  existing: string | null,
  username: string,
  date: string,
): string {
  const base = existing ?? CONTRIBUTORS_HEADER
  const normalized = base.endsWith('\n') ? base : `${base}\n`
  return `${normalized}${formatContributorRow(username, date)}\n`
}

function todayIsoDate(): string {
  return new Date().toISOString().slice(0, 10)
}

/** Reads `git config user.name` from the repo-local config; '' when unset. */
function getGitConfigUsername(exec: ExecFn, cwd: string): string {
  try {
    return sanitizeUsername(exec('git', ['config', 'user.name'], cwd))
  } catch {
    return ''
  }
}

/** Last stderr line(s) from a failed git/gh call — enough to hint at the cause. */
function execErrorSummary(err: unknown): string {
  if (err instanceof Error) {
    const { stderr } = err as Error & { stderr?: unknown }
    const text =
      typeof stderr === 'string'
        ? stderr
        : Buffer.isBuffer(stderr)
          ? stderr.toString('utf8')
          : err.message
    const lines = text
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
    return lines.slice(-2).join(' ') || err.message
  }
  return String(err)
}

function gitBranchExists(exec: ExecFn, root: string, branch: string): boolean {
  try {
    exec(
      'git',
      ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`],
      root,
    )
    return true
  } catch {
    return false
  }
}

/**
 * Runs the branch → commit → push → PR flow. Only CONTRIBUTORS.md is ever
 * committed; the operator is returned to their original branch even on
 * failure (best effort). Returns the gh PR URL.
 */
export function runContributeGitFlow(
  projectRoot: string,
  username: string,
  exec: ExecFn = defaultExec,
): string {
  // Sanity: must be inside a git work tree.
  exec('git', ['rev-parse', '--is-inside-work-tree'], projectRoot)

  const originalBranch = exec(
    'git',
    ['rev-parse', '--abbrev-ref', 'HEAD'],
    projectRoot,
  )
  const branchName = `contribute/add-${username.toLowerCase()}`

  try {
    if (gitBranchExists(exec, projectRoot, branchName)) {
      exec('git', ['checkout', branchName], projectRoot)
    } else {
      exec('git', ['checkout', '-b', branchName], projectRoot)
    }

    // Commit CONTRIBUTORS.md only when it actually changed (a prior run may
    // have already committed the same row on an existing branch).
    const dirty = exec(
      'git',
      ['status', '--porcelain', '--', 'CONTRIBUTORS.md'],
      projectRoot,
    )
    if (dirty) {
      exec(
        'git',
        [
          'commit',
          '-m',
          `docs: add @${username} as contributor`,
          '--',
          'CONTRIBUTORS.md',
        ],
        projectRoot,
      )
    }

    exec('git', ['push', '-u', 'origin', branchName], projectRoot)

    return exec(
      'gh',
      [
        'pr',
        'create',
        '--title',
        `Add @${username} as contributor`,
        '--body',
        `Welcome @${username} to the Savant Code contributors! 🎯`,
        '--base',
        'main',
        '--head',
        branchName,
      ],
      projectRoot,
    )
  } finally {
    // Always land the operator back on their original branch.
    if (originalBranch !== 'HEAD') {
      try {
        exec('git', ['checkout', originalBranch], projectRoot)
      } catch {
        // Best effort — the real flow error (if any) takes priority.
      }
    }
  }
}

export async function handleContributeCommand(
  params: RouterParams,
  args: string,
  exec: ExecFn = defaultExec,
): Promise<CommandResult> {
  params.saveToHistory(params.inputValue.trim())
  clearInput(params)

  let projectRoot: string
  try {
    projectRoot = getProjectRoot()
  } catch {
    params.setMessages((prev) => [
      ...prev,
      getSystemMessage(
        'No project root is set — /contribute needs a git repository to run in.',
      ),
    ])
    return
  }

  // Resolve the username: an explicit arg wins; otherwise read git config.
  let username = sanitizeUsername(args)
  if (!username) {
    username = getGitConfigUsername(exec, projectRoot)
  }
  if (!username) {
    params.setMessages((prev) => [
      ...prev,
      getSystemMessage(
        [
          'Usage: /contribute [github-username]',
          '',
          'Example: /contribute spencer',
          '',
          'Adds you to CONTRIBUTORS.md and opens a PR so you become an official contributor. With no argument, the command reads `git config user.name`. Requires the gh CLI (`gh auth login`) and write access to the repo.',
        ].join('\n'),
      ),
    ])
    return
  }

  const contributorsPath = path.join(projectRoot, 'CONTRIBUTORS.md')

  let existing: string | null = null
  try {
    existing = fs.readFileSync(contributorsPath, 'utf8')
  } catch {
    existing = null // File does not exist yet — the header will be created.
  }

  if (existing !== null && checkContributorExists(existing, username)) {
    params.setMessages((prev) => [
      ...prev,
      getSystemMessage(
        `@${username} is already listed in CONTRIBUTORS.md — nothing to do.`,
      ),
    ])
    return
  }

  // Append the row locally first (durable even if the PR step fails below).
  try {
    fs.writeFileSync(
      contributorsPath,
      buildContributorsContent(existing, username, todayIsoDate()),
      'utf8',
    )
  } catch (err) {
    params.setMessages((prev) => [
      ...prev,
      getSystemMessage(
        `❌ Could not write CONTRIBUTORS.md: ${
          err instanceof Error ? err.message : String(err)
        }`,
      ),
    ])
    return
  }

  // Branch → commit → push → PR.
  try {
    const prUrl = runContributeGitFlow(projectRoot, username, exec)
    params.setMessages((prev) => [
      ...prev,
      getSystemMessage(
        [
          `✅ @${username} added to CONTRIBUTORS.md — PR opened.`,
          '',
          prUrl,
          '',
          'Approve or merge the PR to become an official contributor. 🎯',
        ].join('\n'),
      ),
    ])
  } catch (err) {
    params.setMessages((prev) => [
      ...prev,
      getSystemMessage(
        [
          '⚠️ CONTRIBUTORS.md was updated locally, but the git/gh flow failed:',
          '',
          execErrorSummary(err),
          '',
          'Make sure the gh CLI is installed and authenticated (`gh auth login`), the repo has an `origin` remote, and you have write access.',
        ].join('\n'),
      ),
    ])
  }
}
