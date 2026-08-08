import { createAnthropic } from '@ai-sdk/anthropic'
import { OPENROUTER_API_BASE_URL } from '@savant-code/common/constants/byok'
import {
  CHATGPT_BACKEND_BASE_URL,
  toOpenAIModelId,
} from '@savant-code/common/constants/chatgpt-oauth'
import {
  COMMANDCODE_PROTOCOLS,
  OPENCODE_GO_PROTOCOLS,
} from '@savant-code/common/constants/model-config'
import {
  OpenAICompatibleChatLanguageModel,
  VERSION,
} from '@savant-code/llm-providers/openai-compatible'

import {
  createChatGptBackendFetch,
  extractChatGptAccountId,
} from '../chatgpt-backend-fetch'
import { fetchWithRetryableNetworkErrors } from './fetch-with-retry'

import type { LanguageModel } from 'ai'

/**
 * Create an OpenAI model that routes through the ChatGPT backend API (Codex endpoint).
 * Uses a custom fetch that transforms between Chat Completions and Responses API formats.
 */
export function createOpenAIOAuthModel(
  model: string,
  oauthToken: string,
): LanguageModel {
  const openAIModelId = toOpenAIModelId(model)
  const accountId = extractChatGptAccountId(oauthToken)

  return new OpenAICompatibleChatLanguageModel(openAIModelId, {
    provider: 'openai',
    url: () => `${CHATGPT_BACKEND_BASE_URL}/codex/responses`,
    headers: () => ({
      Authorization: `Bearer ${oauthToken}`,
      'Content-Type': 'application/json',
      'OpenAI-Beta': 'responses=experimental',
      originator: 'codex_cli_rs',
      accept: 'text/event-stream',
      'user-agent': `ai-sdk/openai-compatible/${VERSION}/savant-code-chatgpt-oauth`,
      ...(accountId ? { 'chatgpt-account-id': accountId } : {}),
    }),
    fetch: createChatGptBackendFetch(),
    supportsStructuredOutputs: true,
    includeUsage: undefined,
  })
}

/**
 * Create a TokenRouter model.
 * Strips the `tokenrouter/` prefix — the API expects bare model IDs (e.g.
 * `kimi-k2p6`, not `tokenrouter/kimi-k2p6`).
 */
export function createTokenRouterModel(
  apiKey: string,
  model: string,
): LanguageModel {
  const apiModelId = model.slice('tokenrouter/'.length)
  return new OpenAICompatibleChatLanguageModel(apiModelId, {
    provider: 'tokenrouter',
    url: ({ path: endpoint }) => {
      const cleanPath = endpoint.startsWith('/') ? endpoint.slice(1) : endpoint
      return new URL(cleanPath, 'https://api.tokenrouter.com/v1/').toString()
    },
    headers: () => ({
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'user-agent': `ai-sdk/openai-compatible/${VERSION}/savant-code-tokenrouter`,
    }),
    fetch: fetchWithRetryableNetworkErrors as typeof globalThis.fetch,
    includeUsage: undefined,
    supportsStructuredOutputs: false,
  })
}

/**
 * Create a TokenHarbor OpenAI-compatible model.
 * Strips only the internal `tokenharbor/` prefix and preserves nested API IDs.
 */
export function createTokenHarborModel(
  apiKey: string,
  model: string,
): LanguageModel {
  const apiModelId = model.slice('tokenharbor/'.length)
  return new OpenAICompatibleChatLanguageModel(apiModelId, {
    provider: 'tokenharbor',
    url: ({ path: endpoint }) => {
      const cleanPath = endpoint.startsWith('/') ? endpoint.slice(1) : endpoint
      return new URL(cleanPath, 'https://tokenharbor.ai/v1/').toString()
    },
    headers: () => ({
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'user-agent': `ai-sdk/openai-compatible/${VERSION}/savant-code-tokenharbor`,
    }),
    fetch: fetchWithRetryableNetworkErrors as typeof globalThis.fetch,
    includeUsage: undefined,
    supportsStructuredOutputs: false,
  })
}

