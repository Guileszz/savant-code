import fs from 'fs'
import os from 'os'
import path from 'path'

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'

import { setProjectRoot } from '../../project-files'
import {
  buildContributorsContent,
  checkContributorExists,
  CONTRIBUTORS_HEADER,
  formatContributorRow,
  handleContributeCommand,
  runContributeGitFlow,
  sanitizeUsername,
} from '../contribute'

import type { ChatMessage } from '../../types/chat'
import type { RouterParams } from '../command-registry'
import type { ExecFn } from '../contribute'

describe('sanitizeUsername', () => {
  test('strips a leading @ and trims whitespace', () => {
    expect(sanitizeUsername('  @spencer  ')).toBe('spencer')
    expect(sanitizeUsername('savant0x')).toBe('savant0x')
  })

  test('rejects invalid characters (the injection boundary)', () => {
    expect(sanitizeUsername('foo bar')).toBe('')
    expect(sanitizeUsername('a/b')).toBe('')
    expect(sanitizeUsername('x;rm -rf /')).toBe('')
    expect(sanitizeUsername('$(whoami)')).toBe('')
    expect(sanitizeUsername('-leading-hyphen')).toBe('')
    expect(sanitizeUsername('')).toBe('')
  })

  test('allows hyphens and digits in the body', () => {
    expect(sanitizeUsername('octocat-99')).toBe('octocat-99')
  })
})

describe('checkContributorExists', () => {
  test('finds an @user cell case-insensitively', () => {
    const content = '| @savant0x | 2026-08-06 |'
    expect(checkContributorExists(content, 'savant0x')).toBe(true)
    expect(checkContributorExists(content, 'SAVANT0X')).toBe(true)
  })

  test('does not match a prefix of a longer username', () => {
    const content = '| @savant0x | 2026-08-06 |'
    expect(checkContributorExists(content, 'savant')).toBe(false)
  })

  test('does not match inside another word', () => {
    const content = '# @savant0x is the founder'
    expect(checkContributorExists(content, 'savant0x')).toBe(true)
    expect(checkContributorExists(content, 'avant0x')).toBe(false)
  })
})

describe('buildContributorsContent', () => {
  test('creates the header when the file is missing', () => {
    const content = buildContributorsContent(null, 'spencer', '2026-08-06')
    expect(content).toContain(CONTRIBUTORS_HEADER)
    expect(content).toContain('| @spencer | 2026-08-06 |')
  })

  test('appends a row to existing content without a trailing newline', () => {
    const existing = '| @savant0x | 2026-08-06 |'
    const content = buildContributorsContent(existing, 'spencer', '2026-08-07')
    expect(content).toBe(
      '| @savant0x | 2026-08-06 |\n| @spencer | 2026-08-07 |\n',
    )
  })

  test('appends a row to existing content with a trailing newline', () => {
    const existing = '| @savant0x | 2026-08-06 |\n'
    const content = buildContributorsContent(existing, 'spencer', '2026-08-07')
    expect(content).toBe(
      '| @savant0x | 2026-08-06 |\n| @spencer | 2026-08-07 |\n',
    )
  })

  test('formatContributorRow renders the table row', () => {
    expect(formatContributorRow('savant0x', '2026-08-06')).toBe(
      '| @savant0x | 2026-08-06 |',
    )
  })
})

