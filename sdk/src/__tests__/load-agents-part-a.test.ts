import { existsSync, mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs'
import os from 'os'
import path from 'path'

import {
  describe,
  expect,
  test,
  beforeEach,
  afterEach,
  mock,
  spyOn,
} from 'bun:test'

import { loadLocalAgents } from '../agents/load-agents'
import { logger } from '../utils/logger'

import type { LoadedAgents, LoadedAgentDefinition } from '../agents/load-agents'

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

  describe('without validation (backward compatible)', () => {
    test('returns empty object when agents directory does not exist', async () => {
      const result: LoadedAgents = await loadLocalAgents({
        agentsPath: agentsDir,
      })

      expect(result).toEqual({})
    })

    test('returns empty object when agents directory is empty', async () => {
      mkdirSync(agentsDir, { recursive: true })

      const result: LoadedAgents = await loadLocalAgents({
        agentsPath: agentsDir,
      })

      expect(result).toEqual({})
    })

    test('loads valid agent definitions', async () => {
      mkdirSync(agentsDir, { recursive: true })
      writeAgentFile(
        agentsDir,
        'my-agent.ts',
        `
          export default {
            id: 'my-agent',
            displayName: 'My Agent',
            model: '${MODEL_NAME}',
            instructionsPrompt: 'Help the user'
          }
        `,
      )

      const result: LoadedAgents = await loadLocalAgents({
        agentsPath: agentsDir,
      })

      const agent: LoadedAgentDefinition | undefined = result['my-agent']
      expect(agent).toBeDefined()
      expect(agent!.id).toBe('my-agent')
      expect(agent!.displayName).toBe('My Agent')
      expect(agent!.model).toBe(MODEL_NAME)
      expect(agent!._sourceFilePath).toBe(path.join(agentsDir, 'my-agent.ts'))
    })

    test('loads multiple agents from directory', async () => {
      mkdirSync(agentsDir, { recursive: true })
      writeAgentFile(
        agentsDir,
        'agent-one.ts',
        `
          export default {
            id: 'agent-one',
            displayName: 'Agent One',
            model: '${MODEL_NAME}'
          }
        `,
      )
      writeAgentFile(
        agentsDir,
        'agent-two.ts',
        `
          export default {
            id: 'agent-two',
            displayName: 'Agent Two',
            model: '${MODEL_NAME}'
          }
        `,
      )

      const result: LoadedAgents = await loadLocalAgents({
        agentsPath: agentsDir,
      })
      const agentIds: string[] = Object.keys(result)

      expect(agentIds).toHaveLength(2)
      expect(result['agent-one']).toBeDefined()
      expect(result['agent-two']).toBeDefined()
    })

    test('skips agents missing required id field', async () => {
      mkdirSync(agentsDir, { recursive: true })
      writeAgentFile(
        agentsDir,
        'no-id.ts',
        `
          export default {
            displayName: 'No ID Agent',
            model: '${MODEL_NAME}'
          }
        `,
      )

      const result: LoadedAgents = await loadLocalAgents({
        agentsPath: agentsDir,
      })

      expect(Object.keys(result)).toHaveLength(0)
    })

    test('skips agents missing required model field', async () => {
      mkdirSync(agentsDir, { recursive: true })
      writeAgentFile(
        agentsDir,
        'no-model.ts',
        `
          export default {
            id: 'no-model-agent',
            displayName: 'No Model Agent'
          }
        `,
      )

      const result: LoadedAgents = await loadLocalAgents({
        agentsPath: agentsDir,
      })

      expect(Object.keys(result)).toHaveLength(0)
    })

    test('skips .d.ts declaration files', async () => {
      mkdirSync(agentsDir, { recursive: true })
      writeAgentFile(
        agentsDir,
        'types.d.ts',
        `
          export default {
            id: 'dts-agent',
            displayName: 'DTS Agent',
            model: '${MODEL_NAME}'
          }
        `,
      )

      const result: LoadedAgents = await loadLocalAgents({
        agentsPath: agentsDir,
      })

      expect(result['dts-agent']).toBeUndefined()
    })

    test('skips .test.ts test files', async () => {
      mkdirSync(agentsDir, { recursive: true })
      writeAgentFile(
        agentsDir,
        'agent.test.ts',
        `
          export default {
            id: 'test-file-agent',
            displayName: 'Test File Agent',
            model: '${MODEL_NAME}'
          }
        `,
      )

      const result: LoadedAgents = await loadLocalAgents({
        agentsPath: agentsDir,
      })

      expect(result['test-file-agent']).toBeUndefined()
    })

    test('loads agents from nested directories', async () => {
      const nestedDir: string = path.join(agentsDir, 'nested', 'deep')
      mkdirSync(nestedDir, { recursive: true })
      writeAgentFile(
        nestedDir,
        'nested-agent.ts',
        `
          export default {
            id: 'nested-agent',
            displayName: 'Nested Agent',
            model: '${MODEL_NAME}'
          }
        `,
      )

      const result: LoadedAgents = await loadLocalAgents({
        agentsPath: agentsDir,
      })

      expect(result['nested-agent']).toBeDefined()
    })

    test('skips files inside the skills directory', async () => {
      mkdirSync(agentsDir, { recursive: true })
      const skillsDir: string = path.join(agentsDir, 'skills')
      mkdirSync(skillsDir, { recursive: true })
      writeAgentFile(
        skillsDir,
        'some-skill.ts',
        `
          export default {
            id: 'skill-agent',
            displayName: 'Skill Agent',
            model: '${MODEL_NAME}'
          }
        `,
      )
      writeAgentFile(
        agentsDir,
        'real-agent.ts',
        `
          export default {
            id: 'real-agent',
            displayName: 'Real Agent',
            model: '${MODEL_NAME}'
          }
        `,
      )

      const result: LoadedAgents = await loadLocalAgents({
        agentsPath: agentsDir,
      })

      expect(result['skill-agent']).toBeUndefined()
      expect(result['real-agent']).toBeDefined()
    })

    test('loads valid agent definitions that use shorthand required fields', async () => {
      mkdirSync(agentsDir, { recursive: true })
      writeAgentFile(
        agentsDir,
        'shorthand-agent.ts',
        `
          const id = 'shorthand-agent'
          const model = '${MODEL_NAME}'

          export default {
            id,
            displayName: 'Shorthand Agent',
            model
          }
        `,
      )

      const result: LoadedAgents = await loadLocalAgents({
        agentsPath: agentsDir,
      })

      expect(result['shorthand-agent']).toBeDefined()
      expect(result['shorthand-agent']!.model).toBe(MODEL_NAME)
    })

    test('skips quarantined skill directories without importing executable scripts', async () => {
      const quarantineScriptsDir = path.join(
        agentsDir,
        'skills-quarantine',
        '2026-02-23',
        'youtube-data',
        'scripts',
      )
      mkdirSync(quarantineScriptsDir, { recursive: true })
      const markerFile = path.join(tempDir, 'quarantine-side-effect')
      writeAgentFile(
        quarantineScriptsDir,
        'tapi-auth.cjs',
        `
          const { writeFileSync } = require('fs')
          writeFileSync(${JSON.stringify(markerFile)}, 'imported')
          module.exports = {
            id: 'quarantined-agent',
            displayName: 'Quarantined Agent',
            model: '${MODEL_NAME}'
          }
        `,
      )
      writeAgentFile(
        agentsDir,
        'real-agent.ts',
        `
          export default {
            id: 'real-agent',
            displayName: 'Real Agent',
            model: '${MODEL_NAME}'
          }
        `,
      )

      const result: LoadedAgents = await loadLocalAgents({
        agentsPath: agentsDir,
      })

      expect(result['real-agent']).toBeDefined()
      expect(result['quarantined-agent']).toBeUndefined()
      expect(existsSync(markerFile)).toBe(false)
    })

    test('skips support directories without importing executable scripts', async () => {
      const scriptsDir = path.join(agentsDir, 'scripts')
      mkdirSync(scriptsDir, { recursive: true })
      const markerFile = path.join(tempDir, 'scripts-side-effect')
      writeAgentFile(
        scriptsDir,
        'exa-api.cjs',
        `
          const { writeFileSync } = require('fs')
          writeFileSync(${JSON.stringify(markerFile)}, 'imported')
        `,
      )
      writeAgentFile(
        agentsDir,
        'real-agent.ts',
        `
          export default {
            id: 'real-agent',
            displayName: 'Real Agent',
            model: '${MODEL_NAME}'
          }
        `,
      )

      const result: LoadedAgents = await loadLocalAgents({
        agentsPath: agentsDir,
      })

      expect(result['real-agent']).toBeDefined()
      expect(existsSync(markerFile)).toBe(false)
    })

    test('converts handleSteps function to string', async () => {
      mkdirSync(agentsDir, { recursive: true })
      writeAgentFile(
        agentsDir,
        'generator-agent.ts',
        `
          export default {
            id: 'generator-agent',
            displayName: 'Generator Agent',
            model: '${MODEL_NAME}',
            handleSteps: function* () {
              yield 'STEP'
              yield 'STEP_ALL'
            }
          }
        `,
      )

      const result: LoadedAgents = await loadLocalAgents({
        agentsPath: agentsDir,
      })
      const agent: LoadedAgentDefinition | undefined = result['generator-agent']

      expect(agent).toBeDefined()
      // handleSteps is converted to string by the loader (serialized from function)
      const handleStepsStr = agent!.handleSteps as unknown as string
      expect(typeof handleStepsStr).toBe('string')
      expect(handleStepsStr).toContain('STEP')
    })

    test('handles agent files that throw on import', async () => {
      mkdirSync(agentsDir, { recursive: true })
      writeAgentFile(
        agentsDir,
        'throwing.ts',
        `
          throw new Error('intentional error')
          export default {
            id: 'throwing-agent',
            displayName: 'Throwing Agent',
            model: '${MODEL_NAME}'
          }
        `,
      )
      writeAgentFile(
        agentsDir,
        'valid.ts',
        `
          export default {
            id: 'valid-agent',
            displayName: 'Valid Agent',
            model: '${MODEL_NAME}'
          }
        `,
      )

      const result: LoadedAgents = await loadLocalAgents({
        agentsPath: agentsDir,
      })

      // Should still load the valid agent
      expect(result['valid-agent']).toBeDefined()
      expect(result['throwing-agent']).toBeUndefined()
    })

    test('logs errors when verbose is true', async () => {
      mkdirSync(agentsDir, { recursive: true })
      writeAgentFile(
        agentsDir,
        'no-model.ts',
        `
          export default {
            id: 'no-model',
            displayName: 'No Model'
          }
        `,
      )

      // FID-016 Fix E: impl uses logger.error() from '../utils/logger', NOT
      // console.error(). Spy on the right target.
      const loggerErrorSpy = spyOn(logger, 'error').mockImplementation(() => {})

      await loadLocalAgents({ agentsPath: agentsDir, verbose: true })

      expect(loggerErrorSpy).toHaveBeenCalled()
      const errorMessage: string = loggerErrorSpy.mock.calls.flat().join(' ')
      expect(errorMessage).toContain('missing required attributes')
    })
  })
})
