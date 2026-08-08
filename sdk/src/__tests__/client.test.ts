import { describe, expect, test, mock, afterEach } from 'bun:test'

import { SavantCodeClient } from '../client'

describe('SavantCodeClient', () => {
  const originalFetch = globalThis.fetch

  const setFetchMock = (mockFetch: ReturnType<typeof mock>) => {
    globalThis.fetch = mockFetch as unknown as typeof fetch
  }

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  describe('checkConnection', () => {
    test('returns true without fetching in direct mode (FID-2026-0806-009)', async () => {
      const mockFetch = mock(() => {
        throw new Error('fetch should not be called in direct mode')
      })

      setFetchMock(mockFetch)
      process.env.DIRECT_PROVIDER = 'openrouter'
      process.env.INFERENCE_BASE_URL = 'https://openrouter.ai/api/v1'

      try {
        const client = new SavantCodeClient({ apiKey: 'test-key' })
        const result = await client.checkConnection()

        expect(result).toBe(true)
        expect(mockFetch).toHaveBeenCalledTimes(0)
      } finally {
        delete process.env.DIRECT_PROVIDER
        delete process.env.INFERENCE_BASE_URL
      }
    })

    test('returns true when healthz responds with status ok', async () => {
      const mockFetch = mock(() =>
        Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ status: 'ok' }),
        } as Response),
      )

      setFetchMock(mockFetch)

      const client = new SavantCodeClient({ apiKey: 'test-key' })
      const result = await client.checkConnection()

      expect(result).toBe(true)
      expect(mockFetch).toHaveBeenCalledTimes(1)
    })

    test('returns false when response is not ok', async () => {
      const mockFetch = mock(() =>
        Promise.resolve({
          ok: false,
          json: () => Promise.resolve({ status: 'ok' }),
        } as Response),
      )

      setFetchMock(mockFetch)

      const client = new SavantCodeClient({ apiKey: 'test-key' })
      const result = await client.checkConnection()

      expect(result).toBe(false)
      expect(mockFetch).toHaveBeenCalledTimes(1)
    })

    test('returns false when status is not ok', async () => {
      const mockFetch = mock(() =>
        Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ status: 'error' }),
        } as Response),
      )

      setFetchMock(mockFetch)

      const client = new SavantCodeClient({ apiKey: 'test-key' })
      const result = await client.checkConnection()

      expect(result).toBe(false)
    })

    test('returns false when response is not valid JSON', async () => {
      const mockFetch = mock(() =>
        Promise.resolve({
          ok: true,
          json: () => Promise.reject(new Error('Invalid JSON')),
        } as Response),
      )

      setFetchMock(mockFetch)

      const client = new SavantCodeClient({ apiKey: 'test-key' })
      const result = await client.checkConnection()

      expect(result).toBe(false)
    })

    test('returns false when fetch throws an error', async () => {
      const mockFetch = mock(() => Promise.reject(new Error('Network error')))

      setFetchMock(mockFetch)

      const client = new SavantCodeClient({ apiKey: 'test-key' })
      const result = await client.checkConnection()

      expect(result).toBe(false)
    })

    test('returns false when response body is not an object', async () => {
      const mockFetch = mock(() =>
        Promise.resolve({
          ok: true,
          json: () => Promise.resolve('not an object'),
        } as Response),
      )

      setFetchMock(mockFetch)

      const client = new SavantCodeClient({ apiKey: 'test-key' })
      const result = await client.checkConnection()

      expect(result).toBe(false)
    })

    test('returns false when response body is null', async () => {
      const mockFetch = mock(() =>
        Promise.resolve({
          ok: true,
          json: () => Promise.resolve(null),
        } as Response),
      )

      setFetchMock(mockFetch)

      const client = new SavantCodeClient({ apiKey: 'test-key' })
      const result = await client.checkConnection()

      expect(result).toBe(false)
    })

    test('returns false when response body has no status field', async () => {
      const mockFetch = mock(() =>
        Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ message: 'healthy' }),
        } as Response),
      )

      setFetchMock(mockFetch)

      const client = new SavantCodeClient({ apiKey: 'test-key' })
      const result = await client.checkConnection()

      expect(result).toBe(false)
    })
  })
})
