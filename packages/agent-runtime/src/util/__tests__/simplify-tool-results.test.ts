import { describe, expect, it } from 'bun:test'

import {
  simplifyReadFileResults,
  simplifyTerminalCommandResults,
  simplifyVerboseToolResults,
  TOOL_OUTPUT_LIMITS,
  truncateToolOutputValue,
  VERBOSE_TOOL_NAMES,
} from '../simplify-tool-results'

import type { SavantCodeToolOutput } from '@savant-code/common/tools/list'
import type { JSONValue } from '@savant-code/common/types/json'

// Mock logger for tests
const logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
}

describe('simplifyReadFileResults', () => {
  it('should simplify read file results by omitting content', () => {
    const input: SavantCodeToolOutput<'read_files'> = [
      {
        type: 'json',
        value: [
          {
            path: 'src/file1.ts',
            content: 'const x = 1;\nconsole.log(x);',
            referencedBy: { 'file2.ts': ['line 5'] },
          },
          {
            path: 'src/file2.ts',
            content:
              'import { x } from "./file1";\nfunction test() { return x; }',
          },
        ],
      },
    ]

    const result = simplifyReadFileResults(input)

    expect(result).toEqual([
      {
        type: 'json',
        value: [
          {
            path: 'src/file1.ts',
            contentOmittedForLength: true,
          },
          {
            path: 'src/file2.ts',
            contentOmittedForLength: true,
          },
        ],
      },
    ])
  })

  it('should handle empty file results', () => {
    const input: SavantCodeToolOutput<'read_files'> = [
      {
        type: 'json',
        value: [],
      },
    ]

    const result = simplifyReadFileResults(input)

    expect(result).toEqual([
      {
        type: 'json',
        value: [],
      },
    ])
  })

  it('should handle files with contentOmittedForLength already set', () => {
    const input: SavantCodeToolOutput<'read_files'> = [
      {
        type: 'json',
        value: [
          {
            path: 'src/file1.ts',
            contentOmittedForLength: true,
          },
        ],
      },
    ]

    const result = simplifyReadFileResults(input)

    expect(result).toEqual([
      {
        type: 'json',
        value: [
          {
            path: 'src/file1.ts',
            contentOmittedForLength: true,
          },
        ],
      },
    ])
  })

  it('should not mutate the original input', () => {
    const originalInput: SavantCodeToolOutput<'read_files'> = [
      {
        type: 'json',
        value: [
          {
            path: 'src/file1.ts',
            content: 'const x = 1;',
          },
        ],
      },
    ]
    const input = structuredClone(originalInput)

    simplifyReadFileResults(input)

    // Original input should be unchanged
    expect(input).toEqual(originalInput)
  })
})

