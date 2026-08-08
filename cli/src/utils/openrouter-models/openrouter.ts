/**
 * Live OpenRouter model catalog.
 *
 * OpenRouter's model list changes frequently, so rather than hardcoding a
 * stale table we fetch the current catalog from their public API. The result
 * is cached per-process with a short TTL so the /model picker stays current
 * without hammering the endpoint. On any failure we degrade gracefully: the
 * caller falls back to free-text entry of an exact model id.
 */
import { logger } from '../logger'
import { CATALOG_TTL_MS } from './types'

import type { OpenRouterModel, OpenRouterModelsResponse } from './types'

const OPENROUTER_MODELS_URL = 'https://openrouter.ai/api/v1/models'

let cachedCatalog: OpenRouterModel[] | null = null
let cachedAt = 0
let inflight: Promise<OpenRouterModel[]> | null = null

function parseCatalog(json: OpenRouterModelsResponse): OpenRouterModel[] {
  const models = json.data ?? []
  const parsed: OpenRouterModel[] = []
  for (const m of models) {
    if (!m.id) continue
    const prompt = m.pricing?.prompt
    const completion = m.pricing?.completion
    const inputCacheRead = m.pricing?.input_cache_read
    const webSearch = m.pricing?.web_search
    parsed.push({
      id: m.id,
      name: m.name ?? m.id,
      description: m.description,
      contextLength: m.context_length,
      maxCompletionTokens: m.max_completion_tokens,
      promptPricePerToken: prompt !== undefined ? Number(prompt) : undefined,
      completionPricePerToken:
        completion !== undefined ? Number(completion) : undefined,
      inputCacheReadPricePerToken:
        inputCacheRead !== undefined ? Number(inputCacheRead) : undefined,
      webSearchPricePerToken:
        webSearch !== undefined ? Number(webSearch) : undefined,
      provider: undefined,
      modality: m.modality,
      tokenizer: m.tokenizer,
      instructType: m.instruct_type,
      knowledgeCutoff: m.knowledge_cutoff,
      created: m.created,
      reasoning: m.reasoning,
      topProvider: m.top_provider
        ? {
            contextLength: m.top_provider.context_length,
            maxCompletionTokens: m.top_provider.max_completion_tokens,
            isModerated: m.top_provider.is_moderated,
          }
        : undefined,
      benchmarks: m.benchmarks,
      links: m.links,
    })
  }
  // Stable, predictable order for the picker.
  parsed.sort((a, b) => a.id.localeCompare(b.id))
  return parsed
}

/**
 * Fetch the live OpenRouter model catalog.
 *
 * Returns a cached copy when fresh; otherwise fetches and caches. Concurrent
 * callers share a single in-flight request. On failure, returns the last good
 * cache if available, else an empty list — callers must handle empty as
 * "show free-text entry". Never throws.
 */
export async function fetchOpenRouterModels(
  forceRefresh = false,
): Promise<OpenRouterModel[]> {
  const now = Date.now()
  const fresh =
    cachedCatalog !== null && !forceRefresh && now - cachedAt < CATALOG_TTL_MS

  if (fresh && cachedCatalog) {
    return cachedCatalog
  }

  if (inflight) {
    return inflight
  }

  inflight = (async () => {
    try {
      const resp = await fetch(OPENROUTER_MODELS_URL, {
        headers: { Accept: 'application/json' },
        // Don't let a slow/hung catalog request block the picker forever.
        signal: AbortSignal.timeout(10_000),
      })
      if (!resp.ok) {
        throw new Error(`OpenRouter models HTTP ${resp.status}`)
      }
      const json = (await resp.json()) as OpenRouterModelsResponse
      const parsed = parseCatalog(json)
      cachedCatalog = parsed
      cachedAt = Date.now()
      return parsed
    } catch (error) {
      logger.warn(
        { error: error instanceof Error ? error.message : String(error) },
        'Failed to fetch OpenRouter model catalog; using cache or empty list',
      )
      // Degrade: prefer stale cache, else empty (free-text fallback).
      return cachedCatalog ?? []
    } finally {
      inflight = null
    }
  })()

  return inflight
}

/**
 * Synchronous read of the current catalog (cached or empty).
 * Use this for rendering the picker immediately; call
 * {@link fetchOpenRouterModels} to populate/refresh it.
 */
export function getCachedOpenRouterModels(): OpenRouterModel[] {
  return cachedCatalog ?? []
}

/** Whether a live catalog has been loaded at least once. */
export function hasOpenRouterCatalog(): boolean {
  return cachedCatalog !== null
}

/** Test-only: clear the OpenRouter catalog cache + in-flight request. */
export function __resetOpenRouterCacheForTest(): void {
  cachedCatalog = null
  cachedAt = 0
  inflight = null
}
