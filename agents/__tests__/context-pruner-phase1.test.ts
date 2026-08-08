/**
 * FID-2026-0806-003 Phase 1 — P1a (structured summary contract), P1b
 * (preserved-state JSON block), P1c (user-message guarantee / first-user-turn
 * pin). Tests the pure extraction/build functions directly (no serialization).
 */
import { describe, expect, test } from 'bun:test'

import {
  buildPreservedState,
  extractPreservedState,
  mergePreservedState,
  serializePreservedState,
} from '../context-pruner/preserved-state'
import {
  buildStructuredSummary,
  findFirstUserTurnText,
} from '../context-pruner/structured-summary'

import type { JSONValue, Message } from '../types/util-types'

// ---------------------------------------------------------------------------
// Message builders
// ---------------------------------------------------------------------------

function userMsg(text: string, tags?: string[]): Message {
  return {
    role: 'user',
    content: [{ type: 'text', text }],
    ...(tags ? { tags } : {}),
  }
}

function assistantMsg(
  text: string,
  toolCalls: Array<{ toolName: string; input: Record<string, JSONValue> }> = [],
): Message {
  return {
    role: 'assistant',
    content: [
      ...(text ? [{ type: 'text' as const, text }] : []),
      ...toolCalls.map((tc) => ({
        type: 'tool-call' as const,
        toolCallId: 'tc-' + tc.toolName,
        toolName: tc.toolName,
        input: tc.input,
      })),
    ],
  }
}

function toolMsg(toolName: string, value: JSONValue): Message {
  return {
    role: 'tool',
    toolName,
    toolCallId: 'tc-' + toolName,
    content: [{ type: 'json', value }],
  }
}

// ---------------------------------------------------------------------------
// P1b — preserved state
// ---------------------------------------------------------------------------

describe('buildPreservedState (P1b)', () => {
  test('latest write_todos call wins', () => {
    const messages: Message[] = [
      assistantMsg('', [
        {
          toolName: 'write_todos',
          input: { todos: [{ task: 'old task', completed: true }] },
        },
      ]),
      assistantMsg('', [
        {
          toolName: 'write_todos',
          input: {
            todos: [
              { task: 'new task', completed: false },
              { task: 'done task', completed: true },
            ],
          },
        },
      ]),
    ]
    const state = buildPreservedState(messages)
    expect(state.todos).toEqual([
      { task: 'new task', completed: false },
      { task: 'done task', completed: true },
    ])
  })

  test('extracts file ops from tool calls', () => {
    const messages: Message[] = [
      assistantMsg('', [
        {
          toolName: 'read_files',
          input: { paths: ['src/a.ts', 'src/b.ts', 'src/a.ts'] },
        },
        { toolName: 'write_file', input: { path: 'src/new.ts' } },
        { toolName: 'str_replace', input: { path: 'src/a.ts' } },
        { toolName: 'propose_write_file', input: { path: 'src/proposed.ts' } },
        { toolName: 'propose_str_replace', input: { path: 'src/b.ts' } },
        { toolName: 'read_subtree', input: { paths: ['src/components'] } },
      ]),
    ]
    const state = buildPreservedState(messages)
    expect(state.readFiles).toEqual(['src/a.ts', 'src/b.ts', 'src/components'])
    expect(state.createdFiles).toEqual(['src/new.ts', 'src/proposed.ts'])
    expect(state.modifiedFiles).toEqual(['src/a.ts', 'src/b.ts'])
  })

  test('extracts loaded skills', () => {
    const messages: Message[] = [
      assistantMsg('', [
        { toolName: 'skill', input: { name: 'coding-typescript' } },
      ]),
      assistantMsg('', [
        { toolName: 'skill', input: { name: 'release-workflow' } },
      ]),
    ]
    const state = buildPreservedState(messages)
    expect(state.skills).toEqual(['coding-typescript', 'release-workflow'])
  })

  test('extracts the most recent FID reference from message text', () => {
    const messages: Message[] = [
      userMsg('working on FID-2026-0805-001 and then FID-2026-0806-003'),
    ]
    const state = buildPreservedState(messages)
    expect(state.fid).toBe('FID-2026-0806-003')
  })

  test('applies hard caps', () => {
    const manyFiles = Array.from({ length: 40 }, (_, i) => `src/file${i}.ts`)
    const messages: Message[] = [
      assistantMsg('', [
        { toolName: 'read_files', input: { paths: manyFiles } },
      ]),
    ]
    const state = buildPreservedState(messages)
    expect(state.readFiles.length).toBe(25)
    expect(state.readFiles[0]).toBe('src/file0.ts')
  })
})

