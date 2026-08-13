import * as mainPromptModule from '@savant-code/agent-runtime/main-prompt'
import { withSystemTags } from '@savant-code/agent-runtime/util/messages'
import { getInitialSessionState } from '@savant-code/common/types/session-state'
import { getStubProjectFileContext } from '@savant-code/common/util/file'
import {
  assistantMessage,
  userMessage,
} from '@savant-code/common/util/messages'
import { afterEach, describe, expect, it, mock, spyOn } from 'bun:test'

// Type for tool call content blocks in message history
interface ToolCallContentBlock {
  type: 'tool-call'
  toolCallId: string
  toolName: string
  input: Record<string, JSONValue>
}

// Type for text content blocks in message history
interface TextContentBlock {
  type: 'text'
  text: string
}

import { SavantCodeClient } from '../client'
import * as databaseModule from '../impl/database'

import type { JSONValue } from '@savant-code/common/types/json'

describe('Run Cancellation Handling', () => {
  afterEach(() => {
    mock.restore()
  })

  it('returns cancelled state when aborted before call starts', async () => {
    spyOn(databaseModule, 'getUserInfoFromApiKey').mockResolvedValue({
      id: 'user-123',
      email: 'test@example.com',
      discord_id: null,
      stripe_customer_id: null,
      banned: false,
      created_at: new Date('2024-01-01T00:00:00Z'),
    })

    const abortController = new AbortController()
    // Abort before the run starts
    abortController.abort()

    const client = new SavantCodeClient({
      apiKey: 'test-key',
    })

    const result = await client.run({
      agent: 'savant',
      prompt: 'test prompt',
      signal: abortController.signal,
    })

    // When aborted before starting, should return an error output
    expect(result.output.type).toBe('error')
  })

  it('does not add interruption message when not aborted', async () => {
    spyOn(databaseModule, 'getUserInfoFromApiKey').mockResolvedValue({
      id: 'user-123',
      email: 'test@example.com',
      discord_id: null,
      stripe_customer_id: null,
      banned: false,
      created_at: new Date('2024-01-01T00:00:00Z'),
    })
    spyOn(databaseModule, 'fetchAgentFromDatabase').mockResolvedValue(null)
    spyOn(databaseModule, 'startAgentRun').mockResolvedValue('run-1')
    spyOn(databaseModule, 'finishAgentRun').mockResolvedValue(undefined)
    spyOn(databaseModule, 'addAgentStep').mockResolvedValue('step-1')

    const serverSessionState = getInitialSessionState(
      getStubProjectFileContext(),
    )
    serverSessionState.mainAgentState.messageHistory.push(
      userMessage('User prompt'),
      assistantMessage('Done!'),
    )
    const originalHistoryLength =
      serverSessionState.mainAgentState.messageHistory.length

    spyOn(mainPromptModule, 'callMainPrompt').mockImplementation(
      async (params: Parameters<typeof mainPromptModule.callMainPrompt>[0]) => {
        const { sendAction, promptId } = params

        await sendAction({
          action: {
            type: 'prompt-response',
            promptId,
            sessionState: serverSessionState,
            output: {
              type: 'lastMessage',
              value: [],
            },
          },
        })

        return {
          sessionState: serverSessionState,
          output: {
            type: 'lastMessage' as const,
            value: [],
          },
        }
      },
    )

    const client = new SavantCodeClient({
      apiKey: 'test-key',
    })

    // Run without aborting
    const result = await client.run({
      agent: 'savant',
      prompt: 'test prompt',
    })

    // Message history should not have an interruption message
    const messageHistory = result.sessionState!.mainAgentState.messageHistory
    expect(messageHistory.length).toBe(originalHistoryLength)

    // Last message should be the assistant's "Done!" message, not an interruption
    const lastMessage = messageHistory[messageHistory.length - 1]
    expect(lastMessage.role).toBe('assistant')
  })

  it('preserves message history across cancelled run and subsequent run', async () => {
    spyOn(databaseModule, 'getUserInfoFromApiKey').mockResolvedValue({
      id: 'user-123',
      email: 'test@example.com',
      discord_id: null,
      stripe_customer_id: null,
      banned: false,
      created_at: new Date('2024-01-01T00:00:00Z'),
    })
    spyOn(databaseModule, 'fetchAgentFromDatabase').mockResolvedValue(null)
    spyOn(databaseModule, 'startAgentRun').mockResolvedValue('run-1')
    spyOn(databaseModule, 'finishAgentRun').mockResolvedValue(undefined)
    spyOn(databaseModule, 'addAgentStep').mockResolvedValue('step-1')

    const abortController = new AbortController()

    // First run: server processes the user message and does some work, then user cancels
    const firstRunServerState = getInitialSessionState(
      getStubProjectFileContext(),
    )
    firstRunServerState.mainAgentState.messageHistory.push(
      userMessage('Fix the bug in auth.ts'),
      assistantMessage('I will analyze the authentication module.'),
    )

    spyOn(mainPromptModule, 'callMainPrompt').mockImplementation(
      async (params: Parameters<typeof mainPromptModule.callMainPrompt>[0]) => {
        const { sendAction, promptId } = params

        // Stream some content
        await sendAction({
          action: {
            type: 'response-chunk',
            userInputId: promptId,
            chunk: 'Analyzing auth.ts...',
          },
        })

        // User cancels mid-stream
        abortController.abort()

        // Agent runtime adds interruption message on abort
        firstRunServerState.mainAgentState.messageHistory.push(
          userMessage(
            withSystemTags(
              "User interrupted the response. The assistant's previous work has been preserved.",
            ),
          ),
        )

        // Server still sends the prompt-response with its session state
        await sendAction({
          action: {
            type: 'prompt-response',
            promptId,
            sessionState: firstRunServerState,
            output: {
              type: 'lastMessage',
              value: [],
            },
          },
        })

        return {
          sessionState: firstRunServerState,
          output: {
            type: 'lastMessage' as const,
            value: [],
          },
        }
      },
    )

    const client = new SavantCodeClient({
      apiKey: 'test-key',
    })

    // Run 1: cancelled mid-stream
    const firstRunResult = await client.run({
      agent: 'savant',
      prompt: 'Fix the bug in auth.ts',
      signal: abortController.signal,
    })

    // Verify the first run preserved the user message and work
    expect(firstRunResult.sessionState).toBeDefined()
    const firstHistory =
      firstRunResult.sessionState!.mainAgentState.messageHistory
    expect(firstHistory.length).toBe(3) // user + assistant + interruption

    const firstUserMsg = firstHistory.find(
      (m) =>
        m.role === 'user' &&
        m.content.some(
          (c): c is TextContentBlock =>
            c.type === 'text' && c.text.includes('Fix the bug'),
        ),
    )
    expect(firstUserMsg).toBeDefined()

    // Now set up mock for the second run
    mock.restore()
    spyOn(databaseModule, 'getUserInfoFromApiKey').mockResolvedValue({
      id: 'user-123',
      email: 'test@example.com',
      discord_id: null,
      stripe_customer_id: null,
      banned: false,
      created_at: new Date('2024-01-01T00:00:00Z'),
    })
    spyOn(databaseModule, 'fetchAgentFromDatabase').mockResolvedValue(null)
    spyOn(databaseModule, 'startAgentRun').mockResolvedValue('run-2')
    spyOn(databaseModule, 'finishAgentRun').mockResolvedValue(undefined)
    spyOn(databaseModule, 'addAgentStep').mockResolvedValue('step-2')

    // Second run: server receives the previous state and adds the new user message
    const secondRunServerState = JSON.parse(
      JSON.stringify(firstRunResult.sessionState!),
    ) as typeof firstRunServerState
    secondRunServerState.mainAgentState.messageHistory.push(
      userMessage('Now also fix the login page'),
      assistantMessage('I will fix both issues.'),
    )

    spyOn(mainPromptModule, 'callMainPrompt').mockImplementation(
      async (params: Parameters<typeof mainPromptModule.callMainPrompt>[0]) => {
        const { sendAction, promptId } = params

        await sendAction({
          action: {
            type: 'prompt-response',
            promptId,
            sessionState: secondRunServerState,
            output: {
              type: 'lastMessage',
              value: [],
            },
          },
        })

        return {
          sessionState: secondRunServerState,
          output: {
            type: 'lastMessage' as const,
            value: [],
          },
        }
      },
    )

    // Run 2: uses previousRun from the cancelled first run
    const secondRunResult = await client.run({
      agent: 'savant',
      prompt: 'Now also fix the login page',
      previousRun: firstRunResult,
    })

    // Verify the second run's session state includes history from BOTH runs
    expect(secondRunResult.sessionState).toBeDefined()
    const secondHistory =
      secondRunResult.sessionState!.mainAgentState.messageHistory

    // Should have: first user msg + first assistant msg + interruption + second user msg + second assistant msg
    expect(secondHistory.length).toBe(5)

    // The first user message should be present
    const firstUserMsgInSecond = secondHistory.find(
      (m) =>
        m.role === 'user' &&
        m.content.some(
          (c): c is TextContentBlock =>
            c.type === 'text' && c.text.includes('Fix the bug'),
        ),
    )
    expect(firstUserMsgInSecond).toBeDefined()

    // The second user message should also be present
    const secondUserMsg = secondHistory.find(
      (m) =>
        m.role === 'user' &&
        m.content.some(
          (c): c is TextContentBlock =>
            c.type === 'text' && c.text.includes('fix the login page'),
        ),
    )
    expect(secondUserMsg).toBeDefined()

    // The first assistant message should be preserved
    const firstAssistantMsg = secondHistory.find(
      (m) =>
        m.role === 'assistant' &&
        m.content.some(
          (c): c is TextContentBlock =>
            c.type === 'text' && c.text.includes('authentication module'),
        ),
    )
    expect(firstAssistantMsg).toBeDefined()
  })

  it('preserves session state even when abort happens mid-stream', async () => {
    spyOn(databaseModule, 'getUserInfoFromApiKey').mockResolvedValue({
      id: 'user-123',
      email: 'test@example.com',
      discord_id: null,
      stripe_customer_id: null,
      banned: false,
      created_at: new Date('2024-01-01T00:00:00Z'),
    })
    spyOn(databaseModule, 'fetchAgentFromDatabase').mockResolvedValue(null)
    spyOn(databaseModule, 'startAgentRun').mockResolvedValue('run-1')
    spyOn(databaseModule, 'finishAgentRun').mockResolvedValue(undefined)
    spyOn(databaseModule, 'addAgentStep').mockResolvedValue('step-1')

    const abortController = new AbortController()
    const serverSessionState = getInitialSessionState(
      getStubProjectFileContext(),
    )

    // Simulate multiple tool calls and results (more complex work done)
    serverSessionState.mainAgentState.messageHistory.push(
      userMessage('Fix the bug'),
      {
        role: 'assistant',
        content: [
          {
            type: 'text',
            text: 'I will analyze the issue.',
          } as TextContentBlock,
          {
            type: 'tool-call',
            toolCallId: 'read-1',
            toolName: 'read_files',
            input: { paths: ['src/bug.ts'] },
          } as ToolCallContentBlock,
        ],
      },
      {
        role: 'tool',
        toolCallId: 'read-1',
        toolName: 'read_files',
        content: [
          {
            type: 'json',
            value: [{ path: 'src/bug.ts', content: 'buggy code' }],
          },
        ],
      },
      {
        role: 'assistant',
        content: [
          {
            type: 'text',
            text: 'Found the bug, fixing now.',
          } as TextContentBlock,
          {
            type: 'tool-call',
            toolCallId: 'write-1',
            toolName: 'write_file',
            input: { path: 'src/bug.ts', content: 'fixed code' },
          } as ToolCallContentBlock,
        ],
      },
      {
        role: 'tool',
        toolCallId: 'write-1',
        toolName: 'write_file',
        content: [
          {
            type: 'json',
            value: { file: 'src/bug.ts', message: 'File written' },
          },
        ],
      },
    )

    const streamedChunks: string[] = []

    spyOn(mainPromptModule, 'callMainPrompt').mockImplementation(
      async (params: Parameters<typeof mainPromptModule.callMainPrompt>[0]) => {
        const { sendAction, promptId } = params

        // Stream some chunks
        for (const chunk of ['Working', ' on', ' the', ' next', ' step']) {
          await sendAction({
            action: {
              type: 'response-chunk',
              userInputId: promptId,
              chunk,
            },
          })
        }

        // User aborts mid-stream
        abortController.abort()

        // Simulate agent runtime adding interruption message on abort
        serverSessionState.mainAgentState.messageHistory.push(
          userMessage(
            withSystemTags(
              "User interrupted the response. The assistant's previous work has been preserved.",
            ),
          ),
        )

        // Server still returns the full session state
        await sendAction({
          action: {
            type: 'prompt-response',
            promptId,
            sessionState: serverSessionState,
            output: {
              type: 'lastMessage',
              value: [],
            },
          },
        })

        return {
          sessionState: serverSessionState,
          output: {
            type: 'lastMessage' as const,
            value: [],
          },
        }
      },
    )

    const client = new SavantCodeClient({
      apiKey: 'test-key',
    })

    const result = await client.run({
      agent: 'savant',
      prompt: 'test prompt',
      signal: abortController.signal,
      handleStreamChunk: (chunk) => {
        if (typeof chunk === 'string') {
          streamedChunks.push(chunk)
        }
      },
    })

    // Verify session state is preserved with all the work
    expect(result.sessionState).toBeDefined()
    const messageHistory = result.sessionState!.mainAgentState.messageHistory

    // Should have: user message + 4 assistant/tool messages + 1 interruption
    // The server state already has the content; pendingAgentResponse is not duplicated.
    expect(messageHistory.length).toBe(6)

    // Verify the write_file tool result is still there (work was preserved)
    const writeToolResult = messageHistory.find(
      (m) => m.role === 'tool' && m.toolCallId === 'write-1',
    )
    expect(writeToolResult).toBeDefined()

    // Verify interruption message was added at the end
    const lastMessage = messageHistory[messageHistory.length - 1]
    expect(lastMessage.role).toBe('user')
    expect((lastMessage.content[0] as TextContentBlock).text).toContain(
      'User interrupted the response',
    )
  })
})
