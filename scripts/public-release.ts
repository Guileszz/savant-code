#!/usr/bin/env bun

import { spawnSync } from 'child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import os from 'os'
import path from 'path'
import { createInterface } from 'readline/promises'

import {
  CANONICAL_NEXT_PUBLIC_DEFAULTS,
  CANONICAL_RELEASE_RUNTIME_DEFAULTS,
} from '../cli/scripts/build-binary'

export type PackageTarget = {
  name: string
  directory: string
  stage: 'NPM_PUBLISH_SDK' | 'NPM_PUBLISH_CLI'
}

type ReleaseOptions = {
  preview: boolean
  resume: boolean
  automation: boolean
}

export type LocalSnapshot = {
  env: Record<string, string | undefined>
  settingsPath: string
  settingsExisted: boolean
  settingsContent?: string
}

export type ReleaseReceipt = {
  version: string
  headSha?: string
  mode: 'preview' | 'publish' | 'automation'
  completedStages: string[]
  failedStage?: string
  restored: boolean
  receiptPath: string
  committedHead?: string
  committedFiles?: string[]
}

export const PUBLIC_REPOSITORY = 'https://github.com/savant0x/savant-code.git'
export const PUBLIC_REPOSITORY_SLUG = 'savant0x/savant-code'

// Keep the SDK first: the CLI package's release artifact depends on it.
export const PUBLIC_PACKAGES: readonly PackageTarget[] = [
  { name: '@savant-code/sdk', directory: 'sdk', stage: 'NPM_PUBLISH_SDK' },
  { name: 'savant-code', directory: 'cli/release', stage: 'NPM_PUBLISH_CLI' },
]

const PROFILE_ENV = {
  ...CANONICAL_RELEASE_RUNTIME_DEFAULTS,
  ...CANONICAL_NEXT_PUBLIC_DEFAULTS,
} as const

const PROFILE_ENV_KEYS = Object.keys(PROFILE_ENV)
const RELEASE_STAGES = new Set([
  'PREFLIGHT',
  'AUTHENTICATION',
  'AUTOMATION_COMMIT_ALL',
  'AUTOMATION_APPROVAL',
  'CONFIRMATION',
  'PUBLIC_PROFILE',
  'GATES_AND_PACKAGE_DRY_RUNS',
  'TAG',
  'GIT_PUSH',
  'GITHUB_RELEASE',
  'NPM_PUBLISH_SDK',
  'NPM_PUBLISH_CLI',
  'POST_RELEASE_VERIFY',
])

function fail(message: string): never {
  throw new Error(message)
}

function readJsonObject(filePath: string): Record<string, unknown> {
  if (!existsSync(filePath)) return {}
  const parsed: unknown = JSON.parse(readFileSync(filePath, 'utf8'))
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    fail(`Expected a JSON object: ${filePath}`)
  }
  return parsed as Record<string, unknown>
}

/** Extract exactly one current-version section from CHANGELOG.md. */
export function extractChangelogSection(
  changelog: string,
  version: string,
): string {
  const headingPattern = /^##\s+(?:\[)?v?(\d+\.\d+\.\d+)(?:\]|\s|$)(.*)$/gm
  const headings: Array<{
    version: string
    start: number
    date?: string
  }> = []
  for (const match of changelog.matchAll(headingPattern)) {
    const headingVersion = match[1]
    if (!headingVersion) continue
    const headingDate = match[2]?.match(/\b(\d{4}-\d{2}-\d{2})\b/)?.[1]
    headings.push({
      version: headingVersion,
      start: match.index ?? 0,
      date: headingDate,
    })
  }

  for (let index = 1; index < headings.length; index += 1) {
    const previous = headings[index - 1]
    const currentHeading = headings[index]
    const isOutOfOrder =
      previous.date && currentHeading.date
        ? previous.date < currentHeading.date
        : compareVersions(previous.version, currentHeading.version) < 0
    if (isOutOfOrder) {
      fail('CHANGELOG.md headings must be reverse-chronological.')
    }
  }

  const matches = headings.filter((heading) => heading.version === version)
  if (matches.length !== 1) {
    fail(
      `CHANGELOG.md must contain exactly one heading for v${version}; found ${matches.length}.`,
    )
  }

  const current = matches[0]
  const nextHeading = headings.find((heading) => heading.start > current.start)
  const section = changelog
    .slice(current.start, nextHeading?.start ?? changelog.length)
    .trim()
  if (!section) fail(`CHANGELOG.md section for v${version} is empty.`)
  return section
}

function compareVersions(left: string, right: string): number {
  const leftParts = left.split('.').map(Number)
  const rightParts = right.split('.').map(Number)
  for (let index = 0; index < 3; index += 1) {
    if (leftParts[index] !== rightParts[index]) {
      return (leftParts[index] ?? 0) - (rightParts[index] ?? 0)
    }
  }
  return 0
}

