import { getErrorObject } from '@savant-code/common/util/error'
import { cloneDeep } from 'lodash'

import type { SavantCodeToolOutput } from '@savant-code/common/tools/list'
import type { Logger } from '@savant-code/common/types/contracts/logger'
import type { JSONValue } from '@savant-code/common/types/json'
import type { ToolResultOutput } from '@savant-code/common/types/messages/content-part'

// ===========================================================================
// P2c — generalized deterministic tool-output truncation (FID-2026-0806-003)
//
// Unbounded tool payloads (grep/glob/search/db/URL results) are a primary
// vector for token exhaustion. This cheap no-LLM pre-pass truncates verbose
// tool outputs to deterministic byte/line limits BEFORE they reach the summary
// or next LLM call (research Layer 3: 50 000 B API/db, 2 000-line grep,
// 500-char preview + pointer).
// ===========================================================================

export const TOOL_OUTPUT_LIMITS = {
  /** Hard byte cap for API/database-style results. */
  maxBytes: 50_000,
  /** Hard line cap for search/grep-style results. */
  maxLines: 2_000,
  /** Preview length kept after truncation (plus a pointer to the full data). */
  previewChars: 500,
} as const

/** Tool names whose results are routinely large enough to need the pre-pass. */
export const VERBOSE_TOOL_NAMES: ReadonlySet<string> = new Set([
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
])

export type ToolOutputLimits = {
  maxBytes: number
  maxLines: number
  previewChars: number
}

/**
 * Truncates a tool-result JSON value to the deterministic limits. Returns the
 * original value when it already fits; otherwise a trimmed value with a
 * `truncated` metadata marker describing what was omitted. Never throws — a
 * non-serializable value is passed through untouched.
 *
 * Line counting: JSON.stringify escapes real newlines as `\\n` (backslash-n),
 * so the serialized form's `\\n` sequences are what represent output lines
 * (grep/glob-style string payloads). An over-line value is cut at that
 * boundary; the `truncated.preview` keeps the first `previewChars` chars.
 */
export function truncateToolOutputValue(
  value: JSONValue,
  limits: Partial<ToolOutputLimits> = {},
): JSONValue {
  const maxBytes = limits.maxBytes ?? TOOL_OUTPUT_LIMITS.maxBytes
  const maxLines = limits.maxLines ?? TOOL_OUTPUT_LIMITS.maxLines
  const previewChars = limits.previewChars ?? TOOL_OUTPUT_LIMITS.previewChars

  let json: string
  try {
    json = JSON.stringify(value)
  } catch {
    return value
  }
  if (json === undefined) return value

  // Escaped newlines (`\\n` in the serialized form) represent real output
  // lines. If neither cap is exceeded, pass the value through by reference.
  const lineCount = json.split('\\n').length
  if (json.length <= maxBytes && lineCount <= maxLines) {
    return value
  }

  const originalChars = json.length
  const reason =
    originalChars > maxBytes
      ? `output exceeded ${maxBytes} bytes`
      : `output exceeded ${maxLines} lines`

  // Build a bounded kept payload by value shape, then attach the marker.
  let kept: JSONValue
  if (typeof value === 'string') {
    kept = value.slice(0, previewChars)
  } else if (Array.isArray(value)) {
    kept = value.slice(0, maxLines)
  } else if (value !== null && typeof value === 'object') {
    // Keep the object's own fields (bounded by the model's per-field caps)
    // and let the marker carry the omission summary.
    kept = { ...(value as Record<string, JSONValue>) }
  } else {
    kept = value
  }
  const keptJson = JSON.stringify(kept) ?? ''

  return {
    ...(typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Record<string, JSONValue>)
      : {}),
    ...(Array.isArray(value) ? { keptItems: value.slice(0, maxLines) } : {}),
    truncated: {
      reason,
      originalChars,
      keptChars: keptJson.length,
      omittedChars: originalChars - keptJson.length,
      preview:
        keptJson.length > previewChars
          ? keptJson.slice(0, previewChars)
          : keptJson,
      // Pointer for the full output: the cache-debug snapshot (when enabled)
      // retains the pre-truncation value on disk; this names that location.
      fullOutput: '[See cache-debug snapshot / rerun the tool for full output]',
    },
  }
}

/**
 * Generic pre-pass for the verbose tool set. Returns the message content with
 * every JSON part's value truncated to the deterministic limits. When the
 * truncation is a no-op the original content is returned by reference.
 */
export function simplifyVerboseToolResults(params: {
  messageContent: ToolResultOutput[]
}): ToolResultOutput[] {
  const { messageContent } = params
  const truncated: ToolResultOutput[] = messageContent.map((part) => {
    if (part.type !== 'json' || part.value === undefined) return part
    const value = truncateToolOutputValue(part.value)
    if (value === part.value) return part
    return { type: 'json' as const, value }
  })
  const changed = truncated.some((part, i) => part !== messageContent[i])
  return changed ? truncated : messageContent
}

export function simplifyReadFileResults(
  messageContent: SavantCodeToolOutput<'read_files'>,
): SavantCodeToolOutput<'read_files'> {
  return [
    {
      type: 'json',
      value: cloneDeep(messageContent[0]).value.map(({ path }) => {
        return {
          path,
          contentOmittedForLength: true,
        }
      }),
    },
  ]
}

export function simplifyTerminalCommandResults(params: {
  messageContent: SavantCodeToolOutput<'run_terminal_command'>
  logger: Logger
}): SavantCodeToolOutput<'run_terminal_command'> {
  const { messageContent, logger } = params
  try {
    const clone = cloneDeep(messageContent)
    const content = clone[0].value
    if ('processId' in content || 'errorMessage' in content) {
      return clone
    }
    const { command, message, exitCode } = content
    return [
      {
        type: 'json',
        value: {
          command,
          ...(message && { message }),
          stdoutOmittedForLength: true,
          ...(exitCode !== undefined && { exitCode }),
        },
      },
    ]
  } catch (error) {
    logger.error(
      { error: getErrorObject(error), messageContent },
      'Error simplifying terminal command results',
    )
    return [
      {
        type: 'json',
        value: {
          command: '',
          stdoutOmittedForLength: true,
        },
      },
    ]
  }
}
