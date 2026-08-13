import { emptyMcpServers } from '@savant-code/common/testing/fixtures/agent-runtime'
import { TEST_AGENT_RUNTIME_IMPL } from '@savant-code/common/testing/impl/agent-runtime'
import { getInitialSessionState } from '@savant-code/common/types/session-state'
import { promptSuccess } from '@savant-code/common/util/error'
import { jsonToolResult } from '@savant-code/common/util/messages'
import { beforeEach, describe, expect, it } from 'bun:test'

import { mockFileContext } from './test-utils'
import { processStream } from '../tools/stream-parser'

import type { AgentTemplate } from '../templates/types'
import type {
  AgentRuntimeDeps,
  AgentRuntimeScopedDeps,
} from '@savant-code/common/types/contracts/agent-runtime'
import type { StreamChunk } from '@savant-code/common/types/contracts/llm'
import type {
  AssistantMessage,
  ToolMessage,
} from '@savant-code/common/types/messages/savant-code-message'
import type { PrintModeEvent } from '@savant-code/common/types/print-mode'

describe('tool validation error handling', () => {
  let agentRuntimeImpl: AgentRuntimeDeps & AgentRuntimeScopedDeps

  beforeEach(() => {
    agentRuntimeImpl = { ...TEST_AGENT_RUNTIME_IMPL, sendAction: () => {} }
  })

  const testAgentTemplate: AgentTemplate = {
    id: 'test-agent',
    displayName: 'Test Agent',
    spawnerPrompt: 'Test agent',
    model: 'claude-3-5-sonnet-20241022',
    inputSchema: {},
    outputMode: 'structured_output',
    includeMessageHistory: true,
    inheritParentSystemPrompt: false,
    mcpServers: emptyMcpServers,
    toolNames: ['spawn_agents', 'end_turn'],
    spawnableAgents: [],
    systemPrompt: 'Test system prompt',
    instructionsPrompt: 'Test instructions',
    stepPrompt: 'Test step prompt',
  }

  it('should preserve tool_call/tool_result ordering when custom tool setup is async', async () => {
    const toolName = 'delayed_custom_tool'
    const agentWithCustomTool: AgentTemplate = {
      ...testAgentTemplate,
      toolNames: [toolName, 'end_turn'],
    }

    const delayedToolCallChunk: StreamChunk = {
      type: 'tool-call',
      toolName,
      toolCallId: 'delayed-custom-tool-call-id',
      input: {
        query: 'test',
      },
    }

    async function* mockStream() {
      yield delayedToolCallChunk
      return promptSuccess('mock-message-id')
    }

    const fileContextWithCustomTool = {
      ...mockFileContext,
      permissionMode: 'unsafe' as const,
      customToolDefinitions: {
        [toolName]: {
          inputSchema: {
            type: 'object',
            properties: {
              query: { type: 'string' },
            },
            required: ['query'],
            additionalProperties: false,
          },
          endsAgentStep: false,
          description: 'A delayed custom tool for ordering tests',
          effect: 'network' as const,
          permission: 'allow' as const,
        },
      },
    }

    const sessionState = getInitialSessionState(fileContextWithCustomTool)
    const agentState = sessionState.mainAgentState
    agentState.fsmPhase = 'green'

    agentRuntimeImpl.requestMcpToolData = async () => {
      // Force an async gap so tool_call emission happens after stream completion.
      await new Promise((resolve) => setTimeout(resolve, 20))
      return []
    }
    agentRuntimeImpl.requestToolCall = async () => ({
      output: jsonToolResult({ ok: true }),
    })

    await processStream({
      ...agentRuntimeImpl,
      agentContext: {},
      agentState,
      agentStepId: 'test-step-id',
      agentTemplate: agentWithCustomTool,
      ancestorRunIds: [],
      clientSessionId: 'test-session',
      fileContext: fileContextWithCustomTool,
      fingerprintId: 'test-fingerprint',
      fullResponse: '',
      localAgentTemplates: { 'test-agent': agentWithCustomTool },
      messages: [],
      prompt: 'test prompt',
      repoId: undefined,
      repoUrl: undefined,
      runId: 'test-run-id',
      signal: new AbortController().signal,
      stream: mockStream(),
      system: 'test system',
      tools: {},
      userId: 'test-user',
      userInputId: 'test-input-id',
      onCostCalculated: async () => {},
      onResponseChunk: () => {},
    })

    const assistantToolCallMessages = agentState.messageHistory.filter(
      (m): m is AssistantMessage =>
        m.role === 'assistant' &&
        m.content.some(
          (c) => c.type === 'tool-call' && c.toolName === toolName,
        ),
    )
    const toolMessages = agentState.messageHistory.filter(
      (m): m is ToolMessage => m.role === 'tool' && m.toolName === toolName,
    )

    expect(assistantToolCallMessages.length).toBe(1)
    expect(toolMessages.length).toBe(1)

    const assistantToolCallPart = assistantToolCallMessages[0].content.find(
      (
        c,
      ): c is Extract<
        AssistantMessage['content'][number],
        { type: 'tool-call' }
      > => c.type === 'tool-call' && c.toolName === toolName,
    )
    expect(assistantToolCallPart).toBeDefined()
    expect(toolMessages[0].toolCallId).toBe(assistantToolCallPart!.toolCallId)

    const assistantIndex = agentState.messageHistory.indexOf(
      assistantToolCallMessages[0],
    )
    const toolResultIndex = agentState.messageHistory.indexOf(toolMessages[0])
    expect(assistantIndex).toBeGreaterThanOrEqual(0)
    expect(toolResultIndex).toBeGreaterThan(assistantIndex)

    const assistantToolCallIds = new Set(
      agentState.messageHistory.flatMap((message) => {
        if (message.role !== 'assistant') {
          return []
        }
        return message.content.flatMap((part) =>
          part.type === 'tool-call' ? [part.toolCallId] : [],
        )
      }),
    )
    const orphanToolResults = agentState.messageHistory.filter(
      (message): message is ToolMessage =>
        message.role === 'tool' &&
        !assistantToolCallIds.has(message.toolCallId),
    )
    expect(orphanToolResults.length).toBe(0)
  })

  it('C1: should not crash on malformed write-tool input (null / bare string)', async () => {
    // FID-2026-0802-005 C1 regression: the write gate used to dereference
    // raw (unvalidated) toolCall.input BEFORE the parse-error check — null
    // threw `TypeError: Cannot read properties of null`, a bare string threw
    // a strict-mode `Cannot create property 'path' on string`. Both must now
    // surface as a graceful tool error instead of failing the run.
    const agentWithWriteTool: AgentTemplate = {
      ...testAgentTemplate,
      toolNames: ['write_file', 'end_turn'],
    }

    const malformedInputs: Array<{ input: unknown; expectInMessage: string }> =
      [
        {
          input: null,
          expectInMessage: 'Invalid parameters for write_file',
        },
        {
          input: 'just a bare string',
          expectInMessage:
            'expected the tool arguments to be an object, but received a string',
        },
      ]

    for (const { input, expectInMessage } of malformedInputs) {
      const toolCallChunk = {
        type: 'tool-call' as const,
        toolName: 'write_file',
        toolCallId: `malformed-write-${Math.random()}`,
        input: input as any,
      }

      async function* mockStream() {
        yield toolCallChunk
        return promptSuccess('mock-message-id')
      }

      const sessionState = getInitialSessionState(mockFileContext)
      const agentState = sessionState.mainAgentState
      agentState.fsmPhase = 'green'
      agentState.fsmPhase = 'green'
      const responseChunks: (string | PrintModeEvent)[] = []

      // Must NOT reject (pre-fix this threw an uncaught TypeError).
      const result = await processStream({
        ...agentRuntimeImpl,
        agentContext: {},
        agentState,
        agentStepId: 'test-step-id',
        agentTemplate: agentWithWriteTool,
        ancestorRunIds: [],
        clientSessionId: 'test-session',
        fileContext: mockFileContext,
        fingerprintId: 'test-fingerprint',
        fullResponse: '',
        localAgentTemplates: { 'test-agent': agentWithWriteTool },
        messages: [],
        prompt: 'test prompt',
        repoId: undefined,
        repoUrl: undefined,
        runId: 'test-run-id',
        signal: new AbortController().signal,
        stream: mockStream(),
        system: 'test system',
        tools: {},
        userId: 'test-user',
        userInputId: 'test-input-id',
        onCostCalculated: async () => {},
        onResponseChunk: (chunk) => {
          responseChunks.push(chunk)
        },
      })

      const errorEvents = responseChunks.filter(
        (chunk): chunk is Extract<PrintModeEvent, { type: 'error' }> =>
          typeof chunk !== 'string' && chunk.type === 'error',
      )
      expect(errorEvents.length).toBe(1)
      expect(errorEvents[0].message).toContain(expectInMessage)
      // No tool_call was streamed for the malformed call.
      const toolCallEvents = responseChunks.filter(
        (chunk): chunk is Extract<PrintModeEvent, { type: 'tool_call' }> =>
          typeof chunk !== 'string' && chunk.type === 'tool_call',
      )
      expect(toolCallEvents.length).toBe(0)
      expect(result.hadToolCallError).toBe(true)
    }
  })

  it('C2: should surface a rejected tool handler as a tool error instead of failing the run', async () => {
    // FID-2026-0802-005 C2 regression: a handler rejection used to propagate
    // past the executor → reject previousToolCallFinished → reject the whole
    // run. It must now be caught, surfaced as an error chunk (driving the
    // hadToolCallError retry flow), and the run must continue.
    const agentWithTerminal: AgentTemplate = {
      ...testAgentTemplate,
      toolNames: ['run_terminal_command', 'end_turn'],
    }

    // Make the runtime's terminal execution throw inside the handler.
    agentRuntimeImpl.requestToolCall = async () => {
      throw new Error('boom: terminal execution failed')
    }

    // 'unsafe' permission mode lets run_terminal_command past the sandbox so
    // the handler actually executes (and rejects) — the point of this test.
    const unsafeFileContext = {
      ...mockFileContext,
      permissionMode: 'unsafe' as const,
    }
    const sessionState = getInitialSessionState(unsafeFileContext)
    const agentState = sessionState.mainAgentState
    agentState.fsmPhase = 'green'
    agentState.fsmPhase = 'green'
    const responseChunks: (string | PrintModeEvent)[] = []

    async function* mockStream() {
      yield {
        type: 'tool-call',
        toolName: 'run_terminal_command',
        toolCallId: 'throwing-handler-call',
        input: { command: 'bun run typecheck' },
      } as StreamChunk
      return promptSuccess('mock-message-id')
    }

    // Must NOT reject (pre-fix this propagated and failed the run).
    const result = await processStream({
      ...agentRuntimeImpl,
      agentContext: {},
      agentState,
      agentStepId: 'test-step-id',
      agentTemplate: agentWithTerminal,
      ancestorRunIds: [],
      clientSessionId: 'test-session',
      fileContext: unsafeFileContext,
      fingerprintId: 'test-fingerprint',
      fullResponse: '',
      localAgentTemplates: { 'test-agent': agentWithTerminal },
      messages: [],
      prompt: 'test prompt',
      repoId: undefined,
      repoUrl: undefined,
      runId: 'test-run-id',
      signal: new AbortController().signal,
      stream: mockStream(),
      system: 'test system',
      tools: {},
      userId: 'test-user',
      userInputId: 'test-input-id',
      onCostCalculated: async () => {},
      onResponseChunk: (chunk) => {
        responseChunks.push(chunk)
      },
    })

    const errorEvents = responseChunks.filter(
      (chunk): chunk is Extract<PrintModeEvent, { type: 'error' }> =>
        typeof chunk !== 'string' && chunk.type === 'error',
    )
    expect(errorEvents.length).toBe(1)
    expect(errorEvents[0].message).toContain('boom: terminal execution failed')
    // The run continues via the hadToolCallError retry flow.
    expect(result.hadToolCallError).toBe(true)
    // No orphan tool_result was recorded for the failed handler.
    const toolMessages = agentState.messageHistory.filter(
      (m) => m.role === 'tool',
    )
    expect(toolMessages.length).toBe(0)
  })

  it('C2 (custom tools): should surface a rejected custom-tool request as a tool error instead of failing the run', async () => {
    // FID-2026-0802-005 C2 parity: executeCustomToolCall's requestToolCall
    // rejection used to reject previousToolCallFinished and fail the whole
    // run — the same failure mode C2 fixed for native handlers.
    const toolName = 'flaky_custom_tool'
    const agentWithCustomTool: AgentTemplate = {
      ...testAgentTemplate,
      toolNames: [toolName, 'end_turn'],
    }

    const fileContextWithCustomTool = {
      ...mockFileContext,
      permissionMode: 'unsafe' as const,
      customToolDefinitions: {
        [toolName]: {
          inputSchema: {
            type: 'object',
            properties: {
              query: { type: 'string' },
            },
            required: ['query'],
            additionalProperties: false,
          },
          endsAgentStep: false,
          description: 'A flaky custom tool',
          effect: 'network' as const,
          permission: 'allow' as const,
        },
      },
    }

    agentRuntimeImpl.requestMcpToolData = async () => []
    agentRuntimeImpl.requestToolCall = async () => {
      throw new Error('boom: custom tool execution failed')
    }

    async function* mockStream() {
      yield {
        type: 'tool-call',
        toolName,
        toolCallId: 'flaky-custom-call',
        input: { query: 'test' },
      } as StreamChunk
      return promptSuccess('mock-message-id')
    }

    const sessionState = getInitialSessionState(fileContextWithCustomTool)
    const agentState = sessionState.mainAgentState
    agentState.fsmPhase = 'green'
    const responseChunks: (string | PrintModeEvent)[] = []

    // Must NOT reject (pre-fix this propagated and failed the run).
    const result = await processStream({
      ...agentRuntimeImpl,
      agentContext: {},
      agentState,
      agentStepId: 'test-step-id',
      agentTemplate: agentWithCustomTool,
      ancestorRunIds: [],
      clientSessionId: 'test-session',
      fileContext: fileContextWithCustomTool,
      fingerprintId: 'test-fingerprint',
      fullResponse: '',
      localAgentTemplates: { 'test-agent': agentWithCustomTool },
      messages: [],
      prompt: 'test prompt',
      repoId: undefined,
      repoUrl: undefined,
      runId: 'test-run-id',
      signal: new AbortController().signal,
      stream: mockStream(),
      system: 'test system',
      tools: {},
      userId: 'test-user',
      userInputId: 'test-input-id',
      onCostCalculated: async () => {},
      onResponseChunk: (chunk) => {
        responseChunks.push(chunk)
      },
    })

    const errorEvents = responseChunks.filter(
      (chunk): chunk is Extract<PrintModeEvent, { type: 'error' }> =>
        typeof chunk !== 'string' && chunk.type === 'error',
    )
    expect(errorEvents.length).toBe(1)
    expect(errorEvents[0].message).toContain(
      'boom: custom tool execution failed',
    )
    expect(result.hadToolCallError).toBe(true)
  })
})
