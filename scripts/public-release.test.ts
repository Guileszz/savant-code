import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import os from 'os'
import path from 'path'

import { describe, expect, test } from 'bun:test'

import {
  PUBLIC_PACKAGES,
  PUBLIC_REPOSITORY,
  applyPublicProfile,
  buildPublicReleasePlan,
  buildTokenSafeGitPushEnv,
  commitAllAutomationChanges,
  recoverAutomationCommit,
  extractChangelogSection,
  getGitHubToken,
  githubApiRequest,
  isReleaseAutomationEnabled,
  isNotFoundResult,
  isStageComplete,
  redactReceipt,
  snapshotLocalState,
  validateReleaseVersions,
  validateResumeReceipt,
  withLocalStateRestoration,
} from './public-release'

describe('public release contract', () => {
  test('extracts exactly the requested changelog section', () => {
    const changelog = [
      '# Changelog',
      '',
      '## v0.0.21 — 2026-08-08',
      '',
      '### Added',
      '- Release workflow',
      '',
      '## v0.0.20 — 2026-08-06',
      '',
      '- Older release',
    ].join('\n')

    expect(extractChangelogSection(changelog, '0.0.21')).toBe(
      '## v0.0.21 — 2026-08-08\n\n### Added\n- Release workflow',
    )
  })

  test('rejects missing or duplicate changelog versions', () => {
    expect(() =>
      extractChangelogSection('## v0.0.20 — old\n- old', '0.0.21'),
    ).toThrow('found 0')
    expect(() =>
      extractChangelogSection(
        '## v0.0.21 — first\n- one\n## v0.0.21 — duplicate\n- two',
        '0.0.21',
      ),
    ).toThrow('found 2')
    expect(() =>
      extractChangelogSection(
        '## v0.0.20 — older\n- older\n## v0.0.21 — newer\n- newer',
        '0.0.21',
      ),
    ).toThrow('reverse-chronological')
  })

  test('validates package versions', () => {
    expect(() =>
      validateReleaseVersions('0.0.21', {
        'package.json': '{"version":"0.0.21"}',
        'sdk/package.json': '{"version":"0.0.21"}',
      }),
    ).not.toThrow()
    expect(() =>
      validateReleaseVersions('0.0.21', {
        'cli/release/package.json': '{"version":"0.0.20"}',
      }),
    ).toThrow('expected 0.0.21')
  })

  test('targets only public packages in SDK-first order', () => {
    expect(PUBLIC_PACKAGES.map(({ name }) => name)).toEqual([
      '@savant-code/sdk',
      'savant-code',
    ])
    expect(PUBLIC_PACKAGES.some(({ name }) => name === 'savant-free')).toBe(
      false,
    )
  })

  test('plans the canonical public mutation sequence', () => {
    const plan = buildPublicReleasePlan('0.0.21')
    expect(plan.join('\n')).toContain(PUBLIC_REPOSITORY)
    expect(plan.indexOf('npm publish @savant-code/sdk')).toBeLessThan(
      plan.indexOf('npm publish savant-code'),
    )
    expect(plan.join('\n')).toContain('GitHub REST release for v0.0.21')
  })

  test('uses explicit automation mode and token fallback without exposing it', () => {
    expect(
      isReleaseAutomationEnabled({ SAVANT_CODE_RELEASE_AUTOMATION: '1' }),
    ).toBe(true)
    expect(
      isReleaseAutomationEnabled({ SAVANT_CODE_RELEASE_AUTOMATION: '0' }),
    ).toBe(false)
    expect(getGitHubToken({ GITHUB_TOKEN: 'primary' })).toBe('primary')
    expect(getGitHubToken({ GH_TOKEN: 'fallback' })).toBe('fallback')
    expect(() => getGitHubToken({})).toThrow('GITHUB_TOKEN or GH_TOKEN')
  })

  test('supports idempotent stage checks', () => {
    expect(
      isStageComplete({ completedStages: ['PREFLIGHT'] }, 'PREFLIGHT'),
    ).toBe(true)
    expect(
      isStageComplete({ completedStages: ['PREFLIGHT'] }, 'GIT_PUSH'),
    ).toBe(false)
  })

  test('does not expose tokens in token-safe Git environment values', () => {
    const env = buildTokenSafeGitPushEnv('github-secret')
    expect(env.GIT_CONFIG_VALUE_0).not.toContain('github-secret')
    expect(env.GIT_CONFIG_VALUE_0).toContain('AUTHORIZATION: basic')
    expect(env.GIT_TERMINAL_PROMPT).toBe('0')
  })

  test('uses GitHub REST headers and fails closed on unexpected statuses', async () => {
    const requests: RequestInit[] = []
    const fetchImpl = async (_input: RequestInfo | URL, init?: RequestInit) => {
      requests.push(init ?? {})
      return new Response(JSON.stringify({ login: 'release-bot' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }

    const result = await githubApiRequest<{ login: string }>('/user', {
      token: 'github-secret',
      fetchImpl,
    })

    expect(result.body?.login).toBe('release-bot')
    expect(requests[0]?.headers).toMatchObject({
      Accept: 'application/vnd.github+json',
      Authorization: 'Bearer github-secret',
      'X-GitHub-Api-Version': '2022-11-28',
    })

    await expect(
      githubApiRequest('/user', {
        token: 'github-secret',
        fetchImpl: async () =>
          new Response(JSON.stringify({ message: 'forbidden' }), {
            status: 403,
          }),
      }),
    ).rejects.toThrow('HTTP 403')
  })

  test('recognizes npm not-found responses across npm output formats', () => {
    expect(
      isNotFoundResult({
        stdout: '',
        stderr: "npm error 404 No match found for version '0.0.21'",
      }),
    ).toBe(true)
    expect(
      isNotFoundResult({
        stdout: '',
        stderr: 'npm ERR! code E404 Not Found',
      }),
    ).toBe(true)
    expect(
      isNotFoundResult({ stdout: '', stderr: 'npm error E401 Unauthorized' }),
    ).toBe(false)
  })

  test('accepts only explicit API absence and sanitizes failures', async () => {
    const absent = await githubApiRequest('/release', {
      token: 'github-secret',
      expectedStatuses: [200, 404],
      fetchImpl: async () => new Response('', { status: 404 }),
    })
    expect(absent.status).toBe(404)

    await expect(
      githubApiRequest('/release', {
        token: 'github-secret',
        expectedStatuses: [200, 404],
        fetchImpl: async () =>
          new Response(JSON.stringify({ message: 'rate limited' }), {
            status: 429,
          }),
      }),
    ).rejects.toThrow('HTTP 429')
  })

  test('redacts credentials from receipt failure details', () => {
    const receipt = redactReceipt({
      version: '0.0.21',
      mode: 'publish',
      completedStages: ['PREFLIGHT'],
      failedStage:
        'OPENROUTER_API_KEY=secret-or-key GITHUB_TOKEN:ghs_secret NPM_TOKEN=npm_secret Authorization: Bearer bearer-secret AUTHORIZATION: basic Z2l0LXNlY3JldA==',
      restored: true,
      receiptPath: '/tmp/receipt.json',
    })

    expect(receipt).toContain('PREFLIGHT')
    expect(receipt).toContain('[REDACTED]')
    expect(receipt).not.toContain('secret-or-key')
    expect(receipt).not.toContain('ghs_secret')
    expect(receipt).not.toContain('npm_secret')
    expect(receipt).not.toContain('bearer-secret')
    expect(receipt).not.toContain('Z2l0LXNlY3JldA==')
  })

  test('rejects unsafe resume receipts and accepts a restored, HEAD-bound receipt', () => {
    const validReceipt = {
      version: '0.0.21' as const,
      mode: 'publish' as const,
      headSha: 'a'.repeat(40),
      completedStages: ['GIT_PUSH'],
      restored: true,
      receiptPath: '/tmp/receipt.json',
    }

    expect(() =>
      validateResumeReceipt(
        '0.0.21',
        { ...validReceipt, restored: false },
        validReceipt.receiptPath,
      ),
    ).toThrow('did not confirm local-state restoration')
    expect(() =>
      validateResumeReceipt(
        '0.0.21',
        { ...validReceipt, headSha: undefined },
        validReceipt.receiptPath,
      ),
    ).toThrow('no commit binding')
    expect(() =>
      validateResumeReceipt(
        '0.0.21',
        { ...validReceipt, headSha: 'not-a-sha' },
        validReceipt.receiptPath,
      ),
    ).toThrow('invalid commit binding')
    expect(() =>
      validateResumeReceipt(
        '0.0.21',
        { ...validReceipt, completedStages: ['GIT_PUSH', 'GIT_PUSH'] },
        validReceipt.receiptPath,
      ),
    ).toThrow('invalid or duplicate stages')
    expect(() =>
      validateResumeReceipt(
        '0.0.21',
        validReceipt,
        validReceipt.receiptPath,
        'automation',
      ),
    ).toThrow('incompatible')
    expect(
      validateResumeReceipt('0.0.21', validReceipt, validReceipt.receiptPath)
        .headSha,
    ).toBe('a'.repeat(40))
  })

  test('recovers a release commit created before receipt persistence', () => {
    const repo = mkdtempSync(path.join(os.tmpdir(), 'savant-release-recover-'))
    try {
      const runGit = (args: string[]) => {
        const result = Bun.spawnSync({
          cmd: ['git', ...args],
          cwd: repo,
          stdout: 'pipe',
          stderr: 'pipe',
        })
        if (result.exitCode !== 0) {
          throw new Error(new TextDecoder().decode(result.stderr))
        }
      }
      runGit(['init'])
      runGit(['config', 'user.email', 'release-test@example.invalid'])
      runGit(['config', 'user.name', 'Release Test'])
      writeFileSync(path.join(repo, 'base.txt'), 'base')
      runGit(['add', '--all'])
      runGit(['commit', '-m', 'base'])
      const previousHead = new TextDecoder()
        .decode(
          Bun.spawnSync({
            cmd: ['git', 'rev-parse', 'HEAD'],
            cwd: repo,
            stdout: 'pipe',
            stderr: 'pipe',
          }).stdout,
        )
        .trim()
      writeFileSync(path.join(repo, 'release.txt'), 'release')
      const committed = commitAllAutomationChanges(repo, '0.0.21')

      expect(recoverAutomationCommit(repo, previousHead, '0.0.21')).toEqual(
        committed,
      )
      expect(
        recoverAutomationCommit(repo, 'b'.repeat(40), '0.0.21'),
      ).toBeUndefined()
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

  test('creates one automation commit containing tracked and untracked changes', () => {
    const repo = mkdtempSync(path.join(os.tmpdir(), 'savant-release-git-'))
    try {
      const runGit = (args: string[]) => {
        const result = Bun.spawnSync({
          cmd: ['git', ...args],
          cwd: repo,
          stdout: 'pipe',
          stderr: 'pipe',
        })
        if (result.exitCode !== 0) {
          throw new Error(new TextDecoder().decode(result.stderr))
        }
      }
      runGit(['init'])
      runGit(['config', 'user.email', 'release-test@example.invalid'])
      runGit(['config', 'user.name', 'Release Test'])
      writeFileSync(path.join(repo, 'tracked.txt'), 'tracked')
      writeFileSync(path.join(repo, 'untracked.txt'), 'untracked')

      const committed = commitAllAutomationChanges(repo, '0.0.21')

      expect(committed.files).toEqual(['tracked.txt', 'untracked.txt'])
      expect(committed.headSha).toMatch(/^[0-9a-f]{40}$/)
      const log = Bun.spawnSync({
        cmd: ['git', 'log', '-1', '--format=%s'],
        cwd: repo,
        stdout: 'pipe',
        stderr: 'pipe',
      })
      expect(new TextDecoder().decode(log.stdout).trim()).toBe(
        'chore(release): prepare v0.0.21',
      )
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

  test('restores local settings after a simulated failed release stage', async () => {
    const configDir = mkdtempSync(
      path.join(os.tmpdir(), 'savant-release-test-'),
    )
    const settingsPath = path.join(configDir, 'settings.json')
    const originalSettings = JSON.stringify(
      {
        savantCodeModelPreference: 'personal/model',
        savantCodeModelProviderPreference: 'personal',
      },
      null,
      2,
    )
    writeFileSync(settingsPath, originalSettings)
    const previousConfigDir = process.env.SAVANT_CODE_CONFIG_DIR
    const previousModel = process.env.SAVANT_CODE_DEFAULT_MODEL_ID
    process.env.SAVANT_CODE_CONFIG_DIR = configDir
    process.env.SAVANT_CODE_DEFAULT_MODEL_ID = 'personal/model'

    try {
      const snapshot = snapshotLocalState()
      let restored = false
      expect(
        withLocalStateRestoration(
          snapshot,
          () => {
            applyPublicProfile(snapshot)
            expect(readFileSync(settingsPath, 'utf8')).toContain(
              'openrouter/free',
            )
            throw new Error('simulated gate failure')
          },
          () => {
            restored = true
          },
        ),
      ).rejects.toThrow('simulated gate failure')
      expect(restored).toBe(true)

      expect(readFileSync(settingsPath, 'utf8')).toBe(originalSettings)
      expect(process.env.SAVANT_CODE_DEFAULT_MODEL_ID).toBe('personal/model')
    } finally {
      if (previousConfigDir === undefined)
        delete process.env.SAVANT_CODE_CONFIG_DIR
      else process.env.SAVANT_CODE_CONFIG_DIR = previousConfigDir
      if (previousModel === undefined)
        delete process.env.SAVANT_CODE_DEFAULT_MODEL_ID
      else process.env.SAVANT_CODE_DEFAULT_MODEL_ID = previousModel
      rmSync(configDir, { recursive: true, force: true })
    }
  })

  test('extracts only the real current release section', () => {
    const changelog = readFileSync(
      path.resolve(import.meta.dir, '../CHANGELOG.md'),
      'utf8',
    )
    const section = extractChangelogSection(changelog, '0.0.21')

    expect(section.startsWith('## v0.0.21 — 2026-08-06')).toBe(true)
    expect(section).toContain('### Reversible public release pipeline')
    expect(section).not.toContain('## v0.0.20 —')
  })
})
