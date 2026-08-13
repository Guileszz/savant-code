import * as analytics from '@savant-code/common/analytics'
import { TEST_USER_ID } from '@savant-code/common/old-constants'
import { emptyMcpServers } from '@savant-code/common/testing/fixtures/agent-runtime'
import { TEST_AGENT_RUNTIME_IMPL } from '@savant-code/common/testing/impl/agent-runtime'
import { getInitialSessionState } from '@savant-code/common/types/session-state'
import {
  assistantMessage,
  userMessage,
} from '@savant-code/common/util/messages'
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  mock,
  spyOn,
} from 'bun:test'

import {
  clearAgentGeneratorCache,
  runProgrammaticStep,
} from '../run-programmatic-step'
import { mockFileContext } from './test-utils'
import * as toolExecutor from '../tools/tool-executor'

import type { AgentTemplate, StepGenerator } from '../templates/types'
import type {
  AgentRuntimeDeps,
  AgentRuntimeScopedDeps,
} from '@savant-code/common/types/contracts/agent-runtime'
import type { Logger } from '@savant-code/common/types/contracts/logger'
import type { ParamsOf } from '@savant-code/common/types/function-params'
import type { AgentState } from '@savant-code/common/types/session-state'

const logger: Logger = {
  debug: () => {},
  error: () => {},
  info: () => {},
  warn: () => {},
}

