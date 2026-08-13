import { shouldUseLocalTokenCount } from '@savant-code/common/constants/free-agents'
import { buildArray } from '@savant-code/common/util/array'
import { userMessage } from '@savant-code/common/util/messages'

import { getOrCreateEnforcement } from '../echo/enforcement'
import { appendGroundingRefresh } from '../echo/grounding'
import { callTokenCountAPI } from '../llm-api/savant-code-web-api'
import { getAgentPrompt } from '../templates/strings'
import {
  countTokens,
  countTokensJson,
  countTokensMessagesCached,
} from '../util/token-counter'

import type { ContextCompactor } from '../context-compactor'
import type { LoopAgentStepsParams } from './types'
import type { AgentTemplate } from '@savant-code/common/types/agent-template'
import type { Logger } from '@savant-code/common/types/contracts/logger'
import type { JSONValue } from '@savant-code/common/types/json'
import type { AgentState } from '@savant-code/common/types/session-state'
import type { CustomToolDefinitions } from '@savant-code/common/util/file'

/**
 * Computes the step prompt once per step and updates the agent state's
 * context token count (web API for SavantCode-hosted paid runs, local
 * estimation otherwise), then runs the zero-cost micro-compact and logs the
 * auto-compact threshold check. Behavior identical to the inline loop block.
 */
