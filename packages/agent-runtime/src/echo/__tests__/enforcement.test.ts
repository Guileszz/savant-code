/**
 * EchoEnforcement steering tests (FID-2026-0805-007).
 *
 * Regression: strict-mode Law 7/8 pre-write blocks now collect corrective
 * steering text that the tool executor injects into the agent's message
 * history. These tests lock the budget contract: bounded total nudges, one
 * per law, deduped per law+file, with actionable corrective text.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'bun:test'

import { EchoEnforcement } from '../enforcement'

describe('EchoEnforcement — pre-write steering', () => {
  const tempDirs: string[] = []

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  function newFilePath(name: string): string {
    const dir = mkdtempSync(join(tmpdir(), 'ehel-steering-'))
    tempDirs.push(dir)
    return join(dir, name)
  }

  /** Block a strict-mode write to a never-searched new file → Law 7. */
  function blockLaw7(enforcement: EchoEnforcement, path: string) {
    return enforcement.beforeToolCall({
      toolName: 'write_file',
      input: { path },
      agentId: 'savant',
    })
  }

  /**
   * Satisfy the FID-2026-0806-005 session-init gate so these Law 7/8
   * steering tests exercise the pre-write gates, not the protocol gate.
   */
  function clearProtocolGate(enforcement: EchoEnforcement) {
    enforcement.beforeToolCall({
      toolName: 'read_files',
      input: { paths: ['ECHO.md'] },
      agentId: 'savant',
    })
  }

  it('steers once with actionable Law 7 corrective text on a blocked write', () => {
    const enforcement = new EchoEnforcement('strict')
    clearProtocolGate(enforcement)
    const result = blockLaw7(enforcement, newFilePath('a.ts'))
    expect(result.blocked).toBe(true)

    const steering = enforcement.takeSteeringMessages()
    expect(steering).toHaveLength(1)
    expect(steering[0]).toContain('Law 7')
    expect(steering[0]).toMatch(/search first/i)
    expect(steering[0]).toMatch(/glob|code_search/)
  })

  it('dedupes steering per law+file (no repeat nudge for the same violation)', () => {
    const enforcement = new EchoEnforcement('strict')
    clearProtocolGate(enforcement)
    const path = newFilePath('a.ts')

    blockLaw7(enforcement, path)
    expect(enforcement.takeSteeringMessages()).toHaveLength(1)
    // Agent retries the same write without searching — blocked again, but the
    // budget already spent its one Law 7 nudge for this file.
    blockLaw7(enforcement, path)
    expect(enforcement.takeSteeringMessages()).toHaveLength(0)
  })

  it('budgets one nudge per law across different files', () => {
    const enforcement = new EchoEnforcement('strict')
    clearProtocolGate(enforcement)

    blockLaw7(enforcement, newFilePath('a.ts'))
    blockLaw7(enforcement, newFilePath('b.ts'))
    blockLaw7(enforcement, newFilePath('c.ts'))
    expect(enforcement.takeSteeringMessages()).toHaveLength(1)
  })

  it('never emits a nudge after takeSteeringMessages drains (pending cleared)', () => {
    const enforcement = new EchoEnforcement('strict')
    blockLaw7(enforcement, newFilePath('a.ts'))
    enforcement.takeSteeringMessages()
    expect(enforcement.takeSteeringMessages()).toHaveLength(0)
  })

  it('is a no-op in hybrid mode (Law 7 is strict-only, so nothing collects)', () => {
    const enforcement = new EchoEnforcement('hybrid')
    const result = enforcement.beforeToolCall({
      toolName: 'write_file',
      input: { path: newFilePath('a.ts') },
      agentId: 'savant',
    })
    expect(result.blocked).toBe(false)
    expect(enforcement.takeSteeringMessages()).toHaveLength(0)
  })
})