describe('runContributeGitFlow', () => {
  function makeFakeExec(
    calls: { cmd: string; args: string[] }[],
    overrides: { prUrl?: string; branchExists?: boolean } = {},
  ): ExecFn {
    const {
      prUrl = 'https://github.com/savant0x/savant-code/pull/1',
      branchExists = false,
    } = overrides
    return (cmd, args) => {
      calls.push({ cmd, args })
      if (
        cmd === 'git' &&
        args[0] === 'rev-parse' &&
        args[1] === '--abbrev-ref'
      ) {
        return 'main'
      }
      if (cmd === 'git' && args[0] === 'rev-parse' && args[1] === '--verify') {
        if (branchExists) return 'contribute/add-spencer'
        throw new Error('unknown revision')
      }
      if (cmd === 'git' && args[0] === 'status') return ' M CONTRIBUTORS.md'
      if (cmd === 'gh') return prUrl
      return ''
    }
  }

  test('runs checkout -b → commit → push → gh pr create and returns the URL', () => {
    const calls: { cmd: string; args: string[] }[] = []
    const prUrl = runContributeGitFlow('/repo', 'spencer', makeFakeExec(calls))

    expect(prUrl).toBe('https://github.com/savant0x/savant-code/pull/1')

    const commands = calls.map((c) => `${c.cmd} ${c.args.join(' ')}`)
    expect(commands).toContain('git rev-parse --is-inside-work-tree')
    expect(commands).toContain('git checkout -b contribute/add-spencer')
    expect(commands).toContain(
      'git commit -m docs: add @spencer as contributor -- CONTRIBUTORS.md',
    )
    expect(commands).toContain('git push -u origin contribute/add-spencer')
    expect(commands.some((c) => c.startsWith('gh pr create'))).toBe(true)
    // Returns the operator to the original branch.
    expect(commands[commands.length - 1]).toBe('git checkout main')
  })

  test('checks out an existing branch instead of creating it', () => {
    const calls: { cmd: string; args: string[] }[] = []
    runContributeGitFlow(
      '/repo',
      'spencer',
      makeFakeExec(calls, { branchExists: true }),
    )
    const commands = calls.map((c) => c.args.join(' '))
    expect(commands).toContain('checkout contribute/add-spencer')
    expect(commands).not.toContain('checkout -b contribute/add-spencer')
  })

  test('skips the commit when CONTRIBUTORS.md is already clean on the branch', () => {
    const calls: { cmd: string; args: string[] }[] = []
    const fake: ExecFn = (cmd, args) => {
      calls.push({ cmd, args })
      if (
        cmd === 'git' &&
        args[0] === 'rev-parse' &&
        args[1] === '--abbrev-ref'
      ) {
        return 'main'
      }
      if (cmd === 'git' && args[0] === 'status') return ''
      if (cmd === 'gh') return 'url'
      return ''
    }
    runContributeGitFlow('/repo', 'spencer', fake)
    const commands = calls.map((c) => c.args.join(' '))
    expect(commands).not.toContain('commit -m')
    expect(commands).toContain('push -u origin contribute/add-spencer')
  })

  test('propagates failures and still attempts to return to the original branch', () => {
    const calls: { cmd: string; args: string[] }[] = []
    const fake: ExecFn = (cmd, args) => {
      calls.push({ cmd, args })
      if (
        cmd === 'git' &&
        args[0] === 'rev-parse' &&
        args[1] === '--abbrev-ref'
      ) {
        return 'main'
      }
      if (cmd === 'git' && args[0] === 'push') {
        throw new Error('Authentication failed')
      }
      return ''
    }
    expect(() => runContributeGitFlow('/repo', 'spencer', fake)).toThrow(
      'Authentication failed',
    )
    const commands = calls.map((c) => c.args.join(' '))
    expect(commands[commands.length - 1]).toBe('checkout main')
  })
})