describe('serializePreservedState / extractPreservedState (P1b)', () => {
  test('round-trips through a single-line JSON block', () => {
    const messages: Message[] = [
      assistantMsg('', [
        {
          toolName: 'write_todos',
          input: { todos: [{ task: 't1', completed: false }] },
        },
        { toolName: 'write_file', input: { path: 'src/x.ts' } },
      ]),
    ]
    const state = buildPreservedState(messages)
    const json = serializePreservedState(state)
    // Single-line JSON (no newlines) so the block stays parseable.
    expect(json).not.toContain('\n')
    expect(JSON.parse(json)).toEqual(state)
    expect(extractPreservedState(`## Preserved state\n${json}`)).toEqual(state)
  })

  test('extractPreservedState returns null when absent or malformed', () => {
    expect(extractPreservedState('no state here')).toBeNull()
    expect(extractPreservedState('## Preserved state\nnot json')).toBeNull()
  })

  test('serializePreservedState shrinks oversized states to fit the JSON cap', () => {
    // A pathological read-file list that would blow past the 8 KiB block cap:
    // 25 paths x ~380 chars = ~9.5 KiB before shrinking.
    const longSegment = 'very/long/path/to/module/with/many/segments/'.repeat(
      10,
    )
    const hugeFiles = Array.from(
      { length: 25 },
      (_, i) => `packages/${longSegment}file${i}.ts`,
    )
    const state = {
      todos: [{ task: 't', completed: false }],
      readFiles: hugeFiles,
      modifiedFiles: [],
      createdFiles: [],
      skills: [],
      fid: null,
    }
    const json = serializePreservedState(state)
    // Halving loop guarantees the cap without breaking the JSON.
    expect(json.length).toBeLessThanOrEqual(8_192)
    expect(JSON.parse(json)).not.toBeNull()
    expect(JSON.parse(json).readFiles.length).toBeLessThan(25)
  })
})

describe('empty / degenerate inputs (P1a/P1b)', () => {
  test('buildPreservedState on empty history yields an empty state', () => {
    const state = buildPreservedState([])
    expect(state).toEqual({
      todos: [],
      readFiles: [],
      modifiedFiles: [],
      createdFiles: [],
      skills: [],
      fid: null,
    })
  })

  test('buildStructuredSummary on empty history emits every section with (none) markers', () => {
    const block = buildStructuredSummary({
      messages: [],
      goalText: null,
      preservedState: buildPreservedState([]),
    })
    expect(block).toContain('<structured_state>')
    expect(block).toContain('</structured_state>')
    expect(block).toContain('(none in this window)')
    expect(block).toContain('(none)')
  })

  test('buildStandingFacts dedupes the pinned first turn against raw text', () => {
    // The same request text appearing twice must not be pinned twice, even
    // though the pinned copy is the (truncated) pinVerbatim output.
    const text = 'Repeat this request verbatim'
    const messages: Message[] = [userMsg(text), userMsg(text)]
    const block = buildStructuredSummary({
      messages,
      goalText: text,
      preservedState: buildPreservedState(messages),
    })
    const standingSection = block.split('## Goal')[0]
    expect(standingSection.match(/Repeat this request verbatim/g)).toHaveLength(
      1,
    )
  })
})

describe('mergePreservedState (P1b re-distill)', () => {
  test('newest todos win; file lists are unions, newest first', () => {
    const prev = {
      todos: [{ task: 'carried task', completed: false }],
      readFiles: ['src/old.ts'],
      modifiedFiles: [],
      createdFiles: [],
      skills: ['coding-go'],
      fid: 'FID-2026-0805-001',
    }
    const next = {
      todos: [],
      readFiles: ['src/new.ts'],
      modifiedFiles: [],
      createdFiles: [],
      skills: [],
      fid: null,
    }
    const merged = mergePreservedState(prev, next)
    expect(merged.todos).toEqual([{ task: 'carried task', completed: false }])
    expect(merged.readFiles).toEqual(['src/new.ts', 'src/old.ts'])
    expect(merged.skills).toEqual(['coding-go'])
    expect(merged.fid).toBe('FID-2026-0805-001')
  })

  test('null prev returns next unchanged', () => {
    const next = buildPreservedState([
      assistantMsg('', [{ toolName: 'skill', input: { name: 'coding-rust' } }]),
    ])
    expect(mergePreservedState(null, next)).toEqual(next)
  })
})

// ---------------------------------------------------------------------------
// P1c — first user turn pin
// ---------------------------------------------------------------------------

describe('findFirstUserTurnText (P1c)', () => {
  test('returns the first real user turn, skipping harness messages and summaries', () => {
    const messages: Message[] = [
      userMsg('instructions for the agent', ['INSTRUCTIONS_PROMPT']),
      userMsg(
        '<conversation_summary>\nprior condensed memory\n</conversation_summary>',
      ),
      userMsg('the actual first user request'),
    ]
    expect(findFirstUserTurnText(messages)).toBe(
      'the actual first user request',
    )
  })

  test('pins long first turns with a truncation notice, keeping the head', () => {
    const long = 'A'.repeat(20_000)
    const pinned = findFirstUserTurnText([userMsg(long)])
    expect(pinned).not.toBeNull()
    expect(pinned!.startsWith('AAA')).toBe(true)
    expect(pinned).toContain('[...pinned text truncated')
  })
})

// ---------------------------------------------------------------------------
// P1a — structured summary contract
// ---------------------------------------------------------------------------