export async function prepareStepContext(params: {
  loopParams: LoopAgentStepsParams
  agentTemplate: AgentTemplate
  agentState: AgentState
  system: string
  toolsForTokenCount: Array<{
    name: string
    description?: string
    input_schema?: JSONValue
  }>
  contextCompactor: ContextCompactor
  logger: Logger
  additionalToolDefinitionsWithCache: () => Promise<CustomToolDefinitions>
}): Promise<{ stepPrompt: string | undefined }> {
  const {
    loopParams,
    agentTemplate,
    agentState,
    system,
    toolsForTokenCount,
    contextCompactor,
    logger,
    additionalToolDefinitionsWithCache,
  } = params

  // FID-2026-0802-005 L15: computed once per step and reused by
  // runAgentStep. Note: this runs before the programmatic step, so a
  // handleSteps generator that mutates history (e.g. set_messages) could
  // in theory make the USER_INPUT_PROMPT placeholder stale — no bundled
  // agent does this; acceptable per the FID.
  const stepPrompt = await getAgentPrompt({
    ...loopParams,
    agentTemplate,
    promptType: { type: 'stepPrompt' },
    fileContext: loopParams.fileContext,
    agentState,
    agentTemplates: loopParams.localAgentTemplates,
    logger,
    additionalToolDefinitions: additionalToolDefinitionsWithCache,
  })
  const messagesWithStepPrompt = buildArray(
    ...agentState.messageHistory,
    stepPrompt &&
      userMessage({
        content: stepPrompt,
      }),
  )

  // Count structured message content (not JSON.stringify, which inflates the
  // count and counts image base64 as text); system is a plain string; tool
  // schemas stay JSON since that's roughly how the model sees them.
  // FID-2026-0802-005 H2: countTokensMessagesCached memoizes per-message
  // counts by object identity, so the history is tokenized once over the
  // whole run instead of re-encoded every step (O(n²) → O(n)). The step
  // prompt is counted directly instead of rebuilding the array (saves the
  // per-step copy too).
  const estimateContextTokensLocally = () =>
    countTokensMessagesCached(agentState.messageHistory) +
    countTokens(stepPrompt ?? '') +
    countTokens(system) +
    countTokensJson(toolsForTokenCount)

  // Use local token estimation for external runs (OpenCode Go, BYOK,
  // savant-free) where the SavantCode web API is unavailable or unnecessary.
  // The external API ships the full message history + tools via HTTP on every
  // step, adding serial network overhead (30s timeout × 3 retries). Local
  // estimation uses gpt-tokenizer with a 1.35× fudge factor — fast and
  // accurate enough for context management. Only SavantCode-hosted paid runs
  // need the accurate API count for credit billing.
  const hasSavantCodeBackend = Boolean(
    loopParams.apiKey ?? loopParams.ciEnv.SAVANT_CODE_API_KEY,
  )
  if (
    shouldUseLocalTokenCount({
      agentId: agentTemplate.id,
      model: agentTemplate.model,
      hasSavantCodeBackend,
    })
  ) {
    agentState.contextTokenCount = estimateContextTokensLocally()
  } else {
    // SavantCode-hosted paid run: use the accurate web API count.
    const tokenCountResult = await callTokenCountAPI({
      messages: messagesWithStepPrompt as JSONValue[],
      system,
      model: agentTemplate.model,
      tools: toolsForTokenCount as Array<{
        name: string
        description?: string
        input_schema?: JSONValue
      }>,
      fetch,
      logger,
      env: { clientEnv: loopParams.clientEnv, ciEnv: loopParams.ciEnv },
      apiKey: loopParams.apiKey,
    })
    if (tokenCountResult.inputTokens !== undefined) {
      agentState.contextTokenCount = tokenCountResult.inputTokens
    } else if (tokenCountResult.error) {
      logger.warn(
        { error: tokenCountResult.error },
        'Failed to get token count from web API — falling back to local estimation',
      )
      agentState.contextTokenCount = estimateContextTokensLocally()
    }
  }

  // P3b (FID-2026-0806-003): score any compaction that ran during the
  // PREVIOUS step against the real post-response token count just computed
  // above (web API for hosted runs, local estimate otherwise). Must run
  // BEFORE the fresh shouldAutoCompact preflight below so the preflight arms
  // a new score instead of re-judging the old one. No-op when nothing was
  // armed (Hermes anti-thrash guard).
  contextCompactor.scoreCompactionEffectiveness(agentState.contextTokenCount)

  // FID-2026-0725-085: Run micro-compact before each API call to clear stale tool results.
  // This is zero-cost (no LLM call) and reduces context size incrementally.
  const thresholds = contextCompactor.getThresholds()
  const messagesBeforeMicroCompact = agentState.messageHistory.length
  const microResult = contextCompactor.microCompact(agentState.messageHistory)
  if (microResult.tokensSaved > 0) {
    // FID-2026-0802-005 L8: ContextCompactor now operates on Message[]
    // directly — the `as unknown as CompactionMessage[]` casts are gone.
    agentState.messageHistory = microResult.messages
    // FID-2026-0725-085: Log visible compaction summary.
    // Follows the Kilo Code / OpenClaude pattern: pause, output summary, proceed.
    const percentUsed = Math.round(
      (agentState.contextTokenCount / thresholds.autoCompact) * 100,
    )
    logger.info(
      {
        messagesCleared:
          messagesBeforeMicroCompact - microResult.messages.length,
        tokensSaved: microResult.tokensSaved,
        percentUsed,
      },
      `⚙️ Context micro-compacted: cleared stale tool results, ~${microResult.tokensSaved.toLocaleString()} tokens saved. Context at ${percentUsed}% of auto-compact threshold.`,
    )
    if (!agentState.parentId) {
      appendGroundingRefresh(
        agentState,
        getOrCreateEnforcement(agentState).recordCompaction().refreshText,
      )
    }
  }

  // FID-2026-0725-085: Check auto-compact threshold.
  // If context exceeds threshold, emit warning and log for diagnostics.
  // Full LLM summarization is handled by handleSteps context-pruner spawn.
  const autoCompactCheck = contextCompactor.shouldAutoCompact(
    agentState.messageHistory,
    agentState.contextTokenCount,
  )
  if (autoCompactCheck.shouldCompact) {
    if (!agentState.parentId) {
      appendGroundingRefresh(
        agentState,
        getOrCreateEnforcement(agentState).recordCompaction().refreshText,
      )
    }
    const degradationWarning = contextCompactor.getDegradationWarning()
    if (degradationWarning) {
      logger.warn(
        { contextTokenCount: agentState.contextTokenCount },
        degradationWarning,
      )
    } else {
      logger.warn(
        {
          contextTokenCount: agentState.contextTokenCount,
          threshold: thresholds.autoCompact,
        },
        `⚠️ Context approaching auto-compact threshold (${agentState.contextTokenCount.toLocaleString()} / ${thresholds.autoCompact.toLocaleString()} tokens). Full summarization will trigger via context-pruner.`,
      )
    }
  }

  return { stepPrompt }
}