describe('handleContributeCommand', () => {
  let tempDir: string
  let renderedMessages: ChatMessage[]

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'savant-contribute-'))
    renderedMessages = []
    setProjectRoot(tempDir)
  })

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true })
  })

  function renderedText(): string {
    return renderedMessages.map((m) => m.content ?? '').join('\n')
  }

  function makeParams(): RouterParams {
    return {
      inputRef: { current: null },
      setMessages: mock(
        (update: ChatMessage[] | ((prev: ChatMessage[]) => ChatMessage[])) => {
          renderedMessages =
            typeof update === 'function' ? update(renderedMessages) : update
        },
      ),
      saveToHistory: mock(() => {}),
      setInputValue: mock(() => {}),
      setInputFocused: mock(() => {}),
      setIsAuthenticated: mock(() => {}),
      setUser: mock(() => {}),
      addToQueue: mock(() => {}),
      clearMessages: mock(() => {}),
      scrollToLatest: mock(() => {}),
      sendMessage: mock(async () => {}),
      setCanProcessQueue: mock(() => {}),
      inputValue: '/contribute',
      agentMode: 'HYBRID',
      isChainInProgressRef: { current: false },
      isStreaming: false,
      streamMessageIdRef: { current: null },
      abortControllerRef: { current: null },
      logoutMutation: {} as RouterParams['logoutMutation'],
    } as unknown as RouterParams
  }

  function makeHappyExec(calls: { cmd: string; args: string[] }[]): ExecFn {
    return (cmd, args) => {
      calls.push({ cmd, args })
      if (cmd === 'git' && args[0] === 'config') return 'spencer'
      if (
        cmd === 'git' &&
        args[0] === 'rev-parse' &&
        args[1] === '--abbrev-ref'
      ) {
        return 'main'
      }
      if (cmd === 'git' && args[0] === 'rev-parse' && args[1] === '--verify') {
        throw new Error('unknown revision')
      }
      if (cmd === 'git' && args[0] === 'status') return ' M CONTRIBUTORS.md'
      if (cmd === 'gh') return 'https://github.com/savant0x/savant-code/pull/42'
      return ''
    }
  }

  test('usage message when no username and git config is unset', async () => {
    const exec: ExecFn = () => ''
    await handleContributeCommand(makeParams(), '', exec)
    expect(renderedText()).toContain('Usage: /contribute [github-username]')
  })

  test('usage message when the arg is not a valid GitHub username', async () => {
    const exec: ExecFn = () => ''
    await handleContributeCommand(makeParams(), 'not a username!', exec)
    expect(renderedText()).toContain('Usage: /contribute [github-username]')
  })

  test('creates CONTRIBUTORS.md and opens a PR for an explicit username', async () => {
    const calls: { cmd: string; args: string[] }[] = []
    await handleContributeCommand(makeParams(), 'spencer', makeHappyExec(calls))

    const file = fs.readFileSync(path.join(tempDir, 'CONTRIBUTORS.md'), 'utf8')
    expect(file).toContain('# Contributors')
    expect(file).toContain('| @spencer | ')

    expect(renderedText()).toContain('PR opened')
    expect(renderedText()).toContain(
      'https://github.com/savant0x/savant-code/pull/42',
    )
    expect(calls.some((c) => c.cmd === 'gh')).toBe(true)
  })

  test('no-arg form falls back to git config user.name', async () => {
    const calls: { cmd: string; args: string[] }[] = []
    await handleContributeCommand(makeParams(), '', makeHappyExec(calls))

    const file = fs.readFileSync(path.join(tempDir, 'CONTRIBUTORS.md'), 'utf8')
    expect(file).toContain('| @spencer | ')
    expect(renderedText()).toContain('PR opened')
  })

  test('reports when the username is already listed (duplicate-safe)', async () => {
    fs.writeFileSync(
      path.join(tempDir, 'CONTRIBUTORS.md'),
      [
        '# Contributors',
        '',
        '| GitHub | Added |',
        '|--------|-------|',
        '| @savant0x | 2026-08-06 |',
        '',
      ].join('\n'),
      'utf8',
    )
    await handleContributeCommand(makeParams(), 'savant0x', makeHappyExec([]))

    expect(renderedText()).toContain('already listed')
    const file = fs.readFileSync(path.join(tempDir, 'CONTRIBUTORS.md'), 'utf8')
    expect(file).toContain('| @savant0x | 2026-08-06 |')
  })

  test('reports partial failure: file updated locally but the PR step failed', async () => {
    const failingExec: ExecFn = (cmd, args) => {
      if (
        cmd === 'git' &&
        args[0] === 'rev-parse' &&
        args[1] === '--abbrev-ref'
      ) {
        return 'main'
      }
      if (cmd === 'git' && args[0] === 'push') {
        throw new Error('Permission denied (publickey)')
      }
      if (cmd === 'gh') throw new Error('gh: not authenticated')
      return ''
    }
    await handleContributeCommand(makeParams(), 'spencer', failingExec)

    const file = fs.readFileSync(path.join(tempDir, 'CONTRIBUTORS.md'), 'utf8')
    expect(file).toContain('| @spencer | ')

    expect(renderedText()).toContain(
      'updated locally, but the git/gh flow failed',
    )
    expect(renderedText()).toContain('Permission denied (publickey)')
    expect(renderedText()).toContain('gh auth login')
  })
})