describe('simplifyTerminalCommandResults', () => {
  it('should simplify terminal command results with stdout', () => {
    const input: SavantCodeToolOutput<'run_terminal_command'> = [
      {
        type: 'json',
        value: {
          command: 'npm test',
          startingCwd: '/project',
          message: 'Tests completed',
          stderr: '',
          stdout: 'Test suite passed\n✓ All tests passed',
          exitCode: 0,
        },
      },
    ]

    const result = simplifyTerminalCommandResults({
      messageContent: input,
      logger,
    })

    expect(result).toEqual([
      {
        type: 'json',
        value: {
          command: 'npm test',
          message: 'Tests completed',
          stdoutOmittedForLength: true,
          exitCode: 0,
        },
      },
    ])
  })

  it('should simplify terminal command results without message', () => {
    const input: SavantCodeToolOutput<'run_terminal_command'> = [
      {
        type: 'json',
        value: {
          command: 'ls -la',
          stdout: 'file1.txt\nfile2.txt',
          exitCode: 0,
        },
      },
    ]

    const result = simplifyTerminalCommandResults({
      messageContent: input,
      logger,
    })

    expect(result).toEqual([
      {
        type: 'json',
        value: {
          command: 'ls -la',
          stdoutOmittedForLength: true,
          exitCode: 0,
        },
      },
    ])
  })

  it('should simplify terminal command results without exitCode', () => {
    const input: SavantCodeToolOutput<'run_terminal_command'> = [
      {
        type: 'json',
        value: {
          command: 'echo hello',
          stdout: 'hello',
        },
      },
    ]

    const result = simplifyTerminalCommandResults({
      messageContent: input,
      logger,
    })

    expect(result).toEqual([
      {
        type: 'json',
        value: {
          command: 'echo hello',
          stdoutOmittedForLength: true,
        },
      },
    ])
  })

  it('should handle background process results without simplification', () => {
    const input: SavantCodeToolOutput<'run_terminal_command'> = [
      {
        type: 'json',
        value: {
          command: 'npm start',
          processId: 12345,
          backgroundProcessStatus: 'running' as const,
        },
      },
    ]

    const result = simplifyTerminalCommandResults({
      messageContent: input,
      logger,
    })

    expect(result).toEqual(input)
  })

  it('should handle error message results without simplification', () => {
    const input: SavantCodeToolOutput<'run_terminal_command'> = [
      {
        type: 'json',
        value: {
          command: 'invalid-command',
          errorMessage: 'Command not found',
        },
      },
    ]

    const result = simplifyTerminalCommandResults({
      messageContent: input,
      logger,
    })

    expect(result).toEqual(input)
  })

  it('should handle results that already have stdoutOmittedForLength', () => {
    const input: SavantCodeToolOutput<'run_terminal_command'> = [
      {
        type: 'json',
        value: {
          command: 'npm test',
          message: 'Tests completed',
          stdoutOmittedForLength: true,
          exitCode: 0,
        },
      },
    ]

    const result = simplifyTerminalCommandResults({
      messageContent: input,
      logger,
    })

    expect(result).toEqual([
      {
        type: 'json',
        value: {
          command: 'npm test',
          message: 'Tests completed',
          stdoutOmittedForLength: true,
          exitCode: 0,
        },
      },
    ])
  })

  it('should handle errors gracefully and return fallback result', () => {
    // Create input that will cause an error during processing
    const malformedInput = {
      invalidStructure: true,
      logger,
    } as unknown as Parameters<typeof simplifyTerminalCommandResults>[0]

    const result = simplifyTerminalCommandResults(malformedInput)

    expect(result).toEqual([
      {
        type: 'json',
        value: {
          command: '',
          stdoutOmittedForLength: true,
        },
      },
    ])
  })

  it('should not mutate the original input', () => {
    const originalInput: SavantCodeToolOutput<'run_terminal_command'> = [
      {
        type: 'json',
        value: {
          command: 'npm test',
          stdout: 'Test output',
          exitCode: 0,
        },
      },
    ]
    const input = structuredClone(originalInput)

    simplifyTerminalCommandResults({ messageContent: input, logger })

    // Original input should be unchanged
    expect(input).toEqual(originalInput)
  })

  it('should handle terminal command with stderr', () => {
    const input: SavantCodeToolOutput<'run_terminal_command'> = [
      {
        type: 'json',
        value: {
          command: 'npm test',
          stderr: 'Warning: deprecated package',
          stdout: 'Tests passed',
          exitCode: 0,
        },
      },
    ]

    const result = simplifyTerminalCommandResults({
      messageContent: input,
      logger,
    })

    expect(result).toEqual([
      {
        type: 'json',
        value: {
          command: 'npm test',
          stdoutOmittedForLength: true,
          exitCode: 0,
        },
      },
    ])
  })

  it('should handle terminal command with startingCwd', () => {
    const input: SavantCodeToolOutput<'run_terminal_command'> = [
      {
        type: 'json',
        value: {
          command: 'pwd',
          startingCwd: '/home/user/project',
          stdout: '/home/user/project',
          exitCode: 0,
        },
      },
    ]

    const result = simplifyTerminalCommandResults({
      messageContent: input,
      logger,
    })

    expect(result).toEqual([
      {
        type: 'json',
        value: {
          command: 'pwd',
          stdoutOmittedForLength: true,
          exitCode: 0,
        },
      },
    ])
  })
})