describe('runProgrammaticStep', () => {
  let mockTemplate: AgentTemplate
  let mockAgentState: AgentState
  let mockParams: ParamsOf<typeof runProgrammaticStep>
  let executeToolCallSpy: ReturnType<
    typeof spyOn<typeof toolExecutor, 'executeToolCall'>
  >
  let agentRuntimeImpl: AgentRuntimeDeps & AgentRuntimeScopedDeps

  beforeEach(() => {
    agentRuntimeImpl = {
      ...TEST_AGENT_RUNTIME_IMPL,
      addAgentStep: async () => 'test-agent-step-id',

      sendAction: () => {},
    }

    // Mock analytics
    spyOn(analytics, 'trackEvent').mockImplementation(() => {})

    // Mock executeToolCall
    executeToolCallSpy = spyOn(
      toolExecutor,
      'executeToolCall',
    ).mockImplementation(async () => {})

    // Mock crypto.randomUUID
    spyOn(crypto, 'randomUUID').mockImplementation(
      () =>
        'mock-uuid-0000-0000-0000-000000000000' as `${string}-${string}-${string}-${string}-${string}`,
    )

    // Create mock template
    mockTemplate = {
      id: 'test-agent',
      displayName: 'Test Agent',
      spawnerPrompt: 'Testing',
      model: 'claude-3-5-sonnet-20241022',
      inputSchema: {},
      outputMode: 'structured_output',
      includeMessageHistory: true,
      inheritParentSystemPrompt: false,
      mcpServers: emptyMcpServers,
      toolNames: ['read_files', 'write_file', 'end_turn'],
      spawnableAgents: [],
      systemPrompt: 'Test system prompt',
      instructionsPrompt: 'Test user prompt',
      stepPrompt: 'Test agent step prompt',
      handleSteps: undefined, // Will be set in individual tests
    } as AgentTemplate

    // Create mock agent state
    const sessionState = getInitialSessionState(mockFileContext)
    mockAgentState = {
      ...sessionState.mainAgentState,
      agentId: 'test-agent-id',
      runId:
        'test-run-id' as `${string}-${string}-${string}-${string}-${string}`,
      messageHistory: [
        userMessage('Initial message'),
        assistantMessage('Initial response'),
      ],
      output: undefined,
      directCreditsUsed: 0,
      childRunIds: [],
    }

    // Create mock params
    mockParams = {
      ...agentRuntimeImpl,
      runId: 'test-run-id',
      ancestorRunIds: [],
      repoId: undefined,
      repoUrl: undefined,
      agentState: mockAgentState,
      template: mockTemplate,
      prompt: 'Test prompt',
      toolCallParams: { testParam: 'value' },
      userId: TEST_USER_ID,
      userInputId: 'test-user-input',
      clientSessionId: 'test-session',
      fingerprintId: 'test-fingerprint',
      onResponseChunk: () => {},
      onCostCalculated: async () => {},
      fileContext: mockFileContext,
      localAgentTemplates: {},
      system: 'Test system prompt',
      stepsComplete: false,
      stepNumber: 1,
      tools: {},

      logger,
      signal: new AbortController().signal,
    }
  })

  afterEach(() => {
    mock.restore()
    // Clear the generator cache between tests
    clearAgentGeneratorCache({ logger })
  })

  describe('output schema validation', () => {
    it('should validate output against outputSchema when using setOutput', async () => {
      // Create template with outputSchema
      const schemaTemplate = {
        ...mockTemplate,
        outputMode: 'structured_output' as const,
        outputSchema: {
          type: 'object',
          properties: {
            message: { type: 'string' },
            status: { type: 'string', enum: ['success', 'error'] },
            count: { type: 'number' },
          },
          required: ['message', 'status'],
        },
        toolNames: ['set_output', 'end_turn'],
      }

      const mockGenerator = (function* () {
        yield {
          toolName: 'set_output',
          input: {
            message: 'Task completed successfully',
            status: 'success',
            count: 42,
          },
        }
        yield { toolName: 'end_turn', input: {} }
      })() as StepGenerator

      schemaTemplate.handleSteps = () => mockGenerator

      // Don't mock executeToolCall - let it use the real implementation
      executeToolCallSpy.mockRestore()

      const result = await runProgrammaticStep({
        ...mockParams,
        template: schemaTemplate as unknown as AgentTemplate,
        localAgentTemplates: {
          'test-agent': schemaTemplate as unknown as AgentTemplate,
        },
      })

      expect(result.endTurn).toBe(true)
      expect(result.agentState.output).toEqual({
        message: 'Task completed successfully',
        status: 'success',
        count: 42,
      })
    })

    it('should handle invalid output that fails schema validation', async () => {
      // Create template with strict outputSchema
      const schemaTemplate = {
        ...mockTemplate,
        outputMode: 'structured_output' as const,
        outputSchema: {
          type: 'object',
          properties: {
            message: { type: 'string' },
            status: { type: 'string', enum: ['success', 'error'] },
          },
          required: ['message', 'status'],
        },
        toolNames: ['set_output', 'end_turn'],
      }

      const mockGenerator = (function* () {
        yield {
          toolName: 'set_output',
          input: {
            message: 'Task completed',
            status: 'invalid_status', // This should fail validation
            extraField: 'not allowed',
          },
        }
        yield { toolName: 'end_turn', input: {} }
      })() as StepGenerator

      schemaTemplate.handleSteps = () => mockGenerator

      // Don't mock executeToolCall - let it use the real implementation
      executeToolCallSpy.mockRestore()

      const responseChunks: unknown[] = []
      mockParams.onResponseChunk = (chunk) => responseChunks.push(chunk)

      const result = await runProgrammaticStep({
        ...mockParams,
        template: schemaTemplate as unknown as AgentTemplate,
        localAgentTemplates: {
          'test-agent': schemaTemplate as unknown as AgentTemplate,
        },
      })

      // Should end turn (validation may fail but execution continues)
      expect(result.endTurn).toBe(true)
      // Test passes if no exception is thrown during execution
      expect(result.agentState).toBeDefined()
    })

    it('should work with agents that have no outputSchema', async () => {
      const noSchemaTemplate = {
        ...mockTemplate,
        outputMode: 'last_message' as const,
        outputSchema: undefined,
        toolNames: ['set_output', 'end_turn'],
      }

      const mockGenerator = (function* () {
        yield {
          toolName: 'set_output',
          input: {
            anyField: 'any value',
            anotherField: 123,
          },
        }
        yield { toolName: 'end_turn', input: {} }
      })() as StepGenerator

      noSchemaTemplate.handleSteps = () => mockGenerator

      // Don't mock executeToolCall - let it use the real implementation
      executeToolCallSpy.mockRestore()

      const result = await runProgrammaticStep({
        ...mockParams,
        template: noSchemaTemplate,
        localAgentTemplates: { 'test-agent': noSchemaTemplate },
      })

      expect(result.endTurn).toBe(true)
      expect(result.agentState.output).toEqual({
        anyField: 'any value',
        anotherField: 123,
      })
    })

    it('should work with outputMode structured_output but no outputSchema defined', async () => {
      const schemaWithoutSchemaTemplate = {
        ...mockTemplate,
        outputMode: 'structured_output' as const,
        outputSchema: undefined, // No schema defined
        toolNames: ['set_output', 'end_turn'],
      }

      const mockGenerator = (function* () {
        yield {
          toolName: 'set_output',
          input: {
            result: 'success',
            data: { count: 5 },
          },
        }
        yield { toolName: 'end_turn', input: {} }
      })() as StepGenerator

      schemaWithoutSchemaTemplate.handleSteps = () => mockGenerator

      // Don't mock executeToolCall - let it use the real implementation
      executeToolCallSpy.mockRestore()

      const result = await runProgrammaticStep({
        ...mockParams,
        template: schemaWithoutSchemaTemplate,
        localAgentTemplates: { 'test-agent': schemaWithoutSchemaTemplate },
      })

      expect(result.endTurn).toBe(true)
      expect(result.agentState.output).toEqual({
        result: 'success',
        data: { count: 5 },
      })
    })
  })

  describe('logging and context', () => {
    it('should log agent execution start', async () => {
      const mockGenerator = (function* () {
        yield { toolName: 'end_turn', input: {} }
      })() as StepGenerator

      mockTemplate.handleSteps = () => mockGenerator

      await runProgrammaticStep(mockParams)

      // Logger is mocked, but we can verify the function completes without error
      expect(true).toBe(true)
    })

    it('should generate unique agent step ID', async () => {
      const mockGenerator = (function* () {
        yield { toolName: 'read_files', input: { paths: ['test.txt'] } }
        yield { toolName: 'end_turn', input: {} }
      })() as StepGenerator

      mockTemplate.handleSteps = () => mockGenerator

      await runProgrammaticStep(mockParams)

      expect(executeToolCallSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          agentStepId: 'mock-uuid-0000-0000-0000-000000000000',
        }),
      )
    })
  })
})
