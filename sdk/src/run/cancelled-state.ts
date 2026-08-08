import {
  buildUserMessageContent,
  withSystemTags,
} from '@savant-code/agent-runtime/util/messages'

import { getErrorStatusCode } from '../error-utils'
import { cloneSessionState } from './types'

import type { RunState } from '../run-state'
import type { Logger } from '@savant-code/common/types/contracts/logger'
import type { JSONValue } from '@savant-code/common/types/json'
import type {
  ImagePart,
  TextPart,
} from '@savant-code/common/types/messages/content-part'
import type { SessionState } from '@savant-code/common/types/session-state'

/**
 * Builds the cancellation-state helpers for a run. These compute the session
 * state when the run is cancelled or errors: if the agent runtime made any
 * progress (replaced the shared messageHistory), those messages are preserved;
 * otherwise the user's message is added so it isn't lost.
 */
export function createCancelledStateHelpers(params: {
  sessionState: SessionState
  initialMessageHistory: SessionState['mainAgentState']['messageHistory']
  prompt?: string
  params?: Record<string, JSONValue>
  preparedContent?: (TextPart | ImagePart)[]
  traceSessionId: string
  logger?: Logger
}): {
  getCancelledSessionState: (message: string) => SessionState
  getCancelledRunState: (message?: string) => RunState
} {
  const {
    sessionState,
    initialMessageHistory,
    prompt,
    params: runParams,
    preparedContent,
    traceSessionId,
    logger,
  } = params

  /** Calculates the current session state if cancelled.
   *
   * This is used when callMainPrompt throws an error. If the agent runtime made
   * any progress (replaced the shared messageHistory), those messages are
   * preserved. Otherwise the user's message is added so it isn't lost.
   */
  function getCancelledSessionState(message: string): SessionState {
    const runtimeMadeProgress =
      sessionState.mainAgentState.messageHistory !== initialMessageHistory

    const state = cloneSessionState(sessionState, logger)

    // Only add the user's message if the runtime didn't get a chance to add it.
    if (!runtimeMadeProgress && (prompt || preparedContent)) {
      state.mainAgentState.messageHistory.push({
        role: 'user' as const,
        content: buildUserMessageContent(prompt, runParams, preparedContent),
        tags: ['USER_PROMPT'] as string[],
      })
    }

    // Add error context message
    state.mainAgentState.messageHistory.push({
      role: 'user' as const,
      content: [{ type: 'text' as const, text: withSystemTags(message) }],
    })
    return state
  }
  function getCancelledRunState(message?: string): RunState {
    message = message ?? 'Run cancelled by user.'
    return {
      sessionState: getCancelledSessionState(message),
      traceSessionId,
      output: {
        type: 'error',
        message,
      },
    }
  }

  return { getCancelledSessionState, getCancelledRunState }
}

/**
 * Builds the setup-failure error mapper: resolves an error RunState instead of
 * rejecting (FID-2026-0802-008 E2). sessionState is deliberately omitted,
 * matching the D2 pre-abort convention.
 */
export function createErrorRunStateFrom(params: {
  traceSessionId: string
}): (error: unknown) => RunState {
  const { traceSessionId } = params
  return (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error)
    const statusCode = getErrorStatusCode(error)
    return {
      traceSessionId,
      output: {
        type: 'error' as const,
        message,
        ...(statusCode !== undefined && { statusCode }),
      },
    }
  }
}
