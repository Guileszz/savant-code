import * as analytics from '@savant-code/common/analytics'
import { TEST_USER_ID } from '@savant-code/common/old-constants'
import {
  createTestAgentRuntimeParams,
  emptyMcpServers,
} from '@savant-code/common/testing/fixtures/agent-runtime'
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
import type { Logger } from '@savant-code/common/types/contracts/logger'
import type { ParamsOf } from '@savant-code/common/types/function-params'
import type { AgentState } from '@savant-code/common/types/session-state'

const logger: Logger = {
  debug: () => {},
  error: () => {},
  info: () => {},
  warn: () => {},
}

describe('n parameter and GENERATE_N functionality', () => {
  let mockTemplate: AgentTemplate
  let mockAgentState: AgentState
  let agentRuntimeImpl: any
  // Built by beforeEach; the Integration tests construct their own params from
  // agentRuntimeImpl and never read this one.
  let _runAgentStepBaseParams: any

  beforeEach(() => {
    agentRuntimeImpl = {
      ...createTestAgentRuntimeParams(),
      addAgentStep: async () => 'test-agent-step-id',

      sendAction: () => {},
    }

    // Mock analytics
    spyOn(analytics, 'trackEvent').mockImplementation(() => {})

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
      handleSteps: undefined,
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

    _runAgentStepBaseParams = {
      ...agentRuntimeImpl,
      additionalToolDefinitions: () => Promise.resolve({}),
      runId: 'test-run-id',
      ancestorRunIds: [],
      repoId: undefined,
      repoUrl: undefined,
      userId: TEST_USER_ID,
      userInputId: 'test-input',
      clientSessionId: 'test-session',
      fingerprintId: 'test-fingerprint',
      fileContext: mockFileContext,
      onResponseChunk: () => {},
      agentType: 'test-agent',
      localAgentTemplates: { 'test-agent': mockTemplate },
      agentState: mockAgentState,
      prompt: 'Test prompt',
      spawnParams: undefined,
      system: 'Test system',
      signal: new AbortController().signal,
      tools: {},
    }
  })

  afterEach(() => {
    mock.restore()
    clearAgentGeneratorCache({ logger })
  })

  describe('Integration: programmatic step -> n parameter -> nResponses', () => {
    it('should flow GENERATE_N through full pipeline', async () => {
      let receivedNResponses: string[] | undefined
      const expectedResponses = ['Impl A', 'Impl B', 'Impl C']

      mockTemplate.handleSteps = function* () {
        // Step 1: Request multiple generations
        const step1 = yield { type: 'GENERATE_N', n: 3 }
        receivedNResponses = step1.nResponses

        // Step 2: Use the responses
        yield {
          toolName: 'set_output',
          input: { selectedResponses: step1.nResponses },
        }
        yield { toolName: 'end_turn', input: {} }
      } as () => StepGenerator

      mockTemplate.toolNames = ['set_output', 'end_turn']

      // Mock executeToolCall to handle set_output
      const executeToolCallSpy = spyOn(
        toolExecutor,
        'executeToolCall',
      ).mockImplementation(
        async (
          options: ParamsOf<typeof toolExecutor.executeToolCall>,
        ): ReturnType<typeof toolExecutor.executeToolCall> => {
          if (options.toolName === 'set_output') {
            options.agentState.output = options.input
          }
        },
      )

      const mockParams: ParamsOf<typeof runProgrammaticStep> = {
        ...agentRuntimeImpl,
        runId: 'test-run-id',
        ancestorRunIds: [],
        repoId: undefined,
        repoUrl: undefined,
        agentState: mockAgentState,
        template: mockTemplate,
        prompt: 'Test prompt',
        toolCallParams: {},
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
        logger,
        signal: new AbortController().signal,
        tools: {},
      }

      // First call: programmatic step yields GENERATE_N
      const result1 = await runProgrammaticStep(mockParams)
      expect(result1.generateN).toBe(3)
      expect(result1.endTurn).toBe(false)

      // Second call: pass nResponses back to programmatic step
      const result2 = await runProgrammaticStep({
        ...mockParams,
        agentState: result1.agentState,
        nResponses: expectedResponses,
        stepNumber: 2,
      })

      expect(receivedNResponses).toEqual(expectedResponses)
      expect(result2.agentState.output).toEqual({
        selectedResponses: expectedResponses,
      })

      executeToolCallSpy.mockRestore()
    })

    it('should handle GENERATE_N with tool execution before and after', async () => {
      const executionLog: string[] = []

      mockTemplate.handleSteps = function* () {
        // Pre-processing
        executionLog.push('pre-processing')
        yield {
          toolName: 'read_files',
          input: { paths: ['context.txt'] },
        }

        // Generate multiple responses
        executionLog.push('generating responses')
        const step = yield { type: 'GENERATE_N', n: 5 }
        executionLog.push(`received ${step.nResponses?.length} responses`)

        // Post-processing
        yield {
          toolName: 'write_file',
          input: {
            path: 'results.txt',
            instructions: 'Write results',
            content: `Got ${step.nResponses?.length} responses`,
          },
        }
        yield { toolName: 'end_turn', input: {} }
      } as () => StepGenerator

      mockTemplate.toolNames = ['read_files', 'write_file', 'end_turn']

      // Mock executeToolCall for this test
      const executeToolCallSpy = spyOn(
        toolExecutor,
        'executeToolCall',
      ).mockImplementation(async () => {})

      const mockParams: ParamsOf<typeof runProgrammaticStep> = {
        ...agentRuntimeImpl,
        runId: 'test-run-id',
        ancestorRunIds: [],
        repoId: undefined,
        repoUrl: undefined,
        agentState: mockAgentState,
        template: mockTemplate,
        prompt: 'Test',
        toolCallParams: {},
        userId: TEST_USER_ID,
        userInputId: 'test-input',
        clientSessionId: 'test-session',
        fingerprintId: 'test-fingerprint',
        onResponseChunk: () => {},
        onCostCalculated: async () => {},
        fileContext: mockFileContext,
        localAgentTemplates: {},
        system: 'Test system prompt',
        stepsComplete: false,
        stepNumber: 1,
        logger,
        signal: new AbortController().signal,
        tools: {},
      }

      // First call: execute read_files and yield GENERATE_N
      const result1 = await runProgrammaticStep(mockParams)
      expect(result1.generateN).toBe(5)
      expect(executionLog).toEqual(['pre-processing', 'generating responses'])

      // Second call: receive nResponses and continue
      const mockResponses = ['R1', 'R2', 'R3', 'R4', 'R5']
      const result2 = await runProgrammaticStep({
        ...mockParams,
        agentState: result1.agentState,
        nResponses: mockResponses,
        stepNumber: 2,
      })

      expect(executionLog).toEqual([
        'pre-processing',
        'generating responses',
        'received 5 responses',
      ])
      expect(result2.endTurn).toBe(true)

      executeToolCallSpy.mockRestore()
    })

    it('should handle multiple GENERATE_N calls in sequence', async () => {
      const allResponses: string[][] = []

      mockTemplate.handleSteps = function* () {
        // First generation
        const step1 = yield { type: 'GENERATE_N', n: 2 }
        allResponses.push(step1.nResponses || [])

        // Process first batch
        yield {
          toolName: 'write_file',
          input: {
            path: 'batch1.txt',
            instructions: 'Write batch 1',
            content: 'Batch 1',
          },
        }

        // Second generation
        const step2 = yield { type: 'GENERATE_N', n: 3 }
        allResponses.push(step2.nResponses || [])

        // Final output
        yield {
          toolName: 'set_output',
          input: { totalBatches: allResponses.length },
        }
        yield { toolName: 'end_turn', input: {} }
      } as () => StepGenerator

      mockTemplate.toolNames = ['write_file', 'set_output', 'end_turn']

      // Mock executeToolCall for this test
      const executeToolCallSpy = spyOn(
        toolExecutor,
        'executeToolCall',
      ).mockImplementation(
        async (
          options: ParamsOf<typeof toolExecutor.executeToolCall>,
        ): ReturnType<typeof toolExecutor.executeToolCall> => {
          if (options.toolName === 'set_output') {
            options.agentState.output = options.input
          }
        },
      )

      const mockParams: ParamsOf<typeof runProgrammaticStep> = {
        ...agentRuntimeImpl,
        runId: 'test-run-id',
        ancestorRunIds: [],
        repoId: undefined,
        repoUrl: undefined,
        agentState: mockAgentState,
        template: mockTemplate,
        prompt: 'Test',
        toolCallParams: {},
        userId: TEST_USER_ID,
        userInputId: 'test-input',
        clientSessionId: 'test-session',
        fingerprintId: 'test-fingerprint',
        onResponseChunk: () => {},
        onCostCalculated: async () => {},
        fileContext: mockFileContext,
        localAgentTemplates: {},
        system: 'Test system prompt',
        stepsComplete: false,
        stepNumber: 1,
        logger,
        signal: new AbortController().signal,
        tools: {},
      }

      // First GENERATE_N
      const result1 = await runProgrammaticStep(mockParams)
      expect(result1.generateN).toBe(2)

      // Provide first batch of responses
      const result2 = await runProgrammaticStep({
        ...mockParams,
        agentState: result1.agentState,
        nResponses: ['A1', 'A2'],
        stepNumber: 2,
      })

      // Second GENERATE_N should be yielded
      expect(result2.generateN).toBe(3)

      // Provide second batch of responses
      const result3 = await runProgrammaticStep({
        ...mockParams,
        agentState: result2.agentState,
        nResponses: ['B1', 'B2', 'B3'],
        stepNumber: 3,
      })

      expect(allResponses).toEqual([
        ['A1', 'A2'],
        ['B1', 'B2', 'B3'],
      ])
      expect(result3.agentState.output).toEqual({ totalBatches: 2 })

      executeToolCallSpy.mockRestore()
    })
  })
})
