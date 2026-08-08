/**
 * Model provider abstraction for routing requests to the appropriate LLM provider.
 *
 * This module handles:
 * - ChatGPT OAuth: Direct requests to OpenAI API using user's OAuth token
 * - Default: Requests through SavantCode backend (which routes to OpenRouter)
 */

import {
  CHATGPT_OAUTH_ENABLED,
  isChatGptOAuthModelAllowed,
  isOpenAIProviderModel,
} from '@savant-code/common/constants/chatgpt-oauth'

import { getValidChatGptOAuthCredentials } from '../credentials'
import {
  getTokenRouterApiKeyFromEnv,
  getTokenHarborApiKeyFromEnv,
  getNvidiaApiKeyFromEnv,
  getOpenCodeGoApiKeyFromEnv,
  getCloudflareApiTokenFromEnv,
  getCloudflareAccountIdFromEnv,
  getCommandCodeApiKeyFromEnv,
} from '../env'
import {
  createTokenRouterModel,
  createTokenHarborModel,
  createNvidiaModel,
  createOpenCodeGoModel,
  createOpenRouterModel,
  createCommandCodeModel,
  createCloudflareModel,
  createOpenAIOAuthModel,
} from './model-provider/model-factories'
import {
  isChatGptOAuthRateLimited,
  resetChatGptOAuthRateLimit,
} from './model-provider/oauth-rate-limit'
import { createSavantCodeBackendModel } from './model-provider/savant-backend'
import { resolveOpenRouterApiKey } from './openrouter-key-resolver'

import type { ModelRequestParams, ModelResult } from './model-provider/types'

export type { ModelRequestParams, ModelResult } from './model-provider/types'
export {
  markChatGptOAuthRateLimited,
  isChatGptOAuthRateLimited,
  resetChatGptOAuthRateLimit,
} from './model-provider/oauth-rate-limit'

/**
 * Get the appropriate model for a request.
 *
 * If ChatGPT OAuth credentials are available and the model is an OpenAI model,
 * returns an OpenAI direct model. Otherwise, returns the SavantCode backend model.
 *
 * This function is async because it may need to refresh the OAuth token.
 */
export async function getModelForRequest(
  params: ModelRequestParams,
): Promise<ModelResult> {
  void resetChatGptOAuthRateLimit
  const { apiKey, model, skipChatGptOAuth } = params

  // Check if we should use ChatGPT OAuth direct
  // Only attempt for allowlisted models; non-allowlisted models silently fall through to backend.
  if (
    CHATGPT_OAUTH_ENABLED &&
    !skipChatGptOAuth &&
    isOpenAIProviderModel(model) &&
    isChatGptOAuthModelAllowed(model)
  ) {
    if (!isChatGptOAuthRateLimited()) {
      const chatGptOAuthCredentials = await getValidChatGptOAuthCredentials()

      if (chatGptOAuthCredentials) {
        return {
          model: createOpenAIOAuthModel(
            model,
            chatGptOAuthCredentials.accessToken,
          ),
          isChatGptOAuth: true,
        }
      }
    }
  }

  // Gateway providers: TokenRouter and NVIDIA NIM each have their own API key
  // and base URL. Check these before the SavantCode backend path — the
  // INFERENCE_BASE_URL dev-mode bypass must not affect gateway routing.
  if (isTokenRouterModel(model)) {
    const tokenRouterKey = getTokenRouterApiKeyFromEnv()
    if (!tokenRouterKey) {
      throw new Error(
        'TokenRouter API key not set. Set TOKENROUTER_API_KEY environment variable.',
      )
    }
    return {
      model: createTokenRouterModel(tokenRouterKey, model),
      isChatGptOAuth: false,
    }
  }

  if (isTokenHarborModel(model)) {
    const tokenHarborKey = getTokenHarborApiKeyFromEnv()
    if (!tokenHarborKey) {
      throw new Error(
        'TokenHarbor API key not set. Set TOKENHARBOR_API_KEY environment variable or run /provider tokenharbor.',
      )
    }
    return {
      model: createTokenHarborModel(tokenHarborKey, model),
      isChatGptOAuth: false,
    }
  }

  if (isNvidiaModel(model)) {
    const nvidiaKey = getNvidiaApiKeyFromEnv()
    if (!nvidiaKey) {
      throw new Error(
        'NVIDIA API key not set. Set NVIDIA_API_KEY environment variable.',
      )
    }
    return {
      model: createNvidiaModel(nvidiaKey, model),
      isChatGptOAuth: false,
    }
  }

  if (isOpenCodeGoModel(model)) {
    const openCodeGoKey = getOpenCodeGoApiKeyFromEnv()
    if (!openCodeGoKey) {
      throw new Error(
        'OpenCode Go API key not set. Set OPENCODE_GO_API_KEY environment variable.',
      )
    }
    return {
      model: createOpenCodeGoModel(openCodeGoKey, model),
      isChatGptOAuth: false,
    }
  }

  // Direct OpenRouter (FID-2026-0806-010): `openrouter/`-prefixed models route
  // straight to https://openrouter.ai/api/v1 with the user's own key — no
  // SavantCode backend, no INFERENCE_BASE_URL required. Boot default is
  // `openrouter/free` (free tier), so a fresh install with just
  // OPENROUTER_API_KEY (or OR_MASTER_KEY) makes its first call here.
  if (isOpenRouterModel(model)) {
    const openRouterKey = await resolveOpenRouterApiKey()
    if (!openRouterKey) {
      throw new Error(
        'OpenRouter API key not set. Set OPENROUTER_API_KEY or OR_MASTER_KEY environment variable.',
      )
    }
    return {
      model: createOpenRouterModel(openRouterKey, model),
      isChatGptOAuth: false,
    }
  }

  if (isCommandCodeModel(model)) {
    const commandCodeKey = getCommandCodeApiKeyFromEnv()
    if (!commandCodeKey) {
      throw new Error(
        'CommandCode API key not set. Set COMMAND_CODE_API_KEY environment variable.',
      )
    }
    return {
      model: createCommandCodeModel(commandCodeKey, model),
      isChatGptOAuth: false,
    }
  }

  if (isCloudflareModel(model)) {
    const cloudflareKey = getCloudflareApiTokenFromEnv()
    const cloudflareAccountId = getCloudflareAccountIdFromEnv()
    if (!cloudflareKey) {
      throw new Error(
        'Cloudflare API token not set. Set CLOUDFLARE_API_TOKEN environment variable.',
      )
    }
    if (!cloudflareAccountId) {
      throw new Error(
        'Cloudflare account ID not set. Set CLOUDFLARE_ACCOUNT_ID environment variable.',
      )
    }
    return {
      model: createCloudflareModel(cloudflareKey, cloudflareAccountId, model),
      isChatGptOAuth: false,
    }
  }

  // Default: use SavantCode backend
  return {
    model: await createSavantCodeBackendModel(apiKey, model),
    isChatGptOAuth: false,
  }
}

