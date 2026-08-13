import { describe, expect, it, mock, beforeEach, afterEach } from 'bun:test'

import { validateAgents } from '../validate-agents'

import type { AgentDefinition } from '..'

describe('validateAgents', () => {
  describe('remote validation', () => {
    let mockFetch: ReturnType<typeof mock>
    const originalFetch = globalThis.fetch

    beforeEach(() => {
      mockFetch = mock(() => {
        throw new Error('fetch mock not configured')
      })
      globalThis.fetch = Object.assign(mockFetch, {
        preconnect: () => {},
      }) as typeof fetch
    })

    afterEach(() => {
      globalThis.fetch = originalFetch
      mock.restore()
    })

    it('should call the web API when remote option is enabled', async () => {
      const agents: AgentDefinition[] = [
        {
          id: 'test-agent',
          displayName: 'Test Agent',
          model: 'anthropic/claude-sonnet-4',
        },
      ]

      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({
          success: true,
          validationErrors: [],
          errorCount: 0,
        }),
      })

      const result = await validateAgents(agents, {
        remote: true,
        websiteUrl: 'https://test.savant-code.com',
      })

      expect(mockFetch).toHaveBeenCalledTimes(1)
      expect(mockFetch).toHaveBeenCalledWith(
        'https://test.savant-code.com/api/agents/validate',
        expect.objectContaining({
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ agentDefinitions: agents }),
        }),
      )
      expect(result.success).toBe(true)
    })

    it('should use default websiteUrl from environment when not provided', async () => {
      const agents: AgentDefinition[] = [
        {
          id: 'test-agent',
          displayName: 'Test Agent',
          model: 'anthropic/claude-sonnet-4',
        },
      ]

      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({
          success: true,
          validationErrors: [],
          errorCount: 0,
        }),
      })

      const result = await validateAgents(agents, {
        remote: true,
        // websiteUrl not provided - should use default from WEBSITE_URL constant
      })

      expect(mockFetch).toHaveBeenCalledTimes(1)
      // Verify it called with some URL (the default from environment)
      const callUrl = (mockFetch.mock.calls[0] as [string, ...unknown[]])[0]
      expect(callUrl).toMatch(/\/api\/agents\/validate$/)
      expect(result.success).toBe(true)
    })

    it('should handle API validation errors', async () => {
      const agents: AgentDefinition[] = [
        {
          id: 'bad-agent',
          displayName: 'Bad Agent',
          model: 'anthropic/claude-sonnet-4',
        },
      ]

      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({
          success: false,
          validationErrors: [
            {
              filePath: 'bad-agent',
              message: 'Agent "bad-agent": Invalid configuration',
            },
          ],
          errorCount: 1,
        }),
      })

      const result = await validateAgents(agents, {
        remote: true,
        websiteUrl: 'https://test.savant-code.com',
      })

      expect(result.success).toBe(false)
      expect(result.errorCount).toBe(1)
      expect(result.validationErrors[0].message).toContain(
        'Invalid configuration',
      )
    })

    it('should handle HTTP errors from API', async () => {
      const agents: AgentDefinition[] = [
        {
          id: 'test-agent',
          displayName: 'Test Agent',
          model: 'anthropic/claude-sonnet-4',
        },
      ]

      mockFetch.mockResolvedValue({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
        json: async () => ({ error: 'Server error occurred' }),
      })

      const result = await validateAgents(agents, {
        remote: true,
        websiteUrl: 'https://test.savant-code.com',
      })

      expect(result.success).toBe(false)
      expect(result.errorCount).toBe(1)
      expect(result.validationErrors[0].id).toBe('network_error')
      expect(result.validationErrors[0].message).toContain(
        'Server error occurred',
      )
    })

    it('should handle network failures', async () => {
      const agents: AgentDefinition[] = [
        {
          id: 'test-agent',
          displayName: 'Test Agent',
          model: 'anthropic/claude-sonnet-4',
        },
      ]

      mockFetch.mockRejectedValue(new Error('Network request failed'))

      const result = await validateAgents(agents, {
        remote: true,
        websiteUrl: 'https://test.savant-code.com',
      })

      expect(result.success).toBe(false)
      expect(result.errorCount).toBe(1)
      expect(result.validationErrors[0].id).toBe('network_error')
      expect(result.validationErrors[0].message).toContain('Failed to connect')
    })

    it('should handle malformed API responses', async () => {
      const agents: AgentDefinition[] = [
        {
          id: 'test-agent',
          displayName: 'Test Agent',
          model: 'anthropic/claude-sonnet-4',
        },
      ]

      mockFetch.mockResolvedValue({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
        json: async () => {
          throw new Error('Invalid JSON')
        },
      })

      const result = await validateAgents(agents, {
        remote: true,
        websiteUrl: 'https://test.savant-code.com',
      })

      expect(result.success).toBe(false)
      expect(result.errorCount).toBe(1)
      expect(result.validationErrors[0].id).toBe('network_error')
    })

    it('should handle API response missing validationErrors field', async () => {
      const agents: AgentDefinition[] = [
        {
          id: 'test-agent',
          displayName: 'Test Agent',
          model: 'anthropic/claude-sonnet-4',
        },
      ]

      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({
          success: false,
          // validationErrors missing!
        }),
      })

      const result = await validateAgents(agents, {
        remote: true,
        websiteUrl: 'https://test.savant-code.com',
      })

      // Should handle gracefully with empty errors
      expect(result.success).toBe(true)
      expect(result.validationErrors).toEqual([])
    })

    it('should handle very large number of agents in remote validation', async () => {
      const agents: AgentDefinition[] = Array.from({ length: 100 }, (_, i) => ({
        id: `agent-${i}`,
        displayName: `Agent ${i}`,
        model: 'anthropic/claude-sonnet-4',
      }))

      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({
          success: true,
          validationErrors: [],
          errorCount: 0,
        }),
      })

      const result = await validateAgents(agents, {
        remote: true,
        websiteUrl: 'https://test.savant-code.com',
      })

      expect(result.success).toBe(true)
      expect(mockFetch).toHaveBeenCalledTimes(1)
      // Verify all agents were sent
      const requestBody = JSON.parse(
        (mockFetch.mock.calls[0] as [string, { body: string }])[1].body,
      )
      expect(requestBody.agentDefinitions.length).toBe(100)
    })

    it('should handle timeout-like errors', async () => {
      const agents: AgentDefinition[] = [
        {
          id: 'test-agent',
          displayName: 'Test Agent',
          model: 'anthropic/claude-sonnet-4',
        },
      ]

      mockFetch.mockRejectedValue(new Error('The operation was aborted'))

      const result = await validateAgents(agents, {
        remote: true,
        websiteUrl: 'https://test.savant-code.com',
      })

      expect(result.success).toBe(false)
      expect(result.validationErrors[0].message).toContain('Failed to connect')
    })
  })
})
