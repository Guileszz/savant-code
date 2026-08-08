/**
 * Model-id matching and context-window resolution across the OpenRouter and
 * gateway catalogs, plus the markdown model-info block used in prompts.
 */
import { getContextWindowForModel } from '../constants'
import { getCachedGatewayModels } from './gateway'
import { getCachedOpenRouterModels } from './openrouter'

import type { OpenRouterModel } from './types'

/** Infer a display provider from a model id like "openai/gpt-5". */
export function getProviderFromModelId(modelId: string): string {
  const [provider] = modelId.split('/')
  return provider ?? modelId
}

/**
 * Format a markdown block describing a model for injection into the agent
 * system prompt. Unknown fields are omitted. When no metadata is available,
 * a minimal fallback using the model id is produced.
 */
export function formatModelInfo(
  modelId: string,
  model?: OpenRouterModel,
  resolvedContextWindow?: number,
): string {
  if (!model) {
    return `# Model Information

You are running on **${modelId}**.

Full metadata unavailable; the model was not found in the cached OpenRouter catalog.`
  }

  const lines: string[] = []
  lines.push(`# Model Information`)
  lines.push(``)
  lines.push(`You are running on **${model.name}** (\`${model.id}\`).`)
  lines.push(``)
  const provider = model.provider ?? getProviderFromModelId(modelId)
  if (provider) {
    lines.push(`- **Provider:** ${provider}`)
  }
  if (model.description) {
    lines.push(`- **Description:** ${model.description}`)
  }
  const contextLength =
    typeof resolvedContextWindow === 'number'
      ? resolvedContextWindow
      : model.contextLength
  if (typeof contextLength === 'number') {
    lines.push(`- **Context window:** ${contextLength.toLocaleString()} tokens`)
  }
  if (typeof model.maxCompletionTokens === 'number') {
    lines.push(
      `- **Max completion tokens:** ${model.maxCompletionTokens.toLocaleString()}`,
    )
  }
  if (typeof model.promptPricePerToken === 'number') {
    lines.push(
      `- **Input price:** $${(model.promptPricePerToken * 1_000_000).toFixed(2)} per 1M tokens`,
    )
  }
  if (typeof model.completionPricePerToken === 'number') {
    lines.push(
      `- **Output price:** $${(model.completionPricePerToken * 1_000_000).toFixed(2)} per 1M tokens`,
    )
  }
  if (model.modality) {
    lines.push(`- **Modalities:** ${model.modality}`)
  }
  if (model.knowledgeCutoff) {
    lines.push(`- **Knowledge cutoff:** ${model.knowledgeCutoff}`)
  }
  if (model.tokenizer) {
    lines.push(`- **Tokenizer:** ${model.tokenizer}`)
  }
  if (model.instructType) {
    lines.push(`- **Instruct type:** ${model.instructType}`)
  }
  if (model.created) {
    lines.push(`- **Created:** ${model.created}`)
  }

  return lines.join('\n')
}

/**
 * Strip provider prefixes (tokenrouter/, tokenharbor/, nvidia/, opencode-go/)
 * and variant suffixes (-free, -fast, :free) from a model ID to get the canonical
 * OpenRouter model ID for context-window lookup.
 *
 * Examples:
 *   "tokenrouter/z-ai/glm-5.2-free" → "z-ai/glm-5.2"
 *   "tokenrouter/openai/gpt-5.5-pro" → "openai/gpt-5.5-pro"
 *   "z-ai/glm-5.2" → "z-ai/glm-5.2"
 */