describe('EchoEnforcement — session-init protocol gate (FID-2026-0806-005)', () => {
  it('blocks non-read tools before the protocol file is read (strict)', () => {
    const enforcement = new EchoEnforcement('strict')
    const result = enforcement.beforeToolCall({
      toolName: 'glob',
      input: { pattern: '**/*.ts' },
      agentId: 'savant',
    })
    expect(result.blocked).toBe(true)
    expect(result.reason).toContain('ECHO.md')
  })

  it('allows read-only context tools and ask_user/write_todos pre-read', () => {
    const enforcement = new EchoEnforcement('strict')
    for (const toolName of [
      'read_files',
      'read_subtree',
      'ask_user',
      'write_todos',
    ] as const) {
      const result = enforcement.beforeToolCall({
        toolName,
        input: toolName === 'read_files' ? { paths: ['src/a.ts'] } : {},
        agentId: 'savant',
      })
      expect(result.blocked).toBe(false)
    }
  })

  it('clears the gate when a read targets the protocol file', () => {
    const enforcement = new EchoEnforcement('strict')
    const blockedGlob = enforcement.beforeToolCall({
      toolName: 'glob',
      input: { pattern: '**/*.ts' },
      agentId: 'savant',
    })
    expect(blockedGlob.blocked).toBe(true)

    const read = enforcement.beforeToolCall({
      toolName: 'read_files',
      input: { paths: ['ECHO.md'] },
      agentId: 'savant',
    })
    expect(read.blocked).toBe(false)

    const allowedGlob = enforcement.beforeToolCall({
      toolName: 'glob',
      input: { pattern: '**/*.ts' },
      agentId: 'savant',
    })
    expect(allowedGlob.blocked).toBe(false)
  })

  it('matches a nested protocol path and a configured protocol file', () => {
    const enforcement = new EchoEnforcement('strict', {
      protocolFile: 'dev/nova/specs/echo-v0.1.2-single-agent.md',
    })
    const read = enforcement.beforeToolCall({
      toolName: 'read_files',
      input: { paths: ['dev/nova/specs/echo-v0.1.2-single-agent.md'] },
      agentId: 'savant',
    })
    expect(read.blocked).toBe(false)
    const glob = enforcement.beforeToolCall({
      toolName: 'glob',
      input: { pattern: '**/*.ts' },
      agentId: 'savant',
    })
    expect(glob.blocked).toBe(false)
  })

  it('is a no-op in hybrid mode', () => {
    const enforcement = new EchoEnforcement('hybrid')
    const result = enforcement.beforeToolCall({
      toolName: 'glob',
      input: { pattern: '**/*.ts' },
      agentId: 'savant',
    })
    expect(result.blocked).toBe(false)
  })

  it('subagent-seeded instances skip the gate', () => {
    const enforcement = new EchoEnforcement('strict', {
      protocolPreSeeded: true,
    })
    const result = enforcement.beforeToolCall({
      toolName: 'glob',
      input: { pattern: '**/*.ts' },
      agentId: 'forge',
    })
    expect(result.blocked).toBe(false)
  })

  it('injects a protocol refresh every 15 turns after the gate clears', () => {
    const enforcement = new EchoEnforcement('strict')
    enforcement.beforeToolCall({
      toolName: 'read_files',
      input: { paths: ['ECHO.md'] },
      agentId: 'savant',
    })

    let refresh: string | undefined
    for (let i = 1; i <= 15; i++) {
      refresh = enforcement.onStepBoundary().refreshText
    }
    expect(refresh).toBeDefined()
    expect(refresh).toContain('<!--echo-critical-->')
    expect(refresh).toContain('Read 0-EOF')
    // Turn 16 is not a refresh boundary; no dedupe break.
    expect(enforcement.onStepBoundary().refreshText).toBeUndefined()
  })

  it('does not refresh before the protocol is read', () => {
    const enforcement = new EchoEnforcement('strict')
    let refresh: string | undefined
    for (let i = 1; i <= 15; i++) {
      refresh = enforcement.onStepBoundary().refreshText
    }
    expect(refresh).toBeUndefined()
  })
})
