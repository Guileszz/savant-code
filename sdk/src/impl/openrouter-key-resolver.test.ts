import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import {
  resetOpenRouterApiKeyCache,
  resolveOpenRouterApiKey,
} from './openrouter-key-resolver'

const ENV_KEYS = ['OR_MASTER_KEY', 'OPENROUTER_API_KEY', 'INFERENCE_API_KEY'] as const

describe('OpenRouter API key resolver', () => {
  let originalEnv: Record<string, string | undefined>
  let originalFetch: typeof globalThis.fetch
  let fetchCalls: number

  beforeEach(() => {
    originalEnv = Object.fromEntries(
      ENV_KEYS.map((key) => [key, process.env[key]]),
    )
    for (const key of ENV_KEYS) delete process.env[key]
    originalFetch = globalThis.fetch
    fetchCalls = 0
    resetOpenRouterApiKeyCache()
  })

  afterEach(() => {
    for (const key of ENV_KEYS) {
      const value = originalEnv[key]
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    globalThis.fetch = originalFetch
    resetOpenRouterApiKeyCache()
  })

  test('prefers master-key exchange over regular and inference keys', async () => {
    process.env.OR_MASTER_KEY = 'master-key'
    process.env.OPENROUTER_API_KEY = 'regular-key'
    process.env.INFERENCE_API_KEY = 'inference-key'
    globalThis.fetch = (async () => {
      fetchCalls += 1
      return new Response(JSON.stringify({ key: 'exchanged-key' }), {
        status: 200,
      })
    }) as unknown as typeof globalThis.fetch

    await expect(resolveOpenRouterApiKey()).resolves.toBe('exchanged-key')
    expect(fetchCalls).toBe(1)
  })

  test('deduplicates concurrent master-key exchanges', async () => {
    process.env.OR_MASTER_KEY = 'master-key'
    let resolveFetch: ((response: Response) => void) | undefined
    globalThis.fetch = (() => {
      fetchCalls += 1
      return new Promise<Response>((resolve) => {
        resolveFetch = resolve
      })
    }) as unknown as typeof globalThis.fetch

    const first = resolveOpenRouterApiKey()
    const second = resolveOpenRouterApiKey()
    expect(fetchCalls).toBe(1)
    resolveFetch?.(
      new Response(JSON.stringify({ key: 'exchanged-key' }), { status: 200 }),
    )

    await expect(first).resolves.toBe('exchanged-key')
    await expect(second).resolves.toBe('exchanged-key')
    expect(fetchCalls).toBe(1)
  })

  test('uses the regular key before the inference fallback', async () => {
    process.env.OPENROUTER_API_KEY = 'regular-key'
    process.env.INFERENCE_API_KEY = 'inference-key'

    await expect(resolveOpenRouterApiKey()).resolves.toBe('regular-key')
    expect(fetchCalls).toBe(0)
  })

  test('uses the inference key when no regular key exists', async () => {
    process.env.INFERENCE_API_KEY = 'inference-key'

    await expect(resolveOpenRouterApiKey()).resolves.toBe('inference-key')
  })

  test('observes a newly assigned key after a previously keyless resolution', async () => {
    await expect(resolveOpenRouterApiKey()).resolves.toBeUndefined()
    process.env.OPENROUTER_API_KEY = 'new-key'
    await expect(resolveOpenRouterApiKey()).resolves.toBe('new-key')
  })

  test('observes a changed regular key after a successful resolution', async () => {
    process.env.OPENROUTER_API_KEY = 'first-key'
    await expect(resolveOpenRouterApiKey()).resolves.toBe('first-key')
    process.env.OPENROUTER_API_KEY = 'second-key'

    await expect(resolveOpenRouterApiKey()).resolves.toBe('second-key')
  })
})
