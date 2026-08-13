/**
 * Live Nous Research model catalog.
 *
 * Nous exposes an OpenAI-compatible authenticated `/v1/models` endpoint. The
 * shared live-catalog fetcher supplies bounded timeout, cache, in-flight
 * deduplication, stale-cache fallback, and redacted failure handling.
 */
import { deriveLiveCatalogUrl } from '@savant-code/common/providers/derive'
import { PROVIDER_REGISTRY } from '@savant-code/common/providers/registry'

import { createLiveCatalogFetcher } from './live-catalog'

import type { OpenRouterModel } from './types'

const NOUS_MODELS_URL = deriveLiveCatalogUrl(PROVIDER_REGISTRY, 'nous')
if (!NOUS_MODELS_URL) {
  throw new Error(
    'nous catalog must be configured as live in the provider registry',
  )
}

type NousModelsResponse = {
  data?: Array<{
    id?: unknown
    name?: unknown
    description?: unknown
    context_length?: unknown
    max_completion_tokens?: unknown
    created?: unknown
  }>
}

function asOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function asOptionalNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function parseNousCatalog(json: NousModelsResponse): OpenRouterModel[] {
  const parsed: OpenRouterModel[] = []
  for (const model of json.data ?? []) {
    const upstreamId = asOptionalString(model.id)
    if (!upstreamId) continue

    parsed.push({
      id: upstreamId.startsWith('nous/') ? upstreamId : `nous/${upstreamId}`,
      name: asOptionalString(model.name) ?? upstreamId,
      description: asOptionalString(model.description),
      contextLength: asOptionalNumber(model.context_length),
      maxCompletionTokens: asOptionalNumber(model.max_completion_tokens),
      created: asOptionalString(model.created),
      provider: 'nous',
    })
  }
  parsed.sort((a, b) => a.id.localeCompare(b.id))
  return parsed
}

const fetcher = createLiveCatalogFetcher<NousModelsResponse>({
  url: NOUS_MODELS_URL,
  logLabel: 'Nous Research',
  parse: parseNousCatalog,
  resolveKey: () => process.env.NOUS_API_KEY,
})

export const fetchNousModels = fetcher.fetchModels
export const getCachedNousModels = fetcher.getCachedModels
export const hasNousCatalog = fetcher.hasCatalog
export const __resetNousCacheForTest = fetcher.resetForTest

/** Test-only parser seam for catalog contract tests without network access. */
export function parseNousModelsForTest(
  json: NousModelsResponse,
): OpenRouterModel[] {
  return parseNousCatalog(json)
}
