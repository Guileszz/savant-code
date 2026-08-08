import { isAbortError, getErrorObject } from '@savant-code/common/util/error'
import { userMessage } from '@savant-code/common/util/messages'

import { ContextCompactor } from '../context-compactor'
import { clearProgrammaticRunState } from '../run-programmatic-step'
import { buildLoopErrorOutput } from './error-output'
import { createLoopContext } from './loop-context'
import { runLoopIteration, type LoopIterationState } from './loop-iteration'
import { runAgentStep } from './step'
import { resetThinkerConvergenceState } from '../tools/thinker-convergence-gate'
import { cleanupThoughtSession } from '../tools/thought-session-store'
import { getAgentOutput } from '../util/agent-output'
import { withSystemTags, expireMessages } from '../util/messages'
import { recordPostCompact } from '../util/token-telemetry'

import type { LoopAgentStepsParams, LoopAgentStepsResult } from './types'

/**
 * Runs the agent loop.
 *
 * IMPORTANT: This function mutates `params.agentState` in place throughout the
 * run (not just at return time). Fields like `messageHistory`, `systemPrompt`,
 * `toolDefinitions`, `creditsUsed`, and `output` are updated as work progresses
 * so that callers holding a reference to the same object (e.g. the SDK's
 * `sessionState.mainAgentState`) see in-progress work immediately — which
 * matters when an error is thrown mid-run and the normal return path is
 * skipped.
 */