/**
 * Check if a model ID targets OpenCode Go (prefix: `opencode-go/`).
 * Subagents inherit the parent's model via `withParentModel()` in
 * spawn-agent-utils.ts — gateway model prefixes propagate correctly.
 */
export function isOpenCodeGoModel(model: string): boolean {
  return model.startsWith('opencode-go/')
}

/**
 * Check if a model ID targets direct OpenRouter (prefix: `openrouter/`).
 * Unlike gateway prefixes, `openrouter/` is part of the real OpenRouter slug
 * (e.g. `openrouter/free`) and is sent to the API unchanged.
 */
export function isOpenRouterModel(model: string): boolean {
  return model.startsWith('openrouter/')
}

/**
 * Check if a model ID targets TokenRouter (prefix: `tokenrouter/`).
 * Subagents inherit the parent's model via `withParentModel()` in
 * spawn-agent-utils.ts — gateway model prefixes propagate correctly.
 */
export function isTokenRouterModel(model: string): boolean {
  return model.startsWith('tokenrouter/')
}

/**
 * Check if a model ID targets TokenHarbor (prefix: `tokenharbor/`).
 * Nested provider segments remain part of the upstream model ID.
 */
export function isTokenHarborModel(model: string): boolean {
  return model.startsWith('tokenharbor/')
}

/**
 * Check if a model ID targets NVIDIA NIM (prefix: `nvidia/`).
 * Subagents inherit the parent's model via `withParentModel()` in
 * spawn-agent-utils.ts — gateway model prefixes propagate correctly.
 */
export function isNvidiaModel(model: string): boolean {
  return model.startsWith('nvidia/')
}

/**
 * Check if a model ID targets Cloudflare Workers AI (prefix: `cloudflare/`).
 */
export function isCloudflareModel(model: string): boolean {
  return model.startsWith('cloudflare/')
}

/**
 * Check if a model ID targets CommandCode (prefix: `commandcode/`).
 * Subagents inherit the parent's model via `withParentModel()` in
 * spawn-agent-utils.ts — gateway model prefixes propagate correctly.
 */
export function isCommandCodeModel(model: string): boolean {
  return model.startsWith('commandcode/')
}