/**
 * Create an NVIDIA NIM model.
 * Strips the `nvidia/` prefix — the API expects namespaced IDs (e.g.
 * `zai-org/glm-5.2`, not `nvidia/zai-org/glm-5.2`).
 */
export function createNvidiaModel(
  apiKey: string,
  model: string,
): LanguageModel {
  const apiModelId = model.slice('nvidia/'.length)
  return new OpenAICompatibleChatLanguageModel(apiModelId, {
    provider: 'nvidia',
    url: ({ path: endpoint }) => {
      const cleanPath = endpoint.startsWith('/') ? endpoint.slice(1) : endpoint
      return new URL(
        cleanPath,
        'https://integrate.api.nvidia.com/v1/',
      ).toString()
    },
    headers: () => ({
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'user-agent': `ai-sdk/openai-compatible/${VERSION}/savant-code-nvidia`,
    }),
    fetch: fetchWithRetryableNetworkErrors as typeof globalThis.fetch,
    includeUsage: undefined,
    supportsStructuredOutputs: false,
  })
}

/**
 * Create a Cloudflare Workers AI model.
 * Strips the `cloudflare/` prefix and prepends `@cf/` to match Cloudflare's API model naming.
 * Base URL includes account ID in the path: /client/v4/accounts/{ACCOUNT_ID}/ai/v1/
 */
export function createCloudflareModel(
  apiKey: string,
  accountId: string,
  model: string,
): LanguageModel {
  const apiModelId = `@cf/${model.slice('cloudflare/'.length)}`
  return new OpenAICompatibleChatLanguageModel(apiModelId, {
    provider: 'cloudflare',
    url: ({ path: endpoint }) => {
      const cleanPath = endpoint.startsWith('/') ? endpoint.slice(1) : endpoint
      return new URL(
        cleanPath,
        `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/v1/`,
      ).toString()
    },
    headers: () => ({
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'user-agent': `ai-sdk/openai-compatible/${VERSION}/savant-code-cloudflare`,
    }),
    fetch: fetchWithRetryableNetworkErrors as typeof globalThis.fetch,
    includeUsage: undefined,
    supportsStructuredOutputs: false,
  })
}

/**
 * Create a direct OpenRouter model (FID-2026-0806-010).
 *
 * `openrouter/`-prefixed models (e.g. `openrouter/free`) are the FULL OpenRouter
 * model slugs — unlike tokenrouter/opencode-go the prefix is NOT stripped, and
 * the model ID is sent unchanged. Routes to `https://openrouter.ai/api/v1` with
 * the user's resolved key; attribution headers per the OpenRouter quickstart.
 */
export function createOpenRouterModel(
  apiKey: string,
  model: string,
): LanguageModel {
  return new OpenAICompatibleChatLanguageModel(model, {
    provider: 'openrouter',
    url: ({ path: endpoint }) => {
      const cleanPath = endpoint.startsWith('/') ? endpoint.slice(1) : endpoint
      return new URL(cleanPath, `${OPENROUTER_API_BASE_URL}/`).toString()
    },
    headers: () => ({
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'user-agent': `ai-sdk/openai-compatible/${VERSION}/savant-code-openrouter`,
      'HTTP-Referer': 'https://savant-code.com',
      'X-OpenRouter-Title': 'SavantCode',
      'X-OpenRouter-Categories': 'cli-agent,cloud-agent,programming-app',
    }),
    fetch: fetchWithRetryableNetworkErrors as typeof globalThis.fetch,
    includeUsage: undefined,
    supportsStructuredOutputs: true,
  })
}

