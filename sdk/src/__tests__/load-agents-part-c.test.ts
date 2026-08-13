import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs'
import os from 'os'
import path from 'path'

import { describe, expect, test, beforeEach, afterEach, mock } from 'bun:test'

import { loadLocalAgents } from '../agents/load-agents'

import type { LoadedAgents, LoadLocalAgentsResult } from '../agents/load-agents'

const MODEL_NAME = 'anthropic/claude-sonnet-4' as const

/**
 * Helper to write an agent file to the test directory.
 * @param agentsDir - The agents directory path
 * @param fileName - The file name (e.g., 'my-agent.ts')
 * @param contents - The TypeScript/JavaScript content
 */
const writeAgentFile = (
  agentsDir: string,
  fileName: string,
  contents: string,
): void => {
  writeFileSync(path.join(agentsDir, fileName), contents, 'utf8')
}

describe('loadLocalAgents', () => {
  let tempDir: string
  let agentsDir: string

  beforeEach(() => {
    tempDir = mkdtempSync(
      path.join(os.tmpdir(), 'savant-code-sdk-load-agents-'),
    )
    agentsDir = path.join(tempDir, '.agents')
  })

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true })
    mock.restore()
  })

  describe('type safety', () => {
    test('validate: false returns LoadedAgents type', async () => {
      mkdirSync(agentsDir, { recursive: true })
      writeAgentFile(
        agentsDir,
        'agent.ts',
        `
          export default {
            id: 'test-agent',
            displayName: 'Test Agent',
            model: '${MODEL_NAME}'
          }
        `,
      )

      // This should type-check as LoadedAgents
      const result: LoadedAgents = await loadLocalAgents({
        agentsPath: agentsDir,
        validate: false,
      })

      expect(result['test-agent']).toBeDefined()
    })

    test('validate: true returns LoadLocalAgentsResult type', async () => {
      mkdirSync(agentsDir, { recursive: true })
      writeAgentFile(
        agentsDir,
        'agent.ts',
        `
          export default {
            id: 'test-agent',
            displayName: 'Test Agent',
            model: '${MODEL_NAME}'
          }
        `,
      )

      // This should type-check as LoadLocalAgentsResult
      const result: LoadLocalAgentsResult = await loadLocalAgents({
        agentsPath: agentsDir,
        validate: true,
      })

      expect(result.agents).toBeDefined()
      expect(result.validationErrors).toBeDefined()
    })

    test('omitting validate returns LoadedAgents type', async () => {
      mkdirSync(agentsDir, { recursive: true })
      writeAgentFile(
        agentsDir,
        'agent.ts',
        `
          export default {
            id: 'test-agent',
            displayName: 'Test Agent',
            model: '${MODEL_NAME}'
          }
        `,
      )

      // This should type-check as LoadedAgents (backward compatible)
      const result: LoadedAgents = await loadLocalAgents({
        agentsPath: agentsDir,
      })

      expect(result['test-agent']).toBeDefined()
    })
  })
})
