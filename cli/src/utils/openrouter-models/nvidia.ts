/**
 * NVIDIA NIM — public /v1/models endpoint (no auth required for listing)
 */
import { logger } from '../logger'
import { CATALOG_TTL_MS } from './types'

import type { NvidiaModelsResponse, OpenRouterModel } from './types'

const NVIDIA_MODELS_URL = 'https://integrate.api.nvidia.com/v1/models'

let nvidiaCache: OpenRouterModel[] | null = null
let nvidiaCacheAt = 0
let nvidiaInflight: Promise<OpenRouterModel[]> | null = null

/**
 * Fetch available models from NVIDIA NIM's public /v1/models endpoint.
 * Returns a cached copy when fresh; degrades to empty list on failure.
 * Never throws.
 */
export async function fetchNvidiaModels(
  forceRefresh = false,
): Promise<OpenRouterModel[]> {
  const now = Date.now()
  const fresh =
    nvidiaCache !== null &&
    !forceRefresh &&
    now - nvidiaCacheAt < CATALOG_TTL_MS
  if (fresh && nvidiaCache) return nvidiaCache
  if (nvidiaInflight) return nvidiaInflight

  nvidiaInflight = (async () => {
    try {
      const resp = await fetch(NVIDIA_MODELS_URL, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(10_000),
      })
      if (!resp.ok) throw new Error(`NVIDIA NIM models HTTP ${resp.status}`)
      const json = (await resp.json()) as NvidiaModelsResponse
      const models: OpenRouterModel[] = (json.data ?? [])
        .filter((m): m is { id: string } => !!m.id)
        .map((m) => ({
          id: `nvidia/${m.id}`,
          name: m.id,
          provider: 'nvidia' as const,
        }))
      models.sort((a, b) => a.id.localeCompare(b.id))
      nvidiaCache = models
      nvidiaCacheAt = Date.now()
      return models
    } catch (error) {
      logger.warn(
        { error: error instanceof Error ? error.message : String(error) },
        'Failed to fetch NVIDIA NIM model catalog; using cache or empty list',
      )
      return nvidiaCache ?? []
    } finally {
      nvidiaInflight = null
    }
  })()

  return nvidiaInflight
}

/** Synchronous read of the cached NVIDIA catalog (or empty). */
export function getCachedNvidiaModels(): OpenRouterModel[] {
  return nvidiaCache ?? []
}

/** Test-only: clear the NVIDIA cache + in-flight request. */
export function __resetNvidiaCacheForTest(): void {
  nvidiaCache = null
  nvidiaCacheAt = 0
  nvidiaInflight = null
}
