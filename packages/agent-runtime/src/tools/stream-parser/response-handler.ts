import { userMessage } from '@savant-code/common/util/messages'

import { withSystemTags } from '../../util/messages'

import type { Message } from '@savant-code/common/types/messages/savant-code-message'
import type { PrintModeEvent } from '@savant-code/common/types/print-mode'

/**
 * Builds the response handler that captures tool events into
 * assistantMessages. When isXmlMode=true, also captures tool_result events for
 * interleaved ordering.
 * (FID-2026-0809-016: extracted from `tools/stream-parser.ts`.)
 */
export function createResponseHandler(params: {
  onResponseChunk: (chunk: string | PrintModeEvent) => void
  errorMessages: Message[]
  markToolCallError: () => void
}): (chunk: string | PrintModeEvent) => void {
  const { onResponseChunk, errorMessages, markToolCallError } = params
  return (chunk: string | PrintModeEvent) => {
    if (typeof chunk !== 'string') {
      if (chunk.type === 'error') {
        markToolCallError()
        errorMessages.push(
          userMessage({
            content: withSystemTags(
              `Error during tool call: ${chunk.message}. Please check the tool name and arguments and try again.`,
            ),
            tags: ['TOOL_CALL_ERROR'],
          }),
        )
      }
    }
    return onResponseChunk(chunk)
  }
}