export async function loopAgentSteps(
  params: LoopAgentStepsParams,
): Promise<LoopAgentStepsResult> {
  const {
    agentState: initialAgentState,
    agentType,
    clearUserPromptMessagesAfterResponse = true,
    finishAgentRun,
    localAgentTemplates,
    logger,
    parentSystemPrompt,
    parentTools,
    prompt,
    signal,
    spawnParams,
  } = params

  const setupResult = await createLoopContext({
    params,
    agentState: initialAgentState,
    agentType,
    parentTools,
    parentSystemPrompt,
  })
  if (!setupResult.ok) {
    return {
      agentState: setupResult.agentState,
      output: {
        type: 'error',
        message: 'Run cancelled by user',
      },
    }
  }
  const {
    agentTemplate,
    runId,
    system,
    tools,
    toolsForTokenCount,
    additionalToolDefinitionsWithCache,
    getCachedAdditionalToolDefinitions,
    contextCompactor,
  } = setupResult.ctx

  const state: LoopIterationState = {
    agentState: initialAgentState,
    shouldEndTurn: false,
    totalSteps: 0,
    nResponses: undefined,
    consecutiveNativeIncompleteSteps: 0,
    hasRetriedOutputSchema: false,
    currentPrompt: prompt,
    currentParams: spawnParams,
  }

  try {
    while (true) {
      const iteration = await runLoopIteration({
        loopParams: params,
        state,
        ctx: {
          agentTemplate,
          system,
          tools,
          runId,
          toolsForTokenCount,
          contextCompactor,
          additionalToolDefinitionsWithCache,
          getCachedAdditionalToolDefinitions,
          localAgentTemplates,
          logger,
          signal,
          initialAgentState,
        },
      })
      if (!iteration.shouldContinue) {
        break
      }
    }

    if (clearUserPromptMessagesAfterResponse) {
      initialAgentState.messageHistory = expireMessages(
        initialAgentState.messageHistory,
        'userPrompt',
      )
    }

    await finishAgentRun({
      ...params,
      runId,
      status: 'completed',
      totalSteps: state.totalSteps,
      directCredits: initialAgentState.directCreditsUsed,
      totalCredits: initialAgentState.creditsUsed,
    })

    return {
      agentState: initialAgentState,
      output: getAgentOutput(initialAgentState, agentTemplate),
    }
  } catch (error) {
    // Handle user-initiated aborts separately - don't log as errors
    if (isAbortError(error)) {
      if (clearUserPromptMessagesAfterResponse) {
        initialAgentState.messageHistory = expireMessages(
          initialAgentState.messageHistory,
          'userPrompt',
        )
      }

      initialAgentState.messageHistory = [
        ...initialAgentState.messageHistory,
        userMessage(
          withSystemTags(
            "User interrupted the response. The assistant's previous work has been preserved.",
          ),
        ),
      ]

      logger.info(
        {
          agentType,
          agentId: initialAgentState.agentId,
          runId,
          totalSteps: state.totalSteps,
          messageHistory: initialAgentState.messageHistory,
        },
        'Agent run cancelled by user (abort error)',
      )

      await finishAgentRun({
        ...params,
        runId,
        status: 'cancelled',
        totalSteps: state.totalSteps,
        directCredits: initialAgentState.directCreditsUsed,
        totalCredits: initialAgentState.creditsUsed,
      })

      return {
        agentState: initialAgentState,
        output: {
          type: 'error',
          message: 'Run cancelled by user',
        },
      }
    }

    // FID-2026-0725-085 Layer 4: Reactive compact — catch prompt-too-long errors,
    // aggressively truncate, and retry once before surfacing the error.
    if (ContextCompactor.isPromptTooLongError(error) && !signal.aborted) {
      logger.warn(
        { error: getErrorObject(error) },
        'Layer 4 reactive compact: prompt-too-long detected, attempting emergency truncation',
      )
      const reactiveResult = contextCompactor.reactiveCompact(
        initialAgentState.messageHistory,
      )
      if (reactiveResult.truncated) {
        const beforeCount = initialAgentState.messageHistory.length
        initialAgentState.messageHistory = reactiveResult.messages
        logger.warn(
          {
            messagesRemoved: beforeCount - reactiveResult.messages.length,
            tokensSaved: reactiveResult.tokensSaved,
          },
          `Layer 4 reactive compact: truncated ${beforeCount - reactiveResult.messages.length} messages, saved ~${reactiveResult.tokensSaved.toLocaleString()} tokens. Retrying API call once.`,
        )
        // P4c (FID-2026-0806-003): PostCompact event (Axon pattern) with the
        // ratio metrics; feeds analytics + the CLI status surface. Non-blocking.
        try {
          recordPostCompact(
            {
              originalTokens: initialAgentState.contextTokenCount,
              compressedTokens: Math.max(
                0,
                initialAgentState.contextTokenCount -
                  reactiveResult.tokensSaved,
              ),
              compressionRatio:
                initialAgentState.contextTokenCount > 0
                  ? Math.min(
                      1,
                      reactiveResult.tokensSaved /
                        initialAgentState.contextTokenCount,
                    )
                  : 0,
              summaryPreview: `Reactive compact: ${beforeCount - reactiveResult.messages.length} messages removed (~${reactiveResult.tokensSaved.toLocaleString()} tokens)`,
              sessionId: runId,
            },
            logger,
          )
        } catch {
          // best-effort
        }
        // Retry the API call once after reactive compaction
        try {
          const retryResult = await runAgentStep({
            ...params,
            agentState: initialAgentState,
            agentTemplate,
            n: undefined,
            prompt: state.currentPrompt,
            runId,
            spawnParams: state.currentParams,
            system,
            tools,
            additionalToolDefinitions: additionalToolDefinitionsWithCache,
            customToolDefinitions: getCachedAdditionalToolDefinitions(),
          })
          // Retry succeeded — use the result
          Object.assign(initialAgentState, retryResult.agentState)
          contextCompactor.recordCompactionResult(
            true,
            initialAgentState.contextTokenCount,
          )
          await finishAgentRun({
            ...params,
            runId,
            status: 'completed',
            totalSteps: state.totalSteps,
            directCredits: initialAgentState.directCreditsUsed,
            totalCredits: initialAgentState.creditsUsed,
          })
          return {
            agentState: initialAgentState,
            output: getAgentOutput(initialAgentState, agentTemplate),
          }
        } catch (retryError) {
          // Retry also failed — log and fall through to standard error handling
          contextCompactor.recordCompactionResult(false)
          logger.error(
            { retryError: getErrorObject(retryError) },
            'Layer 4 reactive compact: retry also failed',
          )
        }
      }
    }

    logger.error(
      {
        error: getErrorObject(error),
        agentType,
        agentId: initialAgentState.agentId,
        runId,
        totalSteps: state.totalSteps,
        directCreditsUsed: initialAgentState.directCreditsUsed,
        creditsUsed: initialAgentState.creditsUsed,
        messageHistory: initialAgentState.messageHistory,
        systemPrompt: system,
      },
      'Agent execution failed',
    )

    const { status, errorMessage, statusCode, output } = buildLoopErrorOutput({
      error,
      signal,
    })

    await finishAgentRun({
      ...params,
      runId,
      status,
      totalSteps: state.totalSteps,
      directCredits: initialAgentState.directCreditsUsed,
      totalCredits: initialAgentState.creditsUsed,
      errorMessage,
    })

    // Payment required errors (402) should propagate
    if (statusCode === 402) {
      throw error
    }

    return {
      agentState: initialAgentState,
      output,
    }
  } finally {
    // The endTurn path inside runProgrammaticStep handles normal completion,
    // but abort/error exits (e.g. chat SSE disconnects) would otherwise leak
    // the run's generator, STEP_ALL flag, and proposed file content forever.
    clearProgrammaticRunState(runId)
    // FID-2026-0801-012: per-run ThoughtSession and retry counters must not
    // leak across abort/error exits; cleanup is idempotent and marks an
    // in-flight session cancelled.
    cleanupThoughtSession(runId)
    resetThinkerConvergenceState(runId)
  }
}