describe('buildStructuredSummary (P1a)', () => {
  const goalText = 'Refactor the auth module to use the new token service'
  const messages: Message[] = [
    userMsg('Build the auth module rewrite', ['USER_PROMPT']),
    assistantMsg('Inspected src/auth.ts and src/tokens.ts', [
      {
        toolName: 'read_files',
        input: { paths: ['src/auth.ts', 'src/tokens.ts'] },
      },
      {
        toolName: 'write_todos',
        input: {
          todos: [
            { task: 'Implement token service', completed: false },
            { task: 'Update auth middleware', completed: false },
          ],
        },
      },
    ]),
    assistantMsg('Rewrote the middleware', [
      { toolName: 'str_replace', input: { path: 'src/auth.ts' } },
    ]),
    userMsg('Also handle the refresh flow'),
  ]

  function buildBlock() {
    const preserved = buildPreservedState(messages)
    return buildStructuredSummary({
      messages,
      goalText,
      preservedState: preserved,
    })
  }

  test('contains all eight required sections and the state markers', () => {
    const block = buildBlock()
    expect(block).toContain('<structured_state>')
    expect(block).toContain('</structured_state>')
    for (const heading of [
      '## Standing facts & constraints',
      '## Goal',
      '## Decisions & rationale',
      '## Files & code',
      '## Open TODOs (reference-only)',
      '## Pending user asks',
      '## Exact identifiers',
      '## Preserved state',
    ]) {
      expect(block).toContain(heading)
    }
  })

  test('forbids active-instruction headings (reference-only rule)', () => {
    const block = buildBlock()
    expect(block).not.toContain('## Next Steps')
    expect(block).not.toContain('## Remaining Work')
  })

  test('standing facts carry user turns verbatim (never paraphrased)', () => {
    const block = buildBlock()
    expect(block).toContain('Build the auth module rewrite')
    expect(block).toContain('Also handle the refresh flow')
  })

  test('pins the first user turn verbatim (P1c)', () => {
    const block = buildBlock()
    expect(block).toContain('[pinned first user turn — verbatim]')
    expect(block).toContain('Build the auth module rewrite')
  })

  test('goal section carries the latest live user request verbatim', () => {
    const block = buildBlock()
    expect(block).toContain(goalText)
  })

  test('files & code section carries file ops from preserved state', () => {
    const block = buildBlock()
    expect(block).toContain('read: src/auth.ts, src/tokens.ts')
    expect(block).toContain('modified: src/auth.ts')
  })

  test('open TODOs are reference-only with checkbox state', () => {
    const block = buildBlock()
    expect(block).toContain('- [ ] Implement token service')
    expect(block).toContain('- [ ] Update auth middleware')
  })

  test('exact identifiers are literal', () => {
    const withIds: Message[] = [
      userMsg(
        'See https://example.com/docs and FID-2026-0806-003 and src/api.ts',
      ),
    ]
    const preserved = buildPreservedState(withIds)
    const block = buildStructuredSummary({
      messages: withIds,
      goalText: null,
      preservedState: preserved,
    })
    expect(block).toContain('- https://example.com/docs')
    expect(block).toContain('- FID-2026-0806-003')
    expect(block).toContain('- src/api.ts')
  })

  test('pending asks lists an unanswered ask_user call', () => {
    const withAsk = [
      userMsg('Answer my question'),
      assistantMsg('', [
        {
          toolName: 'ask_user',
          input: { questions: [{ question: 'Which provider do you prefer?' }] },
        },
      ]),
    ]
    const preserved = buildPreservedState(withAsk)
    const block = buildStructuredSummary({
      messages: withAsk,
      goalText: 'Answer my question',
      preservedState: preserved,
    })
    expect(block).toContain('- Which provider do you prefer?')
  })

  test('pending asks is empty once the ask was answered', () => {
    const withAnsweredAsk = [
      userMsg('Answer my question'),
      assistantMsg('', [
        {
          toolName: 'ask_user',
          input: { questions: [{ question: 'Which provider do you prefer?' }] },
        },
      ]),
      toolMsg('ask_user', {
        answers: [{ selectedOption: 'OpenRouter' }],
      }),
    ]
    const preserved = buildPreservedState(withAnsweredAsk)
    const block = buildStructuredSummary({
      messages: withAnsweredAsk,
      goalText: 'Answer my question',
      preservedState: preserved,
    })
    expect(block).toContain('## Pending user asks')
    expect(block).toContain('(none)')
    expect(block).not.toContain('- Which provider do you prefer?')
  })

  test('preserved-state JSON block is embedded and re-extractable', () => {
    const block = buildBlock()
    const match = block.match(/## Preserved state\n(\{.*\})/)
    expect(match).not.toBeNull()
    // extractPreservedState parses the full block text (re-distill path).
    const extracted = extractPreservedState(block)
    expect(extracted).not.toBeNull()
    expect(extracted!.todos.length).toBe(2)
    expect(extracted!.readFiles).toEqual(['src/auth.ts', 'src/tokens.ts'])
  })
})