describe('truncateToolOutputValue (P2c deterministic limits)', () => {
  it('passes small values through untouched by reference', () => {
    const value: JSONValue = { ok: true, results: ['a', 'b'] }
    const result = truncateToolOutputValue(value)
    expect(result).toBe(value) // by reference — no-op
  })

  it('truncates an over-byte-limit value and attaches metadata', () => {
    const big = { data: 'x'.repeat(TOOL_OUTPUT_LIMITS.maxBytes + 100) }
    const result = truncateToolOutputValue(big) as Record<string, JSONValue>
    expect(result.truncated).toBeDefined()
    const meta = result.truncated as Record<string, unknown>
    expect(meta.reason).toContain('bytes')
    expect(meta.preview).toBeDefined()
    // The original object keys are preserved alongside the marker.
    expect(result.data).toBeDefined()
  })

  it('truncates an over-line-limit value by lines', () => {
    // JSON.stringify preserves the embedded \n chars, so the serialized form
    // genuinely exceeds the line cap while staying under the byte cap.
    const manyLines = {
      log: Array.from(
        { length: TOOL_OUTPUT_LIMITS.maxLines + 50 },
        (_, i) => `line ${i}\n`,
      ).join(''),
    }
    const result = truncateToolOutputValue(manyLines) as Record<
      string,
      JSONValue
    >
    expect(result.truncated).toBeDefined()
    const meta = result.truncated as Record<string, unknown>
    expect(meta.reason).toContain('lines')
    expect(meta.preview).toBeDefined()
  })

  it('accepts custom limits', () => {
    const small: JSONValue = { data: 'x'.repeat(5_000) }
    const result = truncateToolOutputValue(small, {
      maxBytes: 1_000,
      maxLines: 100,
      previewChars: 50,
    }) as Record<string, JSONValue>
    expect(result.truncated).toBeDefined()
  })

  it('never throws on non-serializable values', () => {
    const circular: Record<string, unknown> = {}
    circular.self = circular
    const result = truncateToolOutputValue(circular as unknown as JSONValue)
    expect(() =>
      truncateToolOutputValue(circular as unknown as JSONValue),
    ).not.toThrow()
    expect(result).toBe(circular as unknown as JSONValue)
  })
})

describe('simplifyVerboseToolResults (P2c pre-pass)', () => {
  it('truncates the JSON part of a verbose tool message', () => {
    const content = [
      {
        type: 'json' as const,
        value: {
          matches: Array.from(
            { length: TOOL_OUTPUT_LIMITS.maxLines + 10 },
            (_, i) => `file${i}.ts:${i}\n`,
          ).join(''),
        },
      },
    ]
    const result = simplifyVerboseToolResults({ messageContent: content })
    expect(result).not.toBe(content) // changed -> new array
    expect(result[0].type).toBe('json')
    const value = result[0] as { value: Record<string, JSONValue> }
    expect(value.value.truncated).toBeDefined()
  })

  it('returns the original content by reference when no truncation needed', () => {
    const content = [{ type: 'json' as const, value: { ok: true } }]
    const result = simplifyVerboseToolResults({ messageContent: content })
    expect(result).toBe(content)
  })

  it('covers the documented verbose tool set', () => {
    for (const name of [
      'code_search',
      'glob',
      'list_directory',
      'find_files',
      'read_subtree',
      'read_url',
      'web_search',
      'gravity_index',
      'read_docs',
      'run_readonly_command',
    ]) {
      expect(VERBOSE_TOOL_NAMES.has(name)).toBe(true)
    }
  })
})
