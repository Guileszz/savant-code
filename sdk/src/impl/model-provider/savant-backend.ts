import { BYOK_OPENROUTER_HEADER } from '@savant-code/common/constants/byok'
import {
  OpenAICompatibleChatLanguageModel,
  VERSION,
} from '@savant-code/llm-providers/openai-compatible'

import { fetchWithRetryableNetworkErrors } from './fetch-with-retry'
import { getWebsiteUrl } from '../../constants'
import {
  getByokOpenrouterApiKeyFromEnv,
  getInferenceApiKeyFromEnv,
  getInferenceBaseUrlFromEnv,
} from '../../env'
import { resolveOpenRouterApiKey } from '../openrouter-key-resolver'

import type { OpenRouterUsageAccounting, ProviderParsedResponse } from './types'
import type { JSONValue } from '@savant-code/common/types/json'
import type { LanguageModel } from 'ai'

/**
 * Create a model that routes through the SavantCode backend.
 * This is the existing behavior - requests go to SavantCode backend which forwards to OpenRouter.
 *
 * When `INFERENCE_BASE_URL` is set, routes directly to that base URL instead of
 * the SavantCode backend. When `INFERENCE_API_KEY` or `OR_MASTER_KEY` is set, uses
 * the resolved OpenRouter key for authorization.
 */
export async function createSavantCodeBackendModel(
  apiKey: string,
  model: string,
): Promise<LanguageModel> {
  const openrouterUsage: OpenRouterUsageAccounting = {
    cost: null,
    costDetails: {
      upstreamInferenceCost: null,
    },
  }

  const openrouterApiKey = getByokOpenrouterApiKeyFromEnv()
  const inferenceBaseUrl = getInferenceBaseUrlFromEnv()
  const resolvedOpenRouterKey = await resolveOpenRouterApiKey()
  const authorizationKey =
    resolvedOpenRouterKey ?? getInferenceApiKeyFromEnv() ?? apiKey

  return new OpenAICompatibleChatLanguageModel(model, {
    provider: 'savant-code',
    url: ({ path: endpoint }) => {
      const baseUrl = inferenceBaseUrl ?? getWebsiteUrl()
      // Ensure the base URL path is preserved: /api/v1 + /chat/completions
      // becomes /api/v1/chat/completions (not /chat/completions).
      const baseHref = baseUrl.endsWith('/') ? baseUrl : baseUrl + '/'
      const cleanPath = endpoint.startsWith('/') ? endpoint.slice(1) : endpoint
      return new URL(cleanPath, baseHref).toString()
    },
    headers: () => ({
      Authorization: `Bearer ${authorizationKey}`,
      'user-agent': `ai-sdk/openai-compatible/${VERSION}/savant-code`,
      'HTTP-Referer': getWebsiteUrl(),
      'X-OpenRouter-Title': 'SavantCode',
      'X-OpenRouter-Categories': 'cli-agent,cloud-agent,programming-app',
      ...(openrouterApiKey && { [BYOK_OPENROUTER_HEADER]: openrouterApiKey }),
    }),
    metadataExtractor: {
      extractMetadata: async ({
        parsedBody: rawParsedBody,
      }: {
        parsedBody: Record<string, JSONValue>
      }) => {
        const parsedBody = rawParsedBody as ProviderParsedResponse
        if (openrouterApiKey !== undefined) {
          return { 'savant-code': { usage: openrouterUsage } }
        }

        if (typeof parsedBody?.usage?.cost === 'number') {
          openrouterUsage.cost = parsedBody.usage.cost
        }
        if (
          typeof parsedBody?.usage?.cost_details?.upstream_inference_cost ===
          'number'
        ) {
          openrouterUsage.costDetails.upstreamInferenceCost =
            parsedBody.usage.cost_details.upstream_inference_cost
        }
        return { 'savant-code': { usage: openrouterUsage } }
      },
      createStreamExtractor: () => ({
        processChunk: (rawParsedChunk: Record<string, JSONValue>) => {
          const parsedChunk = rawParsedChunk as ProviderParsedResponse
          if (openrouterApiKey !== undefined) {
            return
          }

          if (typeof parsedChunk?.usage?.cost === 'number') {
            openrouterUsage.cost = parsedChunk.usage.cost
          }
          if (
            typeof parsedChunk?.usage?.cost_details?.upstream_inference_cost ===
            'number'
          ) {
            openrouterUsage.costDetails.upstreamInferenceCost =
              parsedChunk.usage.cost_details.upstream_inference_cost
          }
        },
        buildMetadata: () => {
          return { 'savant-code': { usage: openrouterUsage } }
        },
      }),
    },
    // Cast: Bun's fetch type also declares a `preconnect` helper, but the AI
    // SDK only ever invokes fetch as a plain function.
    fetch: fetchWithRetryableNetworkErrors as typeof globalThis.fetch,
    includeUsage: undefined,
    supportsStructuredOutputs: true,
  })
}