/**
 * Create an OpenCode Go model.
 *
 * OpenCode Go exposes dual-protocol endpoints:
 * - OpenAI-compatible (`/v1/chat/completions`): 10 models
 * - Anthropic-compatible (`/v1/messages`): 5 models
 *
 * The protocol is determined by the model catalog lookup in OPENCODE_GO_PROTOCOLS.
 * For OpenAI-compatible models, we reuse the existing OpenAICompatibleChatLanguageModel.
 * For Anthropic-compatible models, we use @ai-sdk/anthropic with a custom base URL.
 */
export function createOpenCodeGoModel(
  apiKey: string,
  model: string,
): LanguageModel {
  const protocol = OPENCODE_GO_PROTOCOLS[model]
  if (!protocol) {
    throw new Error(
      `Unknown protocol for OpenCode Go model: ${model}. ` +
        `Model not found in OPENCODE_GO_PROTOCOLS catalog.`,
    )
  }

  const baseUrl = 'https://opencode.ai/zen/go/v1/'

  if (protocol === 'anthropic') {
    // Anthropic-compatible: use @ai-sdk/anthropic with custom base URL.
    // This avoids building a 700+ line custom adapter; @ai-sdk/anthropic is
    // already a workspace dependency and handles the /v1/messages protocol.
    // DEVIATION from FID-034 scope constraint: reference implementations
    // (opencode-dev, kilocode) were not available in the repo, so we use
    // the official SDK adapter instead of a custom Effect/Schema adapter.
    const anthropic = createAnthropic({
      baseURL: baseUrl,
      apiKey,
    })
    const apiModelId = model.slice('opencode-go/'.length)
    return anthropic(apiModelId)
  }

  // OpenAI-compatible: reuse existing adapter
  const apiModelId = model.slice('opencode-go/'.length)
  return new OpenAICompatibleChatLanguageModel(apiModelId, {
    provider: 'opencode-go',
    url: ({ path: endpoint }) => {
      const cleanPath = endpoint.startsWith('/') ? endpoint.slice(1) : endpoint
      return new URL(cleanPath, baseUrl).toString()
    },
    headers: () => ({
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'user-agent': `ai-sdk/openai-compatible/${VERSION}/savant-code-opencode-go`,
    }),
    fetch: fetchWithRetryableNetworkErrors as typeof globalThis.fetch,
    includeUsage: undefined,
    supportsStructuredOutputs: false,
  })
}

/**
 * Create a CommandCode model.
 *
 * CommandCode exposes two strict protocol endpoints:
 * - OpenAI-compatible models use `/v1/chat/completions`.
 * - Anthropic-compatible Claude models use `/v1/messages`.
 *
 * The protocol is selected from the shared catalog map. Unknown CommandCode
 * models fail closed instead of silently using the wrong request schema.
 */
export function createCommandCodeModel(
  apiKey: string,
  model: string,
): LanguageModel {
  const protocol = COMMANDCODE_PROTOCOLS[model]
  if (!protocol) {
    throw new Error(
      `Unknown protocol for CommandCode model: ${model}. ` +
        `Model not found in COMMANDCODE_PROTOCOLS catalog.`,
    )
  }

  const baseUrl = 'https://api.commandcode.ai/provider/v1/'
  const apiModelId = model.slice('commandcode/'.length)

  if (protocol === 'anthropic') {
    const anthropic = createAnthropic({
      baseURL: baseUrl,
      apiKey,
    })
    return anthropic(apiModelId)
  }

  return new OpenAICompatibleChatLanguageModel(apiModelId, {
    provider: 'commandcode',
    url: ({ path: endpoint }) => {
      const cleanPath = endpoint.startsWith('/') ? endpoint.slice(1) : endpoint
      return new URL(cleanPath, baseUrl).toString()
    },
    headers: () => ({
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'user-agent': `ai-sdk/openai-compatible/${VERSION}/savant-code-commandcode`,
    }),
    fetch: fetchWithRetryableNetworkErrors as typeof globalThis.fetch,
    includeUsage: undefined,
    supportsStructuredOutputs: false,
  })
}
