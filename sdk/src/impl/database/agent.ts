import { validateSingleAgent } from '@savant-code/common/templates/agent-validation'
import { getErrorObject } from '@savant-code/common/util/error'

import { fetchWithRetry } from './fetch-with-retry'
import { agentsResponseSchema } from './state'
import { getWebsiteUrl } from '../../constants'
import { isDirectProviderMode } from '../../env'

import type { FetchAgentFromDatabaseFn } from '@savant-code/common/types/contracts/database'
import type { DynamicAgentTemplate } from '@savant-code/common/types/dynamic-agent-template'
import type { ParamsOf } from '@savant-code/common/types/function-params'

export async function fetchAgentFromDatabase(
  params: ParamsOf<FetchAgentFromDatabaseFn>,
): ReturnType<FetchAgentFromDatabaseFn> {
  const { apiKey, parsedAgentId, logger } = params
  const { publisherId, agentId, version } = parsedAgentId

  // No-backend mode (FID-2026-0806-009): remote agent registry is backend-only.
  if (isDirectProviderMode()) {
    logger.debug(
      { parsedAgentId },
      'fetchAgentFromDatabase: no-backend mode, returning null',
    )
    return null
  }

  const url = new URL(
    `/api/v1/agents/${publisherId}/${agentId}/${version ? version : 'latest'}`,
    getWebsiteUrl(),
  )

  try {
    const response = await fetchWithRetry(
      url,
      {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${apiKey}`,
        },
      },
      logger,
    )

    if (!response.ok) {
      logger.error({ response }, 'fetchAgentFromDatabase request failed')
      return null
    }

    const responseJson = await response.json()
    const parseResult = agentsResponseSchema.safeParse(responseJson)
    if (!parseResult.success) {
      logger.error(
        { responseJson, parseResult },
        `fetchAgentFromDatabase parse error`,
      )
      return null
    }

    const agentConfig = parseResult.data
    const rawAgentData = agentConfig.data as DynamicAgentTemplate

    // Validate the raw agent data with the original agentId (not full identifier)
    const validationResult = validateSingleAgent({
      template: { ...rawAgentData, id: agentId, version: agentConfig.version },
      filePath: `${publisherId}/${agentId}@${agentConfig.version}`,
    })

    if (!validationResult.success) {
      logger.error(
        {
          publisherId,
          agentId,
          version: agentConfig.version,
          error: validationResult.error,
        },
        'fetchAgentFromDatabase: Agent validation failed',
      )
      return null
    }

    // Set the correct full agent ID for the final template. `agentTemplate` is
    // optional in the validation result type even on success — narrow instead
    // of asserting (FID-2026-0803-003 SDK-7, ECHO Law 6).
    const { agentTemplate: validatedTemplate } = validationResult
    if (!validatedTemplate) {
      logger.error(
        { publisherId, agentId, version: agentConfig.version },
        'fetchAgentFromDatabase: validation succeeded without agentTemplate',
      )
      return null
    }
    const agentTemplate = {
      ...validatedTemplate,
      id: `${publisherId}/${agentId}@${agentConfig.version}`,
    }

    logger.debug(
      {
        publisherId,
        agentId,
        version: agentConfig.version,
        fullAgentId: agentTemplate.id,
        parsedAgentId,
      },
      'fetchAgentFromDatabase: Successfully loaded and validated agent from database',
    )

    return agentTemplate
  } catch (error) {
    logger.error(
      { error: getErrorObject(error), parsedAgentId },
      'fetchAgentFromDatabase error',
    )
    return null
  }
}
