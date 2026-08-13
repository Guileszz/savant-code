import { getErrorObject } from '@savant-code/common/util/error'
import { truncateString } from '@savant-code/common/util/string'

import { fetchWithRetry } from './fetch-with-retry'
import { getWebsiteUrl } from '../../constants'
import { isDirectProviderMode } from '../../env'

import type {
  AddAgentStepFn,
  FinishAgentRunFn,
  StartAgentRunFn,
} from '@savant-code/common/types/contracts/database'
import type { ParamsOf } from '@savant-code/common/types/function-params'

export async function startAgentRun(
  params: ParamsOf<StartAgentRunFn>,
): ReturnType<StartAgentRunFn> {
  const { apiKey, agentId, ancestorRunIds, logger } = params

  // Dev-mode bypass: when DIRECT_PROVIDER or INFERENCE_BASE_URL is set (no
  // SavantCode backend), return a generated runId instead of a network request.
  if (isDirectProviderMode()) {
    logger.debug('startAgentRun: no-backend mode, returning generated runId')
    return crypto.randomUUID()
  }

  const url = new URL(`/api/v1/agent-runs`, getWebsiteUrl())

  try {
    const response = await fetchWithRetry(
      url,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          action: 'START',
          agentId,
          ancestorRunIds,
        }),
      },
      logger,
    )

    if (!response.ok) {
      logger.error({ response }, 'startAgentRun request failed')
      return null
    }

    const responseBody = await response.json()
    if (!responseBody?.runId) {
      logger.error(
        { responseBody },
        'no runId found from startAgentRun request',
      )
    }
    return responseBody?.runId ?? null
  } catch (error) {
    logger.error(
      { error: getErrorObject(error), agentId },
      'startAgentRun error',
    )
    return null
  }
}

export async function finishAgentRun(
  params: ParamsOf<FinishAgentRunFn>,
): ReturnType<FinishAgentRunFn> {
  const {
    apiKey,
    runId,
    status,
    totalSteps,
    directCredits,
    totalCredits,
    errorMessage,
    logger,
  } = params

  // No-backend mode (FID-2026-0806-009): nothing to report — return.
  if (isDirectProviderMode()) {
    logger.debug('finishAgentRun: no-backend mode, skipping')
    return
  }

  const url = new URL(`/api/v1/agent-runs`, getWebsiteUrl())

  try {
    const response = await fetchWithRetry(
      url,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          action: 'FINISH',
          runId,
          status,
          totalSteps,
          directCredits,
          totalCredits,
          // Truncate: errorMessage can include a full stack trace
          errorMessage:
            errorMessage === undefined
              ? undefined
              : truncateString(errorMessage, 5000),
        }),
      },
      logger,
    )

    if (!response.ok) {
      logger.error({ response }, 'finishAgentRun request failed')
      return
    }
  } catch (error) {
    logger.error(
      { error: getErrorObject(error), runId, status },
      'finishAgentRun error',
    )
  }
}

export async function addAgentStep(
  params: ParamsOf<AddAgentStepFn>,
): ReturnType<AddAgentStepFn> {
  const {
    apiKey,
    agentRunId,
    stepNumber,
    credits,
    childRunIds,
    messageId,
    status = 'completed',
    errorMessage,
    startTime,
    logger,
  } = params

  // No-backend mode (FID-2026-0806-009): nothing to record — return.
  if (isDirectProviderMode()) {
    logger.debug('addAgentStep: no-backend mode, skipping')
    return null
  }

  const url = new URL(`/api/v1/agent-runs/${agentRunId}/steps`, getWebsiteUrl())

  try {
    const response = await fetchWithRetry(
      url,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          stepNumber,
          credits,
          childRunIds,
          messageId,
          status,
          errorMessage,
          startTime,
        }),
      },
      logger,
    )

    if (!response.ok) {
      logger.error({ response }, 'addAgentStep request failed')
      return null
    }

    const responseBody = await response.json()

    if (!responseBody?.stepId) {
      logger.error(
        { responseBody },
        'no stepId found from addAgentStep request',
      )
    }
    return responseBody.stepId ?? null
  } catch (error) {
    logger.error(
      {
        error: getErrorObject(error),
        agentRunId,
        stepNumber,
        credits,
        childRunIds,
        messageId,
        status,
        errorMessage,
        startTime,
      },
      'addAgentStep error',
    )
    return null
  }
}
