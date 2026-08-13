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
  // Built by beforeEach; the edge-case tests construct their own params from
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

  describe('Edge cases and error handling', () => {
    it('should handle GENERATE_N with n=1', async () => {
      mockTemplate.handleSteps = function* () {
        yield { type: 'GENERATE_N', n: 1 }
      } as () => StepGenerator

      const result = await runProgrammaticStep({
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
      })

      expect(result.generateN).toBe(1)
      expect(result.endTurn).toBe(false)
    })

    it('should handle empty nResponses array', async () => {
      let receivedResponses: string[] | undefined

      mockTemplate.handleSteps = function* () {
        const step = yield { type: 'GENERATE_N', n: 3 }
        receivedResponses = step.nResponses
        yield { toolName: 'end_turn', input: {} }
      } as () => StepGenerator

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

      await runProgrammaticStep(mockParams)

      // Second call with empty array
      await runProgrammaticStep({
        ...mockParams,
        nResponses: [],
        stepNumber: 2,
      })

      expect(receivedResponses).toEqual([])
    })

    it('should handle undefined nResponses', async () => {
      let receivedResponses: string[] | undefined

      mockTemplate.handleSteps = function* () {
        const step = yield { type: 'GENERATE_N', n: 2 }
        receivedResponses = step.nResponses
        yield { toolName: 'end_turn', input: {} }
      } as () => StepGenerator

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

      await runProgrammaticStep(mockParams)

      // Second call without nResponses
      await runProgrammaticStep({
        ...mockParams,
        nResponses: undefined,
        stepNumber: 2,
      })

      expect(receivedResponses).toBeUndefined()
    })

    it('should handle GENERATE_N followed by error', async () => {
      mockTemplate.handleSteps = function* () {
        yield { type: 'GENERATE_N', n: 3 }
        throw new Error('Unexpected error after GENERATE_N')
      } as () => StepGenerator

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

      const result1 = await runProgrammaticStep(mockParams)
      expect(result1.generateN).toBe(3)

      // Second call should handle error
      const result2 = await runProgrammaticStep({
        ...mockParams,
        agentState: result1.agentState,
        nResponses: ['R1', 'R2', 'R3'],
        stepNumber: 2,
      })

      expect(result2.endTurn).toBe(true)
      expect(result2.agentState.output?.error).toContain(
        'Unexpected error after GENERATE_N',
      )
    })

    it('should handle GENERATE_N with STEP afterwards', async () => {
      let receivedResponses: string[] | undefined

      mockTemplate.handleSteps = function* () {
        const step1 = yield { type: 'GENERATE_N', n: 4 }
        receivedResponses = step1.nResponses

        // Yield STEP to pause execution
        yield 'STEP'

        // Continue after LLM runs
        yield {
          toolName: 'set_output',
          input: { processedResponses: receivedResponses?.length },
        }
        yield { toolName: 'end_turn', input: {} }
      } as () => StepGenerator

      mockTemplate.toolNames = ['set_output', 'end_turn']

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

      // First call yields GENERATE_N
      const result1 = await runProgrammaticStep(mockParams)
      expect(result1.generateN).toBe(4)

      // Second call receives nResponses and yields STEP
      const result2 = await runProgrammaticStep({
        ...mockParams,
        agentState: result1.agentState,
        nResponses: ['A', 'B', 'C', 'D'],
        stepNumber: 2,
      })

      expect(receivedResponses).toEqual(['A', 'B', 'C', 'D'])
      expect(result2.endTurn).toBe(false) // STEP should not end turn
    })

    it('should clear generateN when endTurn is true', async () => {
      mockTemplate.handleSteps = function* () {
        yield { type: 'GENERATE_N', n: 2 }
        // Generator ends immediately
      } as () => StepGenerator

      const result = await runProgrammaticStep({
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
      })

      // Should still set generateN even though endTurn will be true
      expect(result.generateN).toBe(2)
      expect(result.endTurn).toBe(false)
    })
  })
})