export function validateReleaseVersions(
  version: string,
  files: Record<string, string>,
): void {
  for (const [filePath, content] of Object.entries(files)) {
    const parsed = JSON.parse(content) as { version?: unknown }
    if (parsed.version !== version) {
      fail(`${filePath} is ${String(parsed.version)}; expected ${version}.`)
    }
  }
}

export function isReleaseAutomationEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return env.SAVANT_CODE_RELEASE_AUTOMATION === '1'
}

export function getGitHubToken(
  env: Record<string, string | undefined> = process.env,
): string {
  const token = env.GITHUB_TOKEN ?? env.GH_TOKEN
  if (!token)
    fail('GITHUB_TOKEN or GH_TOKEN is required for automated release.')
  return token
}

export function buildTokenSafeGitPushEnv(
  token: string,
): Record<string, string> {
  return {
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader',
    GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`,
    GIT_TERMINAL_PROMPT: '0',
  }
}

export function buildPublicReleasePlan(version: string): readonly string[] {
  return [
    `Validate ${PUBLIC_REPOSITORY}@v${version}`,
    'Snapshot local routing/settings state',
    'Apply the non-secret OpenRouter/free public profile',
    'Run public SDK/CLI build, typecheck, test, lint, format, and package gates',
    `Create annotated tag v${version}`,
    `git push origin main and v${version}`,
    `Create the GitHub REST release for v${version} with the current CHANGELOG section`,
    'npm publish @savant-code/sdk',
    'npm publish savant-code',
    'Verify public versions and restore local state',
  ]
}

function redactSecretText(value: string): string {
  return value
    .replace(
      /((?:OPENROUTER_API_KEY|OR_MASTER_KEY|INFERENCE_API_KEY|GITHUB_TOKEN|NPM_TOKEN)\s*[:=]\s*)(?:"(?:\\.|[^"\\])*"|[^\s,}]+)/gi,
      '$1[REDACTED]',
    )
    .replace(
      /(authorization\s*[:=]\s*(?:bearer|basic)\s+)[A-Za-z0-9+/=._~-]+/gi,
      '$1[REDACTED]',
    )
}

export function redactReceipt(receipt: ReleaseReceipt): string {
  return JSON.stringify(
    {
      ...receipt,
      failedStage: receipt.failedStage
        ? redactSecretText(receipt.failedStage)
        : receipt.failedStage,
    },
    null,
    2,
  )
}

export function isStageComplete(
  receipt: Pick<ReleaseReceipt, 'completedStages'> | undefined,
  stage: string,
): boolean {
  return receipt?.completedStages.includes(stage) ?? false
}

function repositoryRoot(): string {
  return path.resolve(import.meta.dir, '..')
}

function settingsPath(): string {
  const override = process.env.SAVANT_CODE_CONFIG_DIR
  if (override) return path.join(override, 'settings.json')

  const candidates = [
    path.join(os.homedir(), '.savant-code-dev', 'settings.json'),
    path.join(os.homedir(), '.savant-code', 'settings.json'),
  ]
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0]
}

function receiptPath(version: string): string {
  return path.join(os.tmpdir(), `savant-public-release-${version}.json`)
}

export function isNotFoundResult(result: {
  stdout: string
  stderr: string
}): boolean {
  const output = `${result.stdout}\n${result.stderr}`.toLowerCase()
  return /npm (?:err!|error)\s+(?:code\s+e404|404)|http 404|release does not exist|release not found|no matching version|no match found for version|is not in this registry/.test(
    output,
  )
}

export function validateResumeReceipt(
  version: string,
  parsed: ReleaseReceipt,
  filePath: string,
  expectedMode?: ReleaseReceipt['mode'],
): ReleaseReceipt {
  if (
    parsed.version !== version ||
    !['publish', 'automation'].includes(parsed.mode) ||
    (expectedMode && parsed.mode !== expectedMode) ||
    !Array.isArray(parsed.completedStages)
  ) {
    fail(`Resume receipt is incompatible with v${version}: ${filePath}`)
  }
  if (!parsed.restored) {
    fail(
      `Resume is refused because the prior run did not confirm local-state restoration: ${filePath}`,
    )
  }
  if (!parsed.headSha) {
    fail(`Resume receipt has no commit binding: ${filePath}`)
  }
  if (!/^[0-9a-f]{40}$/i.test(parsed.headSha)) {
    fail(`Resume receipt has an invalid commit binding: ${filePath}`)
  }
  if (
    new Set(parsed.completedStages).size !== parsed.completedStages.length ||
    parsed.completedStages.some((stage) => !RELEASE_STAGES.has(stage))
  ) {
    fail(`Resume receipt contains invalid or duplicate stages: ${filePath}`)
  }
  return { ...parsed, receiptPath: filePath }
}

function loadResumeReceipt(
  version: string,
  expectedMode: ReleaseReceipt['mode'],
): ReleaseReceipt | undefined {
  const filePath = receiptPath(version)
  if (!existsSync(filePath)) return undefined
  const parsed = JSON.parse(readFileSync(filePath, 'utf8')) as ReleaseReceipt
  return validateResumeReceipt(version, parsed, filePath, expectedMode)
}

export function snapshotLocalState(): LocalSnapshot {
  const currentSettingsPath = settingsPath()
  const snapshot: LocalSnapshot = {
    env: Object.fromEntries(
      PROFILE_ENV_KEYS.map((key) => [key, process.env[key]]),
    ),
    settingsPath: currentSettingsPath,
    settingsExisted: existsSync(currentSettingsPath),
  }
  if (snapshot.settingsExisted) {
    snapshot.settingsContent = readFileSync(snapshot.settingsPath, 'utf8')
  }
  return snapshot
}

export function applyPublicProfile(snapshot: LocalSnapshot): void {
  for (const [key, value] of Object.entries(PROFILE_ENV)) {
    process.env[key] = value
  }

  const settings = readJsonObject(snapshot.settingsPath)
  settings.savantCodeModelPreference = 'openrouter/free'
  settings.savantCodeModelProviderPreference = 'openrouter'
  settings.directProvider = 'openrouter'
  settings.directProviderBaseUrl = 'https://openrouter.ai/api/v1'
  mkdirSync(path.dirname(snapshot.settingsPath), { recursive: true })
  writeFileSync(snapshot.settingsPath, JSON.stringify(settings, null, 2))
}

export function restoreLocalState(snapshot: LocalSnapshot): void {
  for (const [key, value] of Object.entries(snapshot.env)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }

  if (snapshot.settingsExisted) {
    writeFileSync(snapshot.settingsPath, snapshot.settingsContent ?? '')
  } else {
    rmSync(snapshot.settingsPath, { force: true })
  }
}

function run(
  command: string,
  args: string[],
  cwd: string,
  capture = false,
  extraEnv?: Record<string, string>,
): { status: number; stdout: string; stderr: string } {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    stdio: capture ? 'pipe' : 'inherit',
    windowsHide: true,
    env: extraEnv ? { ...process.env, ...extraEnv } : process.env,
  })
  return {
    status: result.status ?? 1,
    stdout: result.stdout?.toString() ?? '',
    stderr: result.stderr?.toString() ?? '',
  }
}

function requireCommand(
  command: string,
  mutationMode: boolean,
): string | undefined {
  const result = run(command, ['--version'], repositoryRoot(), true)
  if (result.status === 0) return undefined
  const message = `Required command unavailable: ${command}`
  if (mutationMode) fail(message)
  return message
}

function runRequired(
  command: string,
  args: string[],
  cwd: string,
  extraEnv?: Record<string, string>,
): void {
  const result = run(command, args, cwd, false, extraEnv)
  if (result.status !== 0) {
    fail(`Stage command failed: ${command} ${args.join(' ')}`)
  }
}

function currentVersion(root: string): string {
  const version = readFileSync(path.join(root, 'VERSION'), 'utf8').trim()
  if (!/^\d+\.\d+\.\d+$/.test(version))
    fail(`Invalid VERSION value: ${version}`)
  return version
}

function verifyPreflight(
  root: string,
  version: string,
  mutationMode: boolean,
  allowExistingTag: boolean,
  automation = false,
): { notes: string; warnings: string[]; headSha: string } {
  const warnings: string[] = []
  const remote = run('git', ['remote', 'get-url', 'origin'], root, true)
  const pushRemote = run(
    'git',
    ['remote', 'get-url', '--push', 'origin'],
    root,
    true,
  )
  if (remote.status !== 0 || remote.stdout.trim() !== PUBLIC_REPOSITORY) {
    const message = `origin must be ${PUBLIC_REPOSITORY}; found ${remote.stdout.trim()}`
    if (mutationMode) fail(message)
    warnings.push(message)
  }
  if (
    pushRemote.status !== 0 ||
    pushRemote.stdout.trim() !== PUBLIC_REPOSITORY
  ) {
    const message = `origin push URL must be ${PUBLIC_REPOSITORY}; found ${pushRemote.stdout.trim()}`
    if (mutationMode) fail(message)
    warnings.push(message)
  }

  const changelog = readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8')
  const notes = extractChangelogSection(changelog, version)
  validateReleaseVersions(version, {
    'package.json': readFileSync(path.join(root, 'package.json'), 'utf8'),
    'sdk/package.json': readFileSync(
      path.join(root, 'sdk/package.json'),
      'utf8',
    ),
    'cli/package.json': readFileSync(
      path.join(root, 'cli/package.json'),
      'utf8',
    ),
    'cli/release/package.json': readFileSync(
      path.join(root, 'cli/release/package.json'),
      'utf8',
    ),
  })

  if (mutationMode) {
    const branch = run('git', ['branch', '--show-current'], root, true)
    if (branch.status !== 0 || branch.stdout.trim() !== 'main') {
      fail(
        `Mutation mode requires the main branch; found ${branch.stdout.trim()}`,
      )
    }
  }

  const status = run(
    'git',
    ['status', '--porcelain', '--untracked-files=all'],
    root,
    true,
  )
  if (status.status !== 0) fail('Unable to inspect the Git worktree.')
  if (status.stdout.trim()) {
    const message = automation
      ? 'Automation mode will commit all current worktree changes.'
      : 'Mutation mode requires a clean worktree.'
    if (mutationMode && !automation) fail(`${message}\n${status.stdout.trim()}`)
    warnings.push(`${message}\n${status.stdout.trim()}`)
  }

  const head = run('git', ['rev-parse', 'HEAD'], root, true)
  if (head.status !== 0 || !/^[0-9a-f]{40}$/i.test(head.stdout.trim())) {
    fail('Unable to resolve the release HEAD commit.')
  }
  const headSha = head.stdout.trim()
  const tagResult = run(
    'git',
    ['rev-parse', '--verify', `refs/tags/v${version}`],
    root,
    true,
  )
  const tagExists = tagResult.status === 0
  if (tagExists && allowExistingTag) {
    const tagCommit = run(
      'git',
      ['rev-parse', `refs/tags/v${version}^{}`],
      root,
      true,
    )
    if (tagCommit.status !== 0 || tagCommit.stdout.trim() !== headSha) {
      fail(
        `Existing tag v${version} does not point at release HEAD ${headSha}.`,
      )
    }
  }
  if (tagExists && !allowExistingTag) {
    const message = `Tag v${version} already exists; use --resume with its receipt.`
    if (mutationMode) fail(message)
    warnings.push(message)
  }

  return { notes, warnings, headSha }
}

type GitHubApiOptions = {
  token: string
  fetchImpl?: typeof fetch
}

export async function githubApiRequest<T>(
  endpoint: string,
  options: GitHubApiOptions & {
    method?: string
    body?: Record<string, unknown>
    expectedStatuses?: number[]
  },
): Promise<{ status: number; body: T | undefined }> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 30_000)
  try {
    const response = await (options.fetchImpl ?? fetch)(
      `https://api.github.com${endpoint}`,
      {
        method: options.method ?? 'GET',
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${options.token}`,
          'X-GitHub-Api-Version': '2022-11-28',
          ...(options.body ? { 'Content-Type': 'application/json' } : {}),
        },
        body: options.body ? JSON.stringify(options.body) : undefined,
        signal: controller.signal,
      },
    )
    const text = await response.text()
    const expected = options.expectedStatuses ?? [200]
    if (!expected.includes(response.status)) {
      if (response.status === 404 && expected.includes(404)) {
        return { status: response.status, body: undefined }
      }
      fail(`GitHub API request failed with HTTP ${response.status}.`)
    }

    let body: T | undefined
    if (text) {
      try {
        body = JSON.parse(text) as T
      } catch {
        fail(`GitHub API returned invalid JSON (${response.status}).`)
      }
    }
    return { status: response.status, body }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('GitHub API'))
      throw error
    fail('GitHub API request failed without exposing response details.')
  } finally {
    clearTimeout(timeout)
  }
}

async function assertGitHubToken(token: string): Promise<void> {
  await githubApiRequest<{ login?: string }>('/user', {
    token,
    expectedStatuses: [200],
  })
}

async function verifyGitHubTagHeadApi(
  version: string,
  expectedHead: string,
  token: string,
): Promise<void> {
  const reference = await githubApiRequest<{
    object?: { type?: string; sha?: string }
  }>(`/repos/${PUBLIC_REPOSITORY_SLUG}/git/ref/tags/v${version}`, {
    token,
    expectedStatuses: [200],
  })
  const object = reference.body?.object
  if (object?.type === 'commit' && object.sha === expectedHead) return
  if (object?.type !== 'tag' || !object.sha) {
    fail(`GitHub tag v${version} is not bound to release HEAD.`)
  }
  const annotated = await githubApiRequest<{ object?: { sha?: string } }>(
    `/repos/${PUBLIC_REPOSITORY_SLUG}/git/tags/${object.sha}`,
    { token, expectedStatuses: [200] },
  )
  if (annotated.body?.object?.sha !== expectedHead) {
    fail(`GitHub annotated tag v${version} is not bound to release HEAD.`)
  }
}

async function assertNoExistingReleaseApi(
  version: string,
  token: string,
): Promise<void> {
  const result = await githubApiRequest(
    `/repos/${PUBLIC_REPOSITORY_SLUG}/releases/tags/v${version}`,
    {
      token,
      expectedStatuses: [200, 404],
    },
  )
  if (result.status !== 404) {
    fail(`GitHub release v${version} already exists; use --resume.`)
  }
}

async function createGitHubReleaseApi(
  version: string,
  notes: string,
  token: string,
): Promise<void> {
  await githubApiRequest(`/repos/${PUBLIC_REPOSITORY_SLUG}/releases`, {
    token,
    method: 'POST',
    expectedStatuses: [201],
    body: {
      tag_name: `v${version}`,
      target_commitish: 'main',
      name: `v${version}`,
      body: notes,
      draft: false,
      prerelease: false,
    },
  })
}

export function recoverAutomationCommit(
  root: string,
  previousHead: string,
  version: string,
): { headSha: string; files: string[] } | undefined {
  const status = run(
    'git',
    ['status', '--porcelain', '--untracked-files=all'],
    root,
    true,
  )
  if (status.status !== 0 || status.stdout.trim()) return undefined

  const head = run('git', ['rev-parse', 'HEAD'], root, true)
  const parent = run('git', ['rev-parse', 'HEAD^'], root, true)
  const subject = run('git', ['log', '-1', '--format=%s'], root, true)
  if (
    head.status !== 0 ||
    parent.status !== 0 ||
    subject.status !== 0 ||
    parent.stdout.trim() !== previousHead ||
    subject.stdout.trim() !== `chore(release): prepare v${version}`
  ) {
    return undefined
  }

  const changed = run(
    'git',
    ['diff-tree', '--no-commit-id', '--name-only', '-r', '-z', 'HEAD'],
    root,
    true,
  )
  if (changed.status !== 0) return undefined
  return {
    headSha: head.stdout.trim(),
    files: changed.stdout.split('\0').filter(Boolean),
  }
}

export function commitAllAutomationChanges(
  root: string,
  version: string,
): { headSha: string; files: string[] } {
  const status = run(
    'git',
    ['status', '--porcelain', '--untracked-files=all'],
    root,
    true,
  )
  if (status.status !== 0)
    fail('Unable to inspect files for automated release commit.')
  if (!status.stdout.trim()) fail('Automation mode found no changes to commit.')
  runRequired('git', ['add', '--all'], root)
  const staged = run(
    'git',
    ['diff', '--cached', '--name-only', '-z'],
    root,
    true,
  )
  if (staged.status !== 0)
    fail('Unable to list files for automated release commit.')
  const files = staged.stdout.split('\0').filter(Boolean)
  if (files.length === 0) fail('Automation mode found no changes to commit.')
  runRequired(
    'git',
    ['commit', '-m', `chore(release): prepare v${version}`],
    root,
  )
  const head = run('git', ['rev-parse', 'HEAD'], root, true)
  if (head.status !== 0) fail('Unable to resolve automated release commit.')
  return { headSha: head.stdout.trim(), files }
}

function verifyGitHubTagHead(
  root: string,
  version: string,
  expectedHead: string,
): void {
  const reference = run(
    'gh',
    [
      'api',
      `repos/${PUBLIC_REPOSITORY_SLUG}/git/ref/tags/v${version}`,
      '--jq',
      '.object.type + " " + .object.sha',
    ],
    root,
    true,
  )
  if (reference.status !== 0) {
    fail(`Unable to resolve GitHub tag v${version}.`)
  }
  const [objectType, objectSha] = reference.stdout.trim().split(/\s+/)
  if (objectType === 'commit' && objectSha === expectedHead) return
  if (objectType !== 'tag' || !objectSha) {
    fail(`GitHub tag v${version} is not bound to release HEAD.`)
  }
  const annotated = run(
    'gh',
    [
      'api',
      `repos/${PUBLIC_REPOSITORY_SLUG}/git/tags/${objectSha}`,
      '--jq',
      '.object.sha',
    ],
    root,
    true,
  )
  if (annotated.status !== 0 || annotated.stdout.trim() !== expectedHead) {
    fail(`GitHub annotated tag v${version} is not bound to release HEAD.`)
  }
}

function assertNoExistingRelease(root: string, version: string): void {
  const result = run(
    'gh',
    ['release', 'view', `v${version}`, '--repo', PUBLIC_REPOSITORY_SLUG],
    root,
    true,
  )
  if (result.status === 0) {
    fail(`GitHub release v${version} already exists; use --resume.`)
  }
  if (!isNotFoundResult(result)) {
    fail(`Unable to verify that GitHub release v${version} is absent.`)
  }
}

function assertNpmAccess(root: string, identity: string): void {
  if (!identity) fail('npm whoami returned no authenticated identity.')
  for (const target of PUBLIC_PACKAGES) {
    const cwd = path.join(root, target.directory)
    const packageInfo = run('npm', ['view', target.name, 'name'], cwd, true)
    if (packageInfo.status !== 0 && isNotFoundResult(packageInfo)) {
      continue
    }
    if (packageInfo.status !== 0) {
      fail(`Unable to verify npm package access for ${target.name}.`)
    }

    const access = run(
      'npm',
      ['access', 'get', 'status', target.name],
      cwd,
      true,
    )
    const owners = run('npm', ['owner', 'ls', target.name], cwd, true)
    if (
      access.status !== 0 ||
      owners.status !== 0 ||
      !owners.stdout.trim() ||
      !owners.stdout.includes(identity)
    ) {
      fail(`npm publish access verification failed for ${target.name}.`)
    }
  }
}

function assertPackagesNotPublished(root: string, version: string): void {
  for (const target of PUBLIC_PACKAGES) {
    const result = run(
      'npm',
      ['view', `${target.name}@${version}`, 'version'],
      path.join(root, target.directory),
      true,
    )
    if (result.status === 0 && result.stdout.trim() === version) {
      fail(`${target.name}@${version} already exists on npm; use --resume.`)
    }
    if (result.status !== 0 && !isNotFoundResult(result)) {
      fail(
        `Unable to verify that ${target.name}@${version} is absent from npm.`,
      )
    }
  }
}

function packageIsPublished(
  root: string,
  target: PackageTarget,
  version: string,
): boolean {
  const result = run(
    'npm',
    ['view', `${target.name}@${version}`, 'version'],
    path.join(root, target.directory),
    true,
  )
  if (result.status === 0) return result.stdout.trim() === version
  if (isNotFoundResult(result)) return false
  fail(`Unable to query npm for ${target.name}@${version}.`)
}

async function confirm(
  plan: readonly string[],
  version: string,
  resume: boolean,
): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    fail(
      'Public release requires interactive confirmation; use --preview in CI.',
    )
  }
  console.log('\nExact public mutation targets:')
  console.log(`  repository: ${PUBLIC_REPOSITORY}`)
  console.log(`  branch: origin/main`)
  console.log(`  tag: v${version} (annotated)`)
  console.log(
    `  GitHub release: ${PUBLIC_REPOSITORY_SLUG}/releases/tag/v${version}`,
  )
  console.log('  npm packages: @savant-code/sdk, savant-code')
  console.log(
    `  mode: ${resume ? 'resume completed stages where safe' : 'new release'}`,
  )
  console.log('\nRelease plan:')
  for (const step of plan) console.log(`  - ${step}`)

  const prompt = createInterface({
    input: process.stdin,
    output: process.stdout,
  })
  try {
    const answer = await prompt.question(
      `\nPublish exactly these targets for v${version}? Type RELEASE to continue: `,
    )
    if (answer.trim() !== 'RELEASE') fail('Release cancelled.')
  } finally {
    prompt.close()
  }
}

function writeReceipt(receipt: ReleaseReceipt): void {
  writeFileSync(receipt.receiptPath, redactReceipt(receipt))
}

function verifyPublishedPackage(
  root: string,
  target: PackageTarget,
  version: string,
): void {
  if (!packageIsPublished(root, target, version)) {
    fail(`Post-release verification failed for ${target.name}@${version}.`)
  }
  const inspectionDir = path.join(
    os.tmpdir(),
    `savant-public-release-inspect-${target.name.replaceAll('/', '-')}-${version}`,
  )
  mkdirSync(inspectionDir, { recursive: true })
  try {
    const packed = run(
      'npm',
      ['pack', `${target.name}@${version}`, '--json'],
      inspectionDir,
      true,
    )
    if (packed.status !== 0) {
      fail(`Post-release package inspection failed for ${target.name}.`)
    }
    let entries: unknown
    try {
      entries = JSON.parse(packed.stdout)
    } catch {
      fail(
        `Post-release package inspection returned invalid JSON for ${target.name}.`,
      )
    }
    const artifact = Array.isArray(entries) ? entries[0] : undefined
    const files =
      artifact && typeof artifact === 'object' && 'files' in artifact
        ? artifact.files
        : undefined
    const packageVersion =
      artifact && typeof artifact === 'object' && 'version' in artifact
        ? artifact.version
        : undefined
    if (
      packageVersion !== version ||
      !Array.isArray(files) ||
      files.length === 0
    ) {
      fail(
        `Published artifact metadata/content is invalid for ${target.name}@${version}.`,
      )
    }
    const fileNames = files
      .map((file) =>
        file && typeof file === 'object' && 'path' in file ? file.path : '',
      )
      .filter((file): file is string => typeof file === 'string')
    const requiredFiles =
      target.name === '@savant-code/sdk'
        ? ['README.md', 'dist/']
        : ['README.md', 'index.js']
    for (const requiredFile of requiredFiles) {
      if (
        !fileNames.some(
          (file) => file === requiredFile || file.startsWith(requiredFile),
        )
      ) {
        fail(
          `Published artifact is missing ${requiredFile} for ${target.name}.`,
        )
      }
    }
  } finally {
    rmSync(inspectionDir, { recursive: true, force: true })
  }
}

function markStage(receipt: ReleaseReceipt, stage: string): void {
  if (!receipt.completedStages.includes(stage))
    receipt.completedStages.push(stage)
  writeReceipt(receipt)
}

export async function withLocalStateRestoration<T>(
  snapshot: LocalSnapshot,
  operation: () => T | Promise<T>,
  onRestored?: () => void,
): Promise<T> {
  try {
    return await operation()
  } finally {
    restoreLocalState(snapshot)
    onRestored?.()
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const options: ReleaseOptions = {
    preview: args.includes('--preview'),
    resume: args.includes('--resume'),
    automation: isReleaseAutomationEnabled(),
  }
  const root = repositoryRoot()
  const version = currentVersion(root)
  const plan = buildPublicReleasePlan(version)
  const receiptMode: ReleaseReceipt['mode'] = options.automation
    ? 'automation'
    : 'publish'
  const priorReceipt = options.resume
    ? loadResumeReceipt(version, receiptMode)
    : undefined
  if (options.resume && !priorReceipt) {
    fail(`No resumable release receipt found for v${version}.`)
  }

  const receipt: ReleaseReceipt = priorReceipt ?? {
    version,
    mode: options.preview
      ? 'preview'
      : options.automation
        ? 'automation'
        : 'publish',
    completedStages: [],
    restored: false,
    receiptPath: receiptPath(version),
  }
  receipt.restored = false

  console.log(`Savant public release v${version}`)
  console.log(
    options.preview
      ? 'Preview mode: no mutation will occur.'
      : options.automation
        ? 'Automation mode: token-native, noninteractive release.'
        : options.resume
          ? 'Resume mode: only incomplete stages may run.'
          : 'Preflight mode.',
  )

  const commandWarnings = [
    options.automation || options.preview
      ? undefined
      : requireCommand('gh', true),
    requireCommand('npm', !options.preview),
  ].filter((warning): warning is string => Boolean(warning))
  const githubToken =
    options.automation && !options.preview ? getGitHubToken() : ''
  if (options.automation && !options.preview) {
    await assertGitHubToken(githubToken)
  }
  let preflight = verifyPreflight(
    root,
    version,
    !options.preview,
    options.resume ||
      isStageComplete(receipt, 'TAG') ||
      isStageComplete(receipt, 'GIT_PUSH'),
    options.automation,
  )
  if (receipt.headSha && receipt.headSha !== preflight.headSha) {
    if (
      options.automation &&
      !isStageComplete(receipt, 'AUTOMATION_COMMIT_ALL')
    ) {
      const recovered = recoverAutomationCommit(root, receipt.headSha, version)
      if (recovered) {
        receipt.committedHead = recovered.headSha
        receipt.committedFiles = recovered.files
        preflight = verifyPreflight(root, version, true, true, true)
        receipt.headSha = preflight.headSha
        markStage(receipt, 'AUTOMATION_COMMIT_ALL')
      } else {
        fail(
          `Release HEAD changed from ${receipt.headSha} to ${preflight.headSha}; refusing to resume.`,
        )
      }
    } else {
      fail(
        `Release HEAD changed from ${receipt.headSha} to ${preflight.headSha}; refusing to resume.`,
      )
    }
  }
  receipt.headSha = preflight.headSha
  const warnings = [...commandWarnings, ...preflight.warnings]

  if (options.preview) {
    if (warnings.length) {
      console.log('\nPreview warnings:')
      for (const warning of warnings) console.log(`  - ${warning}`)
    }
    console.log('\nPreview plan:')
    for (const step of plan) console.log(`  - ${step}`)
    console.log(`\nChangelog section ready: ${preflight.notes.split('\n')[0]}`)
    return
  }

  const ghAuth = options.automation
    ? undefined
    : run('gh', ['auth', 'status'], root, true)
  if (!options.automation && ghAuth?.status !== 0) {
    fail('gh auth status failed.')
  }
  const npmAuth = run('npm', ['whoami'], root, true)
  if (npmAuth.status !== 0) fail('npm whoami failed.')
  markStage(receipt, 'AUTHENTICATION')

  const snapshot = snapshotLocalState()

  if (!options.resume) {
    if (options.automation)
      await assertNoExistingReleaseApi(version, githubToken)
    else assertNoExistingRelease(root, version)
    assertPackagesNotPublished(root, version)
  }
  assertNpmAccess(root, npmAuth.stdout.trim())

  try {
    await withLocalStateRestoration(
      snapshot,
      async () => {
        if (
          options.automation &&
          !isStageComplete(receipt, 'AUTOMATION_COMMIT_ALL')
        ) {
          const committed = commitAllAutomationChanges(root, version)
          receipt.committedHead = committed.headSha
          receipt.committedFiles = committed.files
          preflight = verifyPreflight(root, version, true, true, true)
          receipt.headSha = preflight.headSha
          markStage(receipt, 'AUTOMATION_COMMIT_ALL')
        }
        markStage(receipt, 'PREFLIGHT')

        if (options.automation) {
          markStage(receipt, 'AUTOMATION_APPROVAL')
        } else if (!isStageComplete(receipt, 'CONFIRMATION')) {
          await confirm(plan, version, options.resume)
          markStage(receipt, 'CONFIRMATION')
        }

        applyPublicProfile(snapshot)
        markStage(receipt, 'PUBLIC_PROFILE')

        if (!isStageComplete(receipt, 'GATES_AND_PACKAGE_DRY_RUNS')) {
          runRequired('bun', ['run', 'build:sdk'], root)
          runRequired('bun', ['run', 'typecheck'], root)
          runRequired('bun', ['run', 'test'], root)
          runRequired('bun', ['x', 'eslint', '.', '--max-warnings', '0'], root)
          runRequired('bun', ['run', 'lint:md'], root)
          runRequired('bunx', ['prettier', '--check', '.'], root)
          for (const target of PUBLIC_PACKAGES) {
            runRequired(
              'npm',
              ['pack', '--dry-run'],
              path.join(root, target.directory),
            )
          }
          markStage(receipt, 'GATES_AND_PACKAGE_DRY_RUNS')
        }

        if (!isStageComplete(receipt, 'GIT_PUSH')) {
          if (!isStageComplete(receipt, 'TAG')) {
            runRequired(
              'git',
              ['tag', '-a', `v${version}`, '-m', `Release v${version}`],
              root,
            )
            markStage(receipt, 'TAG')
          }
          runRequired(
            'git',
            ['push', 'origin', 'main', `v${version}`],
            root,
            options.automation
              ? buildTokenSafeGitPushEnv(githubToken)
              : undefined,
          )
          markStage(receipt, 'GIT_PUSH')
        }

        if (!isStageComplete(receipt, 'GITHUB_RELEASE')) {
          if (options.automation) {
            const existingRelease = await githubApiRequest(
              `/repos/${PUBLIC_REPOSITORY_SLUG}/releases/tags/v${version}`,
              { token: githubToken, expectedStatuses: [200, 404] },
            )
            if (existingRelease.status === 200) {
              await verifyGitHubTagHeadApi(
                version,
                preflight.headSha,
                githubToken,
              )
            } else {
              await createGitHubReleaseApi(
                version,
                preflight.notes,
                githubToken,
              )
            }
            markStage(receipt, 'GITHUB_RELEASE')
          } else {
            const existingRelease = run(
              'gh',
              [
                'release',
                'view',
                `v${version}`,
                '--repo',
                PUBLIC_REPOSITORY_SLUG,
              ],
              root,
              true,
            )
            if (existingRelease.status === 0) {
              verifyGitHubTagHead(root, version, preflight.headSha)
              markStage(receipt, 'GITHUB_RELEASE')
            } else {
              if (!isNotFoundResult(existingRelease)) {
                fail(
                  `Unable to verify that GitHub release v${version} is absent.`,
                )
              }
              const notesPath = path.join(
                os.tmpdir(),
                `savant-release-notes-${version}.md`,
              )
              writeFileSync(notesPath, preflight.notes)
              try {
                runRequired(
                  'gh',
                  [
                    'release',
                    'create',
                    `v${version}`,
                    '--repo',
                    PUBLIC_REPOSITORY_SLUG,
                    '--title',
                    `v${version}`,
                    '--notes-file',
                    notesPath,
                  ],
                  root,
                )
              } finally {
                rmSync(notesPath, { force: true })
              }
              markStage(receipt, 'GITHUB_RELEASE')
            }
          }
        }

        for (const target of PUBLIC_PACKAGES) {
          if (isStageComplete(receipt, target.stage)) continue
          if (options.resume && packageIsPublished(root, target, version)) {
            markStage(receipt, target.stage)
            continue
          }
          runRequired(
            'npm',
            ['publish', '--access', 'public'],
            path.join(root, target.directory),
          )
          markStage(receipt, target.stage)
        }

        if (options.automation) {
          const verifiedRelease = await githubApiRequest(
            `/repos/${PUBLIC_REPOSITORY_SLUG}/releases/tags/v${version}`,
            { token: githubToken, expectedStatuses: [200] },
          )
          if (verifiedRelease.status !== 200) {
            fail(
              `Post-release verification failed for GitHub release v${version}.`,
            )
          }
          await verifyGitHubTagHeadApi(version, preflight.headSha, githubToken)
        } else {
          const verifiedRelease = run(
            'gh',
            [
              'release',
              'view',
              `v${version}`,
              '--repo',
              PUBLIC_REPOSITORY_SLUG,
            ],
            root,
            true,
          )
          if (verifiedRelease.status !== 0) {
            fail(
              `Post-release verification failed for GitHub release v${version}.`,
            )
          }
          verifyGitHubTagHead(root, version, preflight.headSha)
        }
        const taggedHead = run(
          'git',
          ['rev-list', '-1', `v${version}`],
          root,
          true,
        )
        if (
          taggedHead.status !== 0 ||
          taggedHead.stdout.trim() !== preflight.headSha
        ) {
          fail(`Post-release tag v${version} does not point at release HEAD.`)
        }
        for (const target of PUBLIC_PACKAGES) {
          verifyPublishedPackage(root, target, version)
        }
        markStage(receipt, 'POST_RELEASE_VERIFY')
      },
      () => {
        receipt.restored = true
      },
    )
  } catch (error) {
    receipt.failedStage = error instanceof Error ? error.message : String(error)
    throw error
  } finally {
    writeReceipt(receipt)
  }
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}