function toCanonicalModelId(modelId: string): string {
  let id = modelId
  // Strip gateway provider prefixes while preserving the upstream model path.
  id = id.replace(/^(?:tokenrouter|tokenharbor|nvidia|opencode-go)\//, '')
  // Strip variant suffixes: -free, -fast, :free, :beta
  id = id.replace(/-(?:free|fast|beta)$/, '')
  id = id.replace(/:(?:free|beta)$/, '')
  return id
}

/**
 * Look up a model in the cached gateway catalog by id, falling back to a
 * provider-prefixed match and then a base-family match.
 *
 * When the initial match comes from a hardcoded catalog (TokenRouter, OpenCode
 * Go) that has an *inferred* context length (not from the API), this function
 * also checks the live OpenRouter catalog for the canonical model ID to find
 * the real context length.
 */
export function findGatewayModel(modelId: string): OpenRouterModel | undefined {
  const catalog = getCachedGatewayModels()

  // Exact match
  const exact = catalog.find((m) => m.id === modelId)
  if (exact) return exact

  // Provider prefix variants (e.g. "openai/gpt-5" vs "gpt-5")
  const withoutProvider = catalog.find(
    (m) => m.id === modelId.replace(/^[a-z0-9-]+\//, ''),
  )
  if (withoutProvider) return withoutProvider

  // Base family match (e.g. "anthropic/claude-sonnet-4" vs "anthropic/claude-sonnet-4.8")
  // Also handles v-prefixed versions: "mimo-v2.5" → "mimo"
  const familyId = modelId.replace(/-v?\d+(\.\d+)?$/, '')
  if (familyId && familyId !== modelId) {
    const family = catalog.find((m) => m.id.startsWith(familyId))
    if (family) return family
  }

  return undefined
}

/**
 * Find the real context length for a model by checking the live OpenRouter
 * catalog. Strips provider prefixes and variant suffixes to find the base
 * model (e.g. "tokenrouter/z-ai/glm-5.2-free" → "z-ai/glm-5.2").
 * TokenHarbor model IDs follow the same internal-prefix convention.
 *
 * This is called by {@link resolveContextWindowForModel} when the gateway
 * catalog match has no contextLength or only an inferred one.
 */
function findContextLengthFromOpenRouter(modelId: string): number | undefined {
  const openRouterCatalog = getCachedOpenRouterModels()
  if (openRouterCatalog.length === 0) return undefined

  const canonical = toCanonicalModelId(modelId)

  // Helper: extract contextLength preferring topProvider if available.
  const ctx = (m: OpenRouterModel | undefined): number | undefined => {
    if (!m) return undefined
    // Prefer topProvider.contextLength when present — the OpenRouter API
    // often omits the top-level context_length for resold models.
    const tp = m.topProvider?.contextLength
    if (typeof tp === 'number') return tp
    if (typeof m.contextLength === 'number') return m.contextLength
    return undefined
  }

  // 1. Exact canonical match (e.g. "z-ai/glm-5.2" → "z-ai/glm-5.2")
  const exact = openRouterCatalog.find((m) => m.id === canonical)
  if (ctx(exact) !== undefined) return ctx(exact)!

  // 2. Try without any provider prefix at all
  const withoutProvider = canonical.replace(/^[a-z0-9-]+\//, '')
  const byBase = openRouterCatalog.find((m) => m.id === withoutProvider)
  if (ctx(byBase) !== undefined) return ctx(byBase)!

  // 3. Family match: strip version suffix and match by prefix
  // Handles v-prefixed versions: "mimo-v2.5" → "mimo" → matches "xiaomi/mimo-v2.5"
  const familyId = canonical.replace(/-v?\d+(\.\d+)?$/, '')
  if (familyId && familyId !== canonical) {
    const family = openRouterCatalog.find((m) => m.id.startsWith(familyId))
    if (ctx(family) !== undefined) return ctx(family)!
  }

  // 3b. Name-family match: when the ID-based family match misses (e.g.
  //     canonical "mimo-v2.5" → family "mimo" but OpenRouter has
  //     "xiaomi/mimo-v2.5" which doesn't start with "mimo"), fall back
  //     to matching by normalized model name.
  const familyName = familyId.split('/').pop() ?? familyId
  if (familyName && familyName !== canonical) {
    const byFamilyName = openRouterCatalog.find((m) => {
      const mFamily =
        m.id
          .split('/')
          .pop()
          ?.replace(/-v?\d+(\.\d+)?$/, '') ?? ''
      return mFamily === familyName
    })
    if (ctx(byFamilyName) !== undefined) return ctx(byFamilyName)!
  }

  // 4. Name-based fallback: when gateway model IDs (e.g.
  //    "opencode-go/mimo-v2.5") don't map 1:1 to OpenRouter IDs
  //    (e.g. "xiaomi/mimo-v2.5"), match by the human-readable name
  //    which both catalogs share.
  const gatewayModel = findGatewayModel(modelId)
  if (gatewayModel?.name) {
    const nameLower = gatewayModel.name.toLowerCase()
    // First try exact name match.
    const byName = openRouterCatalog.find(
      (m) => m.name?.toLowerCase() === nameLower,
    )
    if (ctx(byName) !== undefined) return ctx(byName)!

    // Fuzzy: match when one name contains the other (handles suffixes
    // like "MiMo V2.5" vs "MiMo V2.5 Pro").
    const byFuzzyName = openRouterCatalog.find((m) => {
      const mName = m.name?.toLowerCase() ?? ''
      return mName.includes(nameLower) || nameLower.includes(mName)
    })
    if (ctx(byFuzzyName) !== undefined) return ctx(byFuzzyName)!
  }

  return undefined
}

/**
 * Resolve the best-known context window for a model id.
 * Priority:
 * 1. Live OpenRouter catalog (via canonical model ID lookup)
 * 2. Cached gateway catalog (TokenRouter/TokenHarbor/NVIDIA/OpenCode Go)
 * 3. Name-based heuristic fallback
 * 4. 200k default
 */
export function resolveContextWindowForModel(modelId: string): number {
  // Check the live OpenRouter catalog first — it has the real context lengths
  // from the API, whereas hardcoded catalogs (TokenRouter, TokenHarbor,
  // OpenCode Go) use
  // inferred values that may be wrong (e.g. GLM 5.2 has 1M context, not 128k).
  const fromOpenRouter = findContextLengthFromOpenRouter(modelId)
  if (typeof fromOpenRouter === 'number') return fromOpenRouter

  // Fall back to the gateway catalog (may have inferred context lengths)
  const fromCatalog = findGatewayModel(modelId)
  if (typeof fromCatalog?.contextLength === 'number') {
    return fromCatalog.contextLength
  }

  return getContextWindowForModel(modelId)
}
