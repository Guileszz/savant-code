/**
 * Combined gateway catalog — OpenRouter + TokenRouter + TokenHarbor + NVIDIA NIM
 * + OpenCode Go + CommandCode — plus subscription plumbing.
 */
import { logger } from '../logger'
import {
  __resetNvidiaCacheForTest,
  fetchNvidiaModels,
  getCachedNvidiaModels,
} from './nvidia'
import {
  __resetOpenRouterCacheForTest,
  fetchOpenRouterModels,
  getCachedOpenRouterModels,
} from './openrouter'
import {
  fetchCommandCodeModels,
  fetchOpenCodeGoModels,
  fetchTokenRouterModels,
  getTokenHarborModels,
} from './static-catalogs'
import { CATALOG_TTL_MS } from './types'

import type { OpenRouterModel } from './types'

let gatewayCache: OpenRouterModel[] | null = null
let gatewayCacheAt = 0
let gatewayInflight: Promise<OpenRouterModel[]> | null = null
const gatewayCatalogListeners = new Set<(catalog: OpenRouterModel[]) => void>()

/**
 * Synchronous read of the combined gateway catalog (cached or empty).
 * Includes OpenRouter, TokenRouter, NVIDIA NIM, and OpenCode Go models.
 */
export function getCachedGatewayModels(): OpenRouterModel[] {
  return gatewayCache ?? []
}

/**
 * Subscribe to gateway catalog updates.
 * The listener receives the full cached catalog whenever it is populated
 * or refreshed. Returns an unsubscribe function.
 */
export function subscribeGatewayCatalog(
  listener: (catalog: OpenRouterModel[]) => void,
): () => void {
  gatewayCatalogListeners.add(listener)
  return () => gatewayCatalogListeners.delete(listener)
}

function notifyGatewayCatalogListeners(catalog: OpenRouterModel[]): void {
  for (const listener of gatewayCatalogListeners) {
    try {
      listener(catalog)
    } catch (error) {
      logger.warn(
        { error: error instanceof Error ? error.message : String(error) },
        'Gateway catalog listener threw; continuing with remaining listeners',
      )
    }
  }
}

/**
 * Fetch the combined model catalog from all providers:
 * - OpenRouter (live API, public)
 * - NVIDIA NIM (live API, public)
 * - TokenRouter (hardcoded, requires auth for API)
 * - TokenHarbor (hardcoded baseline; authenticated catalog intentionally skipped)
 * - OpenCode Go (hardcoded, subscription-gated)
 * - CommandCode (hardcoded, provider catalog)
 *
 * Fetches live sources in parallel via Promise.allSettled(). If a source fails,
 * uses cached/empty list for that provider. Returns a combined, sorted list.
 * Caches per-process with the same TTL as OpenRouter.
 */
export async function fetchGatewayModels(
  forceRefresh = false,
): Promise<OpenRouterModel[]> {
  const now = Date.now()
  const fresh =
    gatewayCache !== null &&
    !forceRefresh &&
    now - gatewayCacheAt < CATALOG_TTL_MS
  if (fresh && gatewayCache) return gatewayCache
  if (gatewayInflight) return gatewayInflight

  gatewayInflight = (async () => {
    const [orResult, nvidiaResult] = await Promise.allSettled([
      fetchOpenRouterModels(forceRefresh),
      fetchNvidiaModels(forceRefresh),
    ])

    const orModels =
      orResult.status === 'fulfilled'
        ? orResult.value
        : getCachedOpenRouterModels()
    const nvidiaModels =
      nvidiaResult.status === 'fulfilled'
        ? nvidiaResult.value
        : getCachedNvidiaModels()
    const tokenrouterModels = fetchTokenRouterModels()
    const tokenharborModels = getTokenHarborModels()
    const openCodeGoModels = fetchOpenCodeGoModels()
    const commandCodeModels = fetchCommandCodeModels()

    const combined = [
      ...orModels,
      ...tokenrouterModels,
      ...tokenharborModels,
      ...nvidiaModels,
      ...openCodeGoModels,
      ...commandCodeModels,
    ]
    combined.sort((a, b) => a.id.localeCompare(b.id))
    gatewayCache = combined
    gatewayCacheAt = Date.now()
    notifyGatewayCatalogListeners(combined)
    return combined
  })()

  return gatewayInflight
}

/**
 * Test-only: clear all in-memory catalog caches + in-flight requests so tests
 * start from a known state. Not used in production.
 */
export function __resetOpenRouterModelsCacheForTest(): void {
  __resetOpenRouterCacheForTest()
  __resetNvidiaCacheForTest()
  gatewayCache = null
  gatewayCacheAt = 0
  gatewayInflight = null
  // Note: intentionally do not clear gatewayCatalogListeners here. This reset
  // is for cache state; listeners (including the gateway-catalog store) should
  // survive test resets so subscriptions remain intact.
}
