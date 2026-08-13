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
import type { executeToolCall } from '../tools/tool-executor'
import type { PublicAgentState } from '@savant-code/common/types/agent-template'
import type {
  AgentRuntimeDeps,
  AgentRuntimeScopedDeps,
} from '@savant-code/common/types/contracts/agent-runtime'
import type { Logger } from '@savant-code/common/types/contracts/logger'
import type { ParamsOf } from '@savant-code/common/types/function-params'
import type { ToolResultOutput } from '@savant-code/common/types/messages/content-part'
import type { ToolMessage } from '@savant-code/common/types/messages/savant-code-message'
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

  describe('tool execution', () => {
    it('should comprehensively test STEP_ALL functionality with multiple tools and state management', async () => {
      // Track all tool results and state changes for verification
      const toolResultsReceived: ToolResultOutput[][] = []
      const stateSnapshots: PublicAgentState[] = []
      let stepCount = 0

      const mockGenerator = (function* () {
        stepCount++

        // Step 1: Read files and capture initial state
        const step1 = yield {
          toolName: 'read_files',
          input: { paths: ['src/auth.ts', 'src/config.ts'] },
        }
        toolResultsReceived.push(step1.toolResult)
        stateSnapshots.push({ ...step1.agentState })

        // Step 2: Search for patterns based on file content
        const step2 = yield {
          toolName: 'code_search',
          input: { pattern: 'authenticate', flags: '-i' },
        }
        toolResultsReceived.push(step2.toolResult)
        stateSnapshots.push({ ...step2.agentState })

        // Step 3: Create a plan based on findings
        const step3 = yield {
          toolName: 'create_plan',
          input: {
            path: 'analysis-plan.md',
            plan: 'Comprehensive analysis of authentication system',
          },
        }
        toolResultsReceived.push(step3.toolResult)
        stateSnapshots.push({ ...step3.agentState })

        // Step 4: Add subgoal for tracking
        const step4 = yield {
          toolName: 'add_subgoal',
          input: {
            id: 'auth-analysis',
            objective: 'Analyze authentication patterns',
            status: 'IN_PROGRESS',
            plan: 'Review auth files and create recommendations',
          },
        }
        toolResultsReceived.push(step4.toolResult)
        stateSnapshots.push({ ...step4.agentState })

        // Step 5: Write analysis file
        const step5 = yield {
          toolName: 'write_file',
          input: {
            path: 'auth-analysis.md',
            instructions: 'Create authentication analysis document',
            content: '# Authentication Analysis\n\nBased on code review...',
          },
        }
        toolResultsReceived.push(step5.toolResult)
        stateSnapshots.push({ ...step5.agentState })

        // Step 6: Update subgoal status
        const step6 = yield {
          toolName: 'update_subgoal',
          input: {
            id: 'auth-analysis',
            status: 'COMPLETE',
            log: 'Analysis completed successfully',
          },
        }
        toolResultsReceived.push(step6.toolResult)
        stateSnapshots.push({ ...step6.agentState })

        // Step 7: Set final output with comprehensive data
        const step7 = yield {
          toolName: 'set_output',
          input: {
            status: 'success',
            filesAnalyzed: ['src/auth.ts', 'src/config.ts'],
            patternsFound: 3,
            recommendations: ['Use stronger auth', 'Add 2FA'],
            completedAt: new Date().toISOString(),
          },
        }
        toolResultsReceived.push(step7.toolResult)
        stateSnapshots.push({ ...step7.agentState })

        // Step 8: Transition to STEP_ALL to continue processing
        yield 'STEP_ALL'
      })() as StepGenerator

      // Set up comprehensive tool names for this test
      mockTemplate.handleSteps = () => mockGenerator
      mockTemplate.toolNames = [
        'read_files',
        'code_search',
        'create_plan',
        'add_subgoal',
        'write_file',
        'update_subgoal',
        'set_output',
        'end_turn',
      ]

      // Mock executeToolCall to simulate realistic tool results and state updates
      executeToolCallSpy.mockImplementation(
        async (
          options: ParamsOf<typeof executeToolCall>,
        ): ReturnType<typeof executeToolCall> => {
          const { toolName, input, toolResults, agentState } = options

          let result: string
          switch (toolName) {
            case 'read_files':
              result = JSON.stringify({
                'src/auth.ts':
                  'export function authenticate(user) { return true; }',
                'src/config.ts': 'export const authConfig = { enabled: true };',
              })
              break
            case 'code_search':
              result =
                'src/auth.ts:1:export function authenticate(user) {\nsrc/config.ts:1:authConfig'
              break
            case 'create_plan':
              result = 'Plan created successfully at analysis-plan.md'
              break
            case 'add_subgoal':
              result = 'Subgoal "auth-analysis" added successfully'
              // Update agent state to include subgoal in agentContext
              agentState.agentContext['auth-analysis'] = {
                objective: 'Analyze authentication patterns',
                status: 'IN_PROGRESS',
                plan: 'Review auth files and create recommendations',
                logs: [],
              }
              break
            case 'write_file':
              result = 'File written successfully: auth-analysis.md'
              break
            case 'update_subgoal':
              result = 'Subgoal "auth-analysis" updated successfully'
              // Update subgoal status in agent state
              if (agentState.agentContext['auth-analysis']) {
                agentState.agentContext['auth-analysis'].status = 'COMPLETE'
                agentState.agentContext['auth-analysis'].logs.push(
                  'Analysis completed successfully',
                )
              }
              break
            case 'set_output':
              result = 'Output set successfully'
              agentState.output = input
              break
            default:
              result = `${toolName} executed successfully`
          }

          const toolResult: ToolMessage = {
            role: 'tool',
            toolName,
            toolCallId: `${toolName}-call-id`,
            content: [
              {
                type: 'json',
                value: result,
              },
            ],
          }
          toolResults.push(toolResult)

          agentState.messageHistory.push(toolResult)
        },
      )

      // First call - should execute all tools and transition to STEP_ALL
      const result1 = await runProgrammaticStep(mockParams)

      // Verify all tools were executed
      expect(executeToolCallSpy).toHaveBeenCalledTimes(7) // 7 tools before STEP_ALL
      expect(result1.endTurn).toBe(false) // Should not end turn due to STEP_ALL
      expect(stepCount).toBe(1) // Generator should have run once

      // Verify tool execution order and arguments
      const toolCalls = executeToolCallSpy.mock.calls
      expect(toolCalls[0][0].toolName).toBe('read_files')
      expect(toolCalls[0][0].input.paths).toEqual([
        'src/auth.ts',
        'src/config.ts',
      ])
      expect(toolCalls[1][0].toolName).toBe('code_search')
      expect(toolCalls[1][0].input.pattern).toBe('authenticate')
      expect(toolCalls[2][0].toolName).toBe('create_plan')
      expect(toolCalls[3][0].toolName).toBe('add_subgoal')
      expect(toolCalls[4][0].toolName).toBe('write_file')
      expect(toolCalls[5][0].toolName).toBe('update_subgoal')
      expect(toolCalls[6][0].toolName).toBe('set_output')

      // Verify tool results were passed back to generator
      expect(toolResultsReceived).toHaveLength(7)
      expect(JSON.stringify(toolResultsReceived[0])).toContain('authenticate')
      expect(JSON.stringify(toolResultsReceived[3])).toContain('auth-analysis')
      expect(JSON.stringify(toolResultsReceived[6])).toContain(
        'Output set successfully',
      )

      // Verify state management throughout execution
      expect(stateSnapshots).toHaveLength(7)
      expect(Object.keys(result1.agentState.agentContext)).toContain(
        'auth-analysis',
      )
      expect(result1.agentState.agentContext['auth-analysis']?.status).toBe(
        'COMPLETE',
      )
      expect(result1.agentState.output).toEqual({
        status: 'success',
        filesAnalyzed: ['src/auth.ts', 'src/config.ts'],
        patternsFound: 3,
        recommendations: ['Use stronger auth', 'Add 2FA'],
        completedAt: expect.any(String),
      })

      // Verify tool results were processed correctly
      expect(toolResultsReceived).toHaveLength(7)
      expect(toolResultsReceived.every((result) => result !== undefined)).toBe(
        true,
      )

      // Verify that executeToolCall was called with agentState.messageHistory
      expect(executeToolCallSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          agentState: expect.objectContaining({
            messageHistory: expect.any(Array),
          }),
        }),
      )

      // Reset spy for second call
      executeToolCallSpy.mockClear()

      // Second call - should return early due to STEP_ALL state
      const result2 = await runProgrammaticStep({
        ...mockParams,
        // Use the updated agent state from first call
        agentState: result1.agentState,
      })

      // Verify STEP_ALL behavior
      expect(executeToolCallSpy).not.toHaveBeenCalled() // No tools should execute
      expect(result2.endTurn).toBe(false) // Should still not end turn
      expect(result2.agentState.agentId).toEqual(result1.agentState.agentId) // State should be similar
      expect(stepCount).toBe(1) // Generator should not have run again

      // Third call - verify STEP_ALL state persists
      const result3 = await runProgrammaticStep({
        ...mockParams,
        agentState: result2.agentState,
      })

      expect(executeToolCallSpy).not.toHaveBeenCalled()
      expect(result3.endTurn).toBe(false)
      expect(result3.agentState.agentId).toEqual(result1.agentState.agentId)
      expect(stepCount).toBe(1) // Generator should still not have run again
    })

    it('should pass tool results back to generator', async () => {
      const _toolResults: ToolMessage[] = []
      let receivedToolResult: ToolResultOutput[] | undefined

      const mockGenerator = (function* () {
        const input1 = yield {
          toolName: 'read_files',
          input: { paths: ['test.txt'] },
        }
        receivedToolResult = input1.toolResult
        yield { toolName: 'end_turn', input: {} }
      })() as StepGenerator

      mockTemplate.handleSteps = () => mockGenerator

      // Mock executeToolCall to add tool results
      executeToolCallSpy.mockImplementation(
        async (
          options: ParamsOf<typeof executeToolCall>,
        ): ReturnType<typeof executeToolCall> => {
          if (options.toolName === 'read_files') {
            options.toolResults.push({
              role: 'tool',
              toolName: 'read_files',
              toolCallId: 'test-id',
              content: [
                {
                  type: 'json',
                  value: 'file content',
                },
              ],
            } satisfies ToolMessage)
          }
        },
      )

      await runProgrammaticStep(mockParams)

      expect(receivedToolResult).toEqual([
        {
          type: 'json',
          value: 'file content',
        },
      ])
    })
  })
})
