import { beforeEach, describe, expect, it } from 'bun:test'

import { validateAgents } from '../templates/agent-validation'
import { getStubProjectFileContext } from '../util/file'

import type { ProjectFileContext } from '../util/file'
import type { Logger } from '@savant-code/common/types/contracts/logger'

describe('Agent Validation', () => {
  let mockFileContext: ProjectFileContext
  const logger: Logger = {
    debug: () => {},
    error: () => {},
    info: () => {},
    warn: () => {},
  }

  beforeEach(() => {
    mockFileContext = getStubProjectFileContext()
  })

  describe('Schema Validation', () => {
    describe('Default Schema Behavior', () => {
      it('should have no prompt schema when no inputSchema provided', async () => {
        const fileContext: ProjectFileContext = {
          ...mockFileContext,
          agentTemplates: {
            'no-prompt-schema.ts': {
              id: 'no-prompt-schema-agent',
              version: '1.0.0',
              displayName: 'No Prompt Schema Agent',
              spawnerPrompt: 'Test agent without prompt schema',
              model: 'anthropic/claude-4-sonnet-20250522',
              systemPrompt: 'Test system prompt',
              instructionsPrompt: 'Test user prompt',
              stepPrompt: 'Test step prompt',
              outputMode: 'last_message',
              includeMessageHistory: true,
              inheritParentSystemPrompt: false,
              inheritParentModel: true,
              toolNames: ['end_turn'],
              spawnableAgents: [],
              // No inputSchema
            },
          },
        }

        const result = validateAgents({
          agentTemplates: fileContext.agentTemplates || {},
          logger,
        })

        expect(result.validationErrors).toHaveLength(0)
        expect(result.templates).toHaveProperty('no-prompt-schema-agent')
        expect(
          result.templates['no-prompt-schema-agent'].inputSchema.prompt,
        ).toBeUndefined()
      })

      it('should not have params schema when no paramsSchema provided', async () => {
        const fileContext: ProjectFileContext = {
          ...mockFileContext,
          agentTemplates: {
            'no-params-schema.ts': {
              id: 'no-params-schema-agent',
              version: '1.0.0',
              displayName: 'No Params Schema Agent',
              spawnerPrompt: 'Test agent without params schema',
              model: 'anthropic/claude-4-sonnet-20250522',
              systemPrompt: 'Test system prompt',
              instructionsPrompt: 'Test user prompt',
              stepPrompt: 'Test step prompt',
              outputMode: 'last_message',
              includeMessageHistory: true,
              inheritParentSystemPrompt: false,
              inheritParentModel: true,
              toolNames: ['end_turn'],
              spawnableAgents: [],
              // No paramsSchema
            },
          },
        }

        const result = validateAgents({
          agentTemplates: fileContext.agentTemplates || {},
          logger,
        })

        expect(result.validationErrors).toHaveLength(0)
        expect(result.templates).toHaveProperty('no-params-schema-agent')
        expect(
          result.templates['no-params-schema-agent'].inputSchema.params,
        ).toBeUndefined()
      })
    })

    describe('Complex Schema Scenarios', () => {
      it('should handle both inputSchema prompt and params together', async () => {
        const fileContext: ProjectFileContext = {
          ...mockFileContext,
          agentTemplates: {
            'both-schemas.ts': {
              id: 'both-schemas-agent',
              version: '1.0.0',
              displayName: 'Both Schemas Agent',
              spawnerPrompt: 'Test agent with both schemas',
              model: 'anthropic/claude-4-sonnet-20250522',
              systemPrompt: 'Test system prompt',
              instructionsPrompt: 'Test user prompt',
              stepPrompt: 'Test step prompt',
              inputSchema: {
                prompt: {
                  type: 'string',
                  minLength: 1,
                  description: 'A required prompt',
                },
                params: {
                  type: 'object',
                  properties: {
                    mode: {
                      type: 'string',
                      enum: ['fast', 'thorough'],
                    },
                    iterations: {
                      type: 'integer',
                      minimum: 1,
                      maximum: 10,
                      default: 3,
                    },
                  },
                  required: ['mode'],
                },
              },
              spawnableAgents: [],
              outputMode: 'last_message',
              includeMessageHistory: true,
              inheritParentSystemPrompt: false,
              inheritParentModel: true,
              toolNames: ['end_turn'],
            },
          },
        }

        const result = validateAgents({
          agentTemplates: fileContext.agentTemplates || {},
          logger,
        })

        expect(result.validationErrors).toHaveLength(0)
        expect(result.templates).toHaveProperty('both-schemas-agent')

        const template = result.templates['both-schemas-agent']
        expect(template.inputSchema.prompt).toBeDefined()
        expect(template.inputSchema.params).toBeDefined()

        const inputPromptSchema = template.inputSchema.prompt!
        const paramsSchema = template.inputSchema.params!

        // Test prompt schema
        expect(inputPromptSchema.safeParse('valid prompt').success).toBe(true)
        expect(inputPromptSchema.safeParse('').success).toBe(false) // Too short

        // Test params schema
        expect(
          paramsSchema.safeParse({ mode: 'fast', iterations: 5 }).success,
        ).toBe(true)
        expect(paramsSchema.safeParse({ mode: 'invalid' }).success).toBe(false) // Invalid enum
        expect(paramsSchema.safeParse({ iterations: 5 }).success).toBe(false) // Missing required field
      })

      it('should handle schema with nested objects and arrays', async () => {
        const fileContext: ProjectFileContext = {
          ...mockFileContext,
          agentTemplates: {
            'complex-schema.ts': {
              id: 'complex-schema-agent',
              version: '1.0.0',
              displayName: 'Complex Schema Agent',
              spawnerPrompt: 'Test agent with complex nested schema',
              model: 'anthropic/claude-4-sonnet-20250522',
              systemPrompt: 'Test system prompt',
              instructionsPrompt: 'Test user prompt',
              stepPrompt: 'Test step prompt',
              inputSchema: {
                params: {
                  type: 'object',
                  properties: {
                    config: {
                      type: 'object',
                      properties: {
                        name: { type: 'string' },
                        settings: {
                          type: 'array',
                          items: {
                            type: 'object',
                            properties: {
                              key: { type: 'string' },
                              value: { type: 'string' },
                            },
                            required: ['key', 'value'],
                          },
                        },
                      },
                      required: ['name'],
                    },
                  },
                  required: ['config'],
                },
              },
              outputMode: 'last_message',
              includeMessageHistory: true,
              inheritParentSystemPrompt: false,
              inheritParentModel: true,
              toolNames: ['end_turn'],
              spawnableAgents: [],
            },
          },
        }

        const result = validateAgents({
          agentTemplates: fileContext.agentTemplates || {},
          logger,
        })

        expect(result.validationErrors).toHaveLength(0)
        expect(result.templates).toHaveProperty('complex-schema-agent')

        const paramsSchema =
          result.templates['complex-schema-agent'].inputSchema.params!

        // Test valid complex object
        const validParams = {
          config: {
            name: 'test config',
            settings: [
              { key: 'setting1', value: 'value1' },
              { key: 'setting2', value: 'value2' },
            ],
          },
        }
        expect(paramsSchema.safeParse(validParams).success).toBe(true)

        // Test invalid nested structure
        const invalidParams = {
          config: {
            name: 'test config',
            settings: [
              { key: 'setting1' }, // Missing required 'value' field
            ],
          },
        }
        expect(paramsSchema.safeParse(invalidParams).success).toBe(false)
      })
    })

    describe('Error Message Quality', () => {
      it('should include file path in error messages', async () => {
        const fileContext: ProjectFileContext = {
          ...mockFileContext,
          agentTemplates: {
            'error-context.ts': {
              id: 'error-context-agent',
              version: '1.0.0',
              displayName: 'Error Context Agent',
              spawnerPrompt: 'Test agent for error context',
              model: 'anthropic/claude-4-sonnet-20250522',
              systemPrompt: 'Test system prompt',
              instructionsPrompt: 'Test user prompt',
              stepPrompt: 'Test step prompt',
              inputSchema: {
                prompt: {} as { type: 'string' }, // Invalid - missing type at runtime
              },
              outputMode: 'last_message',
              includeMessageHistory: true,
              inheritParentSystemPrompt: false,
              inheritParentModel: true,
              toolNames: ['end_turn'],
              spawnableAgents: [],
            },
          },
        }

        const result = validateAgents({
          agentTemplates: fileContext.agentTemplates || {},
          logger,
        })

        expect(result.validationErrors).toHaveLength(1)
        expect(result.validationErrors[0].message).toContain(
          'Schema validation failed',
        )
        expect(result.validationErrors[0].filePath).toBe('error-context.ts')
      })
    })

    describe('Edge Cases', () => {
      it('should handle git-committer agent schema correctly', async () => {
        const fileContext: ProjectFileContext = {
          ...mockFileContext,
          agentTemplates: {
            'git-committer.ts': {
              id: 'savant-code-git-committer',
              version: '0.0.1',
              displayName: 'Git Committer',
              spawnerPrompt:
                'A git committer agent specialized to commit current changes with an appropriate commit message.',
              model: 'google/gemini-2.5-pro',
              systemPrompt: 'Test system prompt',
              instructionsPrompt: 'Test user prompt',
              stepPrompt: 'Test step prompt',
              inputSchema: {
                prompt: {
                  type: 'string',
                  description: 'What changes to commit',
                },
                params: {
                  type: 'object',
                  properties: {
                    message: {
                      type: 'string',
                    },
                  },
                  required: ['message'],
                },
              },
              outputMode: 'last_message',
              includeMessageHistory: true,
              inheritParentSystemPrompt: false,
              inheritParentModel: true,
              toolNames: ['end_turn'],
              spawnableAgents: [],
            },
          },
        }

        const result = validateAgents({
          agentTemplates: fileContext.agentTemplates || {},
          logger,
        })

        expect(result.validationErrors).toHaveLength(0)
        expect(result.templates).toHaveProperty('savant-code-git-committer')

        const template = result.templates['savant-code-git-committer']
        const paramsSchema = template.inputSchema.params!

        expect(paramsSchema.safeParse('').success).toBe(false) // Too short
        expect(template.inputSchema.params).toBeDefined()
        // Test that the params schema properly validates the message property
        // This should succeed with a message property
        const validResult = paramsSchema.safeParse({
          message: 'test commit message',
        })
        expect(validResult.success).toBe(true)

        // This should fail without the required message property
        const invalidResult = paramsSchema.safeParse({})
        expect(invalidResult.success).toBe(false)
      })

      it('should handle empty inputSchema object', async () => {
        const fileContext: ProjectFileContext = {
          ...mockFileContext,
          agentTemplates: {
            'empty-schema.ts': {
              id: 'empty-schema-agent',
              version: '1.0.0',
              displayName: 'Empty Schema Agent',
              model: 'anthropic/claude-4-sonnet-20250522',
              systemPrompt: 'Test system prompt',
              instructionsPrompt: 'Test user prompt',
              stepPrompt: 'Test step prompt',
              spawnerPrompt: 'Test agent with empty schema',
              inputSchema: {},
              outputMode: 'last_message',
              includeMessageHistory: true,
              inheritParentSystemPrompt: false,
              inheritParentModel: true,
              toolNames: ['end_turn'],
              spawnableAgents: [],
            },
          },
        }

        const result = validateAgents({
          agentTemplates: fileContext.agentTemplates || {},
          logger,
        })

        expect(result.validationErrors).toHaveLength(0)
        expect(result.templates).toHaveProperty('empty-schema-agent')

        // Empty schemas should have no prompt schema
        expect(
          result.templates['empty-schema-agent'].inputSchema.prompt,
        ).toBeUndefined()
      })
    })
  })
})
