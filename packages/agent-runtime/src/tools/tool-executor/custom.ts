import { generateCompactId } from '@savant-code/common/util/string'
import { cloneDeep } from 'lodash'

import { getMCPToolData } from '../../mcp'
import { MCP_TOOL_SEPARATOR } from '../../mcp-constants'
import { formatValueForError } from '../../util/format-value'
import { parseRawCustomToolCall } from '../tool-call-parse'

import type { ExecuteToolCallParams } from './types'
import type { CustomToolCall, ToolCallError } from '../tool-call-parse'
import type { JSONValue } from '@savant-code/common/types/json'
import type { ToolResultOutput } from '@savant-code/common/types/messages/content-part'
import type { ToolMessage } from '@savant-code/common/types/messages/savant-code-message'

/** Strips the leading MCP server segment from a prefixed tool name. */
function resolveMcpToolName(toolName: string): string {
  return toolName.includes(MCP_TOOL_SEPARATOR)
    ? toolName.split(MCP_TOOL_SEPARATOR).slice(1).join(MCP_TOOL_SEPARATOR)
    : toolName
}

export async function executeCustomToolCall(
  params: ExecuteToolCallParams<string>,
): Promise<void> {
  const {
    toolName,
    input,
    autoInsertEndStepParam = false,
    excludeToolFromMessageHistory = false,
    fromHandleSteps = false,

    agentState,
    agentTemplate,
    fileContext,
    logger,
    onResponseChunk,
    previousToolCallFinished,
    requestToolCall,
    toolCallId,
    toolCalls,
    toolCallsToAddToMessageHistory,
    toolResults,
    toolResultsToAddToMessageHistory,
    userInputId,
  } = params
  const toolCall: CustomToolCall | ToolCallError = parseRawCustomToolCall({
    // FID-2026-0802-005 H8: prefer the step-built custom tool data passed down
    // from loopAgentSteps (built once per step); fall back to the previous
    // per-call getMCPToolData rebuild (cloneDeep + potential MCP listTools)
    // only when the caller did not provide it.
    customToolDefs:
      params.customToolDefinitions ??
      (await getMCPToolData({
        ...params,
        toolNames: agentTemplate.toolNames,
        mcpServers: agentTemplate.mcpServers,
        writeTo: cloneDeep(fileContext.customToolDefinitions),
      })),
    rawToolCall: {
      toolName,
      toolCallId: toolCallId ?? generateCompactId(),
      input: input as JSONValue,
    },
    autoInsertEndStepParam,
  })

  // Dev override: bypass agent tool restrictions for custom tools when devMode is active
  const isDevOverride = fileContext.devMode === true

  // Filter out restricted tools - emit error instead of tool call/result
  // This prevents the CLI from showing tool calls that the agent doesn't have permission to use
  if (
    !isDevOverride &&
    toolCall.toolName &&
    !agentTemplate.toolNames.includes(toolCall.toolName) &&
    !fromHandleSteps &&
    !(
      toolCall.toolName.includes(MCP_TOOL_SEPARATOR) &&
      toolCall.toolName.split(MCP_TOOL_SEPARATOR)[0] in agentTemplate.mcpServers
    )
  ) {
    // Emit an error event instead of tool call/result pair
    // The stream parser will convert this to a user message for proper API compliance
    onResponseChunk({
      type: 'error',
      message: `Tool \`${toolName}\` is not currently available. Make sure to only use tools listed in the system instructions.`,
    })
    return previousToolCallFinished
  }

  if ('error' in toolCall) {
    const formattedInput = formatValueForError(input)
    onResponseChunk({
      type: 'error',
      message: `${toolCall.error}\n\nOriginal tool call input:\n${formattedInput}`,
    })
    logger.debug(
      { toolCall, error: toolCall.error },
      `${toolName} error: ${toolCall.error}`,
    )
    return previousToolCallFinished
  }

  // Only emit tool_call event after permission check passes
  onResponseChunk({
    type: 'tool_call',
    toolCallId: toolCall.toolCallId,
    toolName,
    input: toolCall.input,
    // Only include agentId for subagents (agents with a parent)
    ...(agentState?.parentId && { agentId: agentState.agentId }),
    // Include includeToolCall flag if explicitly set to false
    ...(excludeToolFromMessageHistory && { includeToolCall: false }),
  })

  toolCalls.push(toolCall)
  if (!excludeToolFromMessageHistory) {
    toolCallsToAddToMessageHistory.push(toolCall)
  }

  return previousToolCallFinished
    .then(async () => {
      if (params.signal.aborted) {
        return null
      }

      const resolvedToolName = resolveMcpToolName(toolCall.toolName)
      const clientToolResult = await requestToolCall({
        userInputId,
        toolName: resolvedToolName,
        input: toolCall.input,
        mcpConfig: toolCall.toolName.includes(MCP_TOOL_SEPARATOR)
          ? agentTemplate.mcpServers[
              toolCall.toolName.split(MCP_TOOL_SEPARATOR)[0]
            ]
          : undefined,
      })
      return clientToolResult.output satisfies ToolResultOutput[]
    })
    .then(
      (result) => {
        if (!result) {
          return
        }
        const toolResult = {
          role: 'tool',
          toolName: resolveMcpToolName(toolName),
          toolCallId: toolCall.toolCallId,
          content: result,
        } satisfies ToolMessage
        logger.debug(
          { input, toolResult },
          `${toolName} custom tool call & result (${toolResult.toolCallId})`,
        )
        onResponseChunk({
          type: 'tool_result',
          toolName: toolResult.toolName,
          toolCallId: toolResult.toolCallId,
          output: toolResult.content,
        })

        toolResults.push(toolResult)

        if (!excludeToolFromMessageHistory) {
          toolResultsToAddToMessageHistory.push(toolResult)
        }

        return
      },
      async (error) => {
        // FID-2026-0802-005 C2 (custom-tool parity): a rejected custom/MCP
        // tool request must surface as a tool error (driving the
        // hadToolCallError retry flow) instead of rejecting
        // previousToolCallFinished and failing the whole run — the same
        // failure mode C2 fixed for native handlers.
        const errorMessage =
          error instanceof Error ? error.message : String(error)
        onResponseChunk({
          type: 'error',
          message: `Tool \`${toolName}\` failed: ${errorMessage}`,
        })
        logger.error(
          { toolName, errorMessage },
          `Tool \`${toolName}\` failed: ${errorMessage}`,
        )
      },
    )
}
