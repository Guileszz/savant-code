import fs from 'fs'
import os from 'os'
import path from 'path'

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'

import { handleTransitionPhase } from '../transition-phase'

import type { FsmPhase } from '@savant-code/common/types/session-state'
import type { ProjectFileContext } from '@savant-code/common/util/file'

function callTransition(
  currentPhase: FsmPhase | undefined,
  phase: FsmPhase,
  fileContext: Pick<ProjectFileContext, 'cwd'> & { devMode?: boolean },
) {
  return handleTransitionPhase({
    previousToolCallFinished: Promise.resolve(),
    toolCall: {
      toolCallId: 'test-call',
      toolName: 'transition_phase',
      input: { phase, reason: 'test transition' },
    },
    logger: {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
    },
    agentState: { fsmPhase: currentPhase, iterationCount: 0 },
    fileContext: fileContext as ProjectFileContext,
  })
}

function getMessage(
  result: Awaited<ReturnType<typeof callTransition>>,
): string {
  const output = result.output as { type: string; value: { message: string } }[]
  return output[0].value.message
}

describe('handleTransitionPhase — ADVERSARIAL state (FID-2026-0805-004)', () => {
  let projectRoot: string

  beforeEach(() => {
    projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fsm-adv-test-'))
  })

  afterEach(() => {
    fs.rmSync(projectRoot, { recursive: true, force: true })
  })

  it('allows audit → adversarial', async () => {
    const result = await callTransition('audit', 'adversarial', {
      cwd: projectRoot,
    })
    const message = getMessage(result)
    expect(message).toContain('audit → adversarial')
    expect(result.output).toBeDefined()
  })

  it('allows adversarial → complete (clean meta-verification)', async () => {
    const result = await callTransition('adversarial', 'complete', {
      cwd: projectRoot,
    })
    expect(getMessage(result)).toContain('adversarial → complete')
  })

  it('allows adversarial → self_correct (findings found)', async () => {
    const result = await callTransition('adversarial', 'self_correct', {
      cwd: projectRoot,
    })
    expect(getMessage(result)).toContain('adversarial → self_correct')
  })

  it('rejects adversarial → green (must route through self_correct)', async () => {
    const result = await callTransition('adversarial', 'green', {
      cwd: projectRoot,
    })
    expect(getMessage(result)).toContain('INVALID FSM transition')
  })

  it('rejects idle → adversarial (backward compatible — only reachable from audit)', async () => {
    const result = await callTransition('idle', 'adversarial', {
      cwd: projectRoot,
    })
    expect(getMessage(result)).toContain('INVALID FSM transition')
  })

  it('keeps audit → complete working when adversarial is skipped', async () => {
    const result = await callTransition('audit', 'complete', {
      cwd: projectRoot,
    })
    expect(getMessage(result)).toContain('audit → complete')
  })
})
