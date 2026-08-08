import { COMPOSIO_META_TOOL_NAMES } from '@savant-code/common/constants/composio'
import { clientToolNames, toolParams } from '@savant-code/common/tools/list'
import { afterEach, describe, expect, mock, test } from 'bun:test'

import { executeComposioToolViaServer } from '../composio'

describe('Composio SDK tools', () => {
  const originalFetch = globalThis.fetch
  const originalDirectProvider = process.env.DIRECT_PROVIDER
  const originalInferenceBaseUrl = process.env.INFERENCE_BASE_URL

  afterEach(() => {
    globalThis.fetch = originalFetch
    if (originalDirectProvider !== undefined) {
      process.env.DIRECT_PROVIDER = originalDirectProvider
    } else {
      delete process.env.DIRECT_PROVIDER
    }
    if (originalInferenceBaseUrl !== undefined) {
      process.env.INFERENCE_BASE_URL = originalInferenceBaseUrl
    } else {
      delete process.env.INFERENCE_BASE_URL
    }
  })

  test('returns a clear error without fetching in direct mode (FID-2026-0806-009)', async () => {
    const fetchMock = mock(async () => {
      throw new Error('fetch should not be called in direct mode')
    })
    globalThis.fetch = fetchMock as unknown as typeof fetch
    process.env.DIRECT_PROVIDER = 'openrouter'
    delete process.env.INFERENCE_BASE_URL

    const output = await executeComposioToolViaServer({
      apiKey: 'savant-code-api-key',
      toolName: 'composio_search_tools',
      input: {
        queries: ['find gmail tools'],
        session: { generate_id: true },
      },
    })

    expect(output).toEqual([
      {
        type: 'json',
        value: {
          errorMessage:
            'Composio is unavailable in direct/BYOK mode (no SavantCode backend).',
        },
      },
    ])
    expect(fetchMock).toHaveBeenCalledTimes(0)
  })

  test('registers Composio meta tools as static client tools without discovery fetch', () => {
    const fetchMock = mock(async () => new Response('{}'))
    globalThis.fetch = fetchMock as unknown as typeof fetch

    for (const toolName of COMPOSIO_META_TOOL_NAMES) {
      expect(clientToolNames).toContain(toolName)
      expect(toolParams[toolName].inputSchema).toBeDefined()
    }
    expect(fetchMock).not.toHaveBeenCalled()
  })

  test('executes a meta tool through the server execute endpoint', async () => {
    const fetchMock = mock(
      async (_url: string | URL | Request, init?: RequestInit) => {
        expect(init?.method).toBe('POST')
        expect(init?.headers).toEqual({
          Authorization: 'Bearer savant-code-api-key',
          'Content-Type': 'application/json',
        })
        expect(JSON.parse(String(init?.body))).toEqual({
          toolName: 'composio_search_tools',
          input: {
            queries: ['find gmail tools'],
            session: { generate_id: true },
          },
        })
        return new Response(
          JSON.stringify({
            output: [{ type: 'json', value: { ok: true } }],
          }),
          { status: 200 },
        )
      },
    )
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const output = await executeComposioToolViaServer({
      apiKey: 'savant-code-api-key',
      toolName: 'composio_search_tools',
      input: {
        queries: ['find gmail tools'],
        session: { generate_id: true },
      },
    })

    expect(output).toEqual([{ type: 'json', value: { ok: true } }])
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  test('returns a tool error when the server response is malformed', async () => {
    globalThis.fetch = mock(
      async () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
    ) as unknown as typeof fetch

    const output = await executeComposioToolViaServer({
      apiKey: 'savant-code-api-key',
      toolName: 'composio_search_tools',
      input: {
        queries: ['find gmail tools'],
        session: { generate_id: true },
      },
    })

    expect(output).toEqual([
      {
        type: 'json',
        value: {
          errorMessage: 'Invalid Composio execute response from server',
        },
      },
    ])
  })
})
