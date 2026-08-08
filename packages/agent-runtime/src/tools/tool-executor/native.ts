import * as fs from 'node:fs'

import { userMessage } from '@savant-code/common/util/messages'
import { generateCompactId } from '@savant-code/common/util/string'

import { recordEchoComplianceActivity } from './echo-record'
import { checkSandboxPolicy } from './sandbox-gate'
import { validateSpawnAgentsInput } from './spawn-validation'
import { runWriteGate } from './write-gate'
import { EchoEnforcement } from '../../echo/enforcement'
import {
  buildComplianceWarningChunks,
  formatBlockingError,
} from '../../echo/violation-handler'
import { toolActivity, setActivity } from '../../util/activity-tracking'
import { isSecuritySensitivePath } from '../../util/echo-compliance'
import { formatValueForError } from '../../util/format-value'
import { buildUserMessageContent } from '../../util/messages'
import { savantCode$1 } from '../handlers/list'
import { countWriteLines, parseRawToolCall } from '../tool-call-parse'

import type { ExecuteToolCallParams } from './types'
import type { SavantCodeToolHandlerFunction } from '../handlers/handler-function-type'
import type { ToolCallError } from '../tool-call-parse'
import type { ToolName } from '@savant-code/common/tools/constants'
import type {
  ClientToolCall,
  ClientToolName,
  SavantCodeToolCall,
  SavantCodeToolOutput,
} from '@savant-code/common/tools/list'
import type { JSONValue } from '@savant-code/common/types/json'
import type { ToolMessage } from '@savant-code/common/types/messages/savant-code-message'
import type { AgentState } from '@savant-code/common/types/session-state'

/**
 * Inject EHEL corrective steering into the agent's message history (mirrors
 * the tracker's ECHO_COMPLIANCE injection in loop-iteration): budgeted
 * corrective text the running agent sees on its next model step, tagged so
 * it is recognizably harness guidance rather than user dialogue.
 *
 * ECHO_STEERING is intentionally NOT in the context-pruner's tag exclusion
 * list (unlike GRAPH_EVIDENCE): the corrective guidance is genuine
 * conversation content the agent should retain, consistent with how the
 * tracker's ECHO_COMPLIANCE steering is summarized. Do not exclude it.
 */
function injectEhelSteering(
  agentState: AgentState,
  enforcement: EchoEnforcement,
): void {
  const steering = enforcement.takeSteeringMessages()
  if (steering.length === 0) return
  agentState.messageHistory = [
    ...agentState.messageHistory,
    ...steering.map((text) =>
      userMessage({
        content: buildUserMessageContent(text, undefined, undefined),
        tags: ['ECHO_STEERING'],
        keepDuringTruncation: true,
      }),
    ),
  ]
}

export async function executeToolCall<T extends ToolName>(
  params: ExecuteToolCallParams<T>,
): Promise<void> {
  const {
    toolName,
    input,
    excludeToolFromMessageHistory = false,
    fromHandleSteps = false,

    agentState,
    agentTemplate,
    logger,
    previousToolCallFinished,
    toolCalls,
    toolCallsToAddToMessageHistory,
    toolResults,
    toolResultsToAddToMessageHistory,
    userInputId,

    onCostCalculated,
    onResponseChunk,
    requestToolCall,
  } = params
  const toolCallId = params.toolCallId ?? generateCompactId()

  const toolCall: SavantCodeToolCall<T> | ToolCallError = parseRawToolCall<T>({
    rawToolCall: {
      toolName,
      toolCallId,
      input,
    },
  })

  // Dev override: bypass ALL tool gating and agent restrictions when devMode is active
  const isDevOverride = params.fileContext.devMode === true

  // FID-2026-0804-009: resolved path of the current write tool call, if any.
  // Set by the write gate; consumed by the Law 1 record AFTER the sandbox gate
  // (code-review finding — sandbox-denied writes must not count toward the
  // change footprint). Undefined for non-write tools.
  let resolvedWritePath: string | undefined

  // FID-2026-0802-005 C1: the parse-error branch MUST run before any
  // `toolCall.input` dereference. On parse failure `toolCall.input` is the raw
  // (unvalidated) input — null or a bare string would crash the write gate
  // below (`TypeError: Cannot read properties of null` / strict-mode
  // `Cannot create property 'path' on string`). This gate ordering is the
  // runtime's most important robustness invariant.
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

  // Filter out restricted tools - emit error instead of tool call/result
  // This prevents the CLI from showing tool calls that the agent doesn't have permission to use
  if (
    !isDevOverride &&
    toolCall.toolName &&
    !agentTemplate.toolNames.includes(toolCall.toolName) &&
    !fromHandleSteps
  ) {
    // Emit an error event instead of tool call/result pair
    // The stream parser will convert this to a user message for proper API compliance
    onResponseChunk({
      type: 'error',
      message: `Tool \`${toolName}\` is not currently available [agent: ${agentTemplate.id}]. Make sure to only use tools provided at the start of the conversation AND that you most recently have permission to use.`,
    })
    return previousToolCallFinished
  }

  // FID-2026-0718-013 v3 F3: containment check runs for every write, regardless
  // of dev mode (see runWriteGate). The FSM phase check below remains gated by
  // `!isDevOverride` for dev flexibility.
  const writeGate = await runWriteGate({
    toolName,
    toolCall,
    fileContext: params.fileContext,
    agentState,
    agentTemplate,
    isDevOverride,
    checkpointDir: params.checkpointDir,
    checkpointTurnId: params.checkpointTurnId,
    clientSessionId: params.clientSessionId,
    onResponseChunk,
  })
  if (writeGate.rejected) {
    return previousToolCallFinished
  }
  resolvedWritePath = writeGate.resolvedWritePath

  // ECHO FSM tool gating: block bash/terminal commands unless phase is
  // 'audit', 'green', or 'self_correct'.
  // run_readonly_command is intentionally NOT gated here; it is allowed in
  // every FSM phase and enforces read-only safety in its own handler.
  // FID-2026-0725-085 BUG-004: FSM phase check runs FIRST (more actionable error).
  // FID-2026-0806-016: 'self_correct' added so audit/adversarial findings can be
  // fixed AND verified inline (Law 3 dirty-file gate) without deadlocking —
  // matches the documented phase table (common/src/constants/agents.ts) which
  // grants run_terminal_command to self_correct. Previously self_correct could
  // not run terminal commands and could not reach 'audit' (VALID_TRANSITIONS),
  // and 'green' is FID-gated — a hard deadlock for read-only audits.
  if (
    !isDevOverride &&
    toolCall.toolName === 'run_terminal_command' &&
    !['audit', 'green', 'self_correct'].includes(agentState.fsmPhase ?? 'idle')
  ) {
    onResponseChunk({
      type: 'error',
      message: `Tool \`${toolName}\` is only available during AUDIT, GREEN, or SELF-CORRECT phases. Current phase: ${agentState.fsmPhase}. Call transition_phase to enter AUDIT, GREEN, or SELF-CORRECT first.`,
    })
    return previousToolCallFinished
  }

  // FID-2026-0725-085 BUG-006: Log warning when devMode bypasses safety restrictions.
  if (
    isDevOverride &&
    (toolCall.toolName === 'write_file' ||
      toolCall.toolName === 'str_replace' ||
      toolCall.toolName === 'apply_patch' ||
      toolCall.toolName === 'run_terminal_command')
  ) {
    logger.debug(
      { toolName, fsmPhase: agentState.fsmPhase },
      `DEV MODE: ${toolName} bypassing FSM phase gating`,
    )
  }

  // FID-2026-0802-005 L11: `sequentialthinking` authorization derives from the
  // toolNames allowlist gate above (only the Thinker declares it) instead of
  // an `id.startsWith('thinker')` naming-convention check — capability is no
  // longer coupled to an agent ID string (FID-005 "identical by construction").

  // EHEL: Initialize enforcement middleware (lazy, per-agentState)
  // Mode is read from agent session config (agentMode from UI toggle)
  const enforcementMode =
    ((agentState as Record<string, unknown>).enforcementMode as string) ===
    'strict'
      ? 'strict'
      : 'hybrid'
  const enforcement =
    ((agentState as Record<string, unknown>)._echoEnforcement as
      EchoEnforcement | undefined) ??
    // FID-2026-0806-005: subagents (parentId set) inherit the parent's
    // session-init protocol read — the hard gate is a main-agent obligation.
    new EchoEnforcement(enforcementMode, {
      protocolPreSeeded: Boolean(agentState.parentId),
    })
  if (!(agentState as Record<string, unknown>)._echoEnforcement) {
    ;(agentState as Record<string, unknown>)._echoEnforcement = enforcement
  }

  // FID-2026-07-27-001: Evaluate tool call against the sandbox policy after
  // FSM and agent-restriction gating, but before streaming the tool_call event
  // or invoking the handler. devMode bypasses the sandbox (logged below).
  const sandboxRejected = checkSandboxPolicy({
    isDevOverride,
    toolName,
    toolCallToolName: toolCall.toolName,
    toolCallInput: toolCall.input as Record<string, JSONValue>,
    projectRoot: params.fileContext?.projectRoot,
    permissionMode: params.fileContext.permissionMode,
    logger,
    onResponseChunk,
  })
  if (sandboxRejected) {
    return previousToolCallFinished
  }

  // EHEL: Pre-write enforcement gate (after sandbox, before Law 1 tracking)
  // Blocks writes that violate Laws 1, 3, 7, 8, or FID Recorder gate.
  if (!isDevOverride) {
    const enforceResult = enforcement.beforeToolCall({
      toolName: toolCall.toolName,
      input: toolCall.input as Record<string, unknown>,
      agentId: agentState.agentId,
    })
    if (enforceResult.blocked) {
      // EHEL blocking results carry their advisory warnings (strict-mode
      // Law 7/8 attach the advisory to the blocked result). Surface them as
      // compliance_warning receipts first — with their ACTUAL law — then the
      // blocking error that drives the retry flow.
      for (const chunk of buildComplianceWarningChunks(
        enforceResult.warnings,
      )) {
        onResponseChunk(chunk)
      }
      onResponseChunk({
        type: 'error',
        message: formatBlockingError(enforceResult.reason ?? 'ECHO violation'),
      })
      // Steer the running agent: inject budgeted corrective text ("search
      // first" / "log intent first") so it self-corrects instead of seeing
      // only a block error.
      injectEhelSteering(agentState, enforcement)
      return previousToolCallFinished
    }
    // EHEL advisories carry their ACTUAL law (law7 / law8 — never a
    // hardcoded law1). The tracker's receipts and the EHEL advisories emit
    // disjoint law sets, so this can never double-report a violation.
    if (enforceResult.warnings.length > 0) {
      for (const chunk of buildComplianceWarningChunks(
        enforceResult.warnings,
      )) {
        onResponseChunk(chunk)
      }
      injectEhelSteering(agentState, enforcement)
    }
  }

  // FID-2026-0804-009: Law 1 (read-before-write) — evaluated AFTER the sandbox
  // gate so sandbox-denied writes are never counted toward the change footprint
  // (code-review finding). Only writes that actually dispatch reach this point;
  // the write gate above stashed the resolved path. New files and
  // content-knowledge writes (str_replace with exact oldString, apply_patch)
  // are exempt. existsSync detects brand-new files; failure degrades to "not
  // new" (worst case an info receipt).
  if (resolvedWritePath !== undefined) {
    const echoCompliance = agentState.echoCompliance
    if (echoCompliance && echoCompliance.mode !== 'off') {
      const writeInput = toolCall.input as Record<string, JSONValue>
      const isNewFile = (() => {
        try {
          return !fs.existsSync(resolvedWritePath)
        } catch {
          return false
        }
      })()
      const contentKnowledge =
        toolCall.toolName === 'str_replace' ||
        toolCall.toolName === 'apply_patch'
      const content =
        typeof writeInput.content === 'string' ? writeInput.content : undefined
      const lineDelta = countWriteLines(toolCall.toolName, writeInput)
      const violation = echoCompliance.recordWrite({
        path: resolvedWritePath,
        lineDelta,
        contentKnowledge,
        isNewFile,
        content,
        securitySensitive: isSecuritySensitivePath(resolvedWritePath),
      })
      if (violation) {
        onResponseChunk({ type: 'compliance_warning', ...violation })
      }
    }
  }

  // NOTE: Future improvement: allow tools to provide a validation function and move this logic into the spawn_agents validation function.
  // Pre-validate spawn_agents to filter out non-existent agents before streaming
  let effectiveInput: Record<string, JSONValue> = toolCall.input
  if (toolName === 'spawn_agents') {
    const spawnValidation = await validateSpawnAgentsInput({
      toolName,
      effectiveInput,
      agentTemplate,
      localAgentTemplates: params.localAgentTemplates,
      fetchAgentFromDatabase: params.fetchAgentFromDatabase,
      databaseAgentCache: params.databaseAgentCache,
      apiKey: params.apiKey,
      logger,
      onResponseChunk,
    })
    if (spawnValidation.rejected) {
      return previousToolCallFinished
    }
    effectiveInput = spawnValidation.input
  }

  // FID-2026-0802-005 H7: abort gate — never stream/push a tool call or
  // invoke a handler after the run has been aborted. Prevents orphaned
  // tool_calls (no matching tool_result) from entering message history,
  // which providers reject. The spawn_agents pre-validation above awaits, so
  // an abort can land inside this window.
  if (params.signal.aborted) {
    return previousToolCallFinished
  }

  // FID-2026-0804-009: record read / spawn / verification activity on the
  // run's ECHO compliance tracker so Law 1 bookkeeping and the mechanical
  // Verifier criteria see the full run picture.
  const echoCompliance = agentState.echoCompliance
  if (echoCompliance && echoCompliance.mode !== 'off') {
    recordEchoComplianceActivity({
      echoCompliance,
      toolName,
      effectiveInput,
    })
  }

  // Only emit tool_call event after permission check passes
  // FID-2026-0718-009: emit activity indicator (M1 tool_call, M6 research tools).
  // toolActivity mutates agentState.activity + emits a chunk via onResponseChunk.
  toolActivity(agentState, toolName, effectiveInput, onResponseChunk)

  onResponseChunk({
    type: 'tool_call',
    toolCallId,
    toolName,
    input: effectiveInput,
    agentId: agentState.agentId,
    parentAgentId: agentState.parentId,
    includeToolCall: !excludeToolFromMessageHistory,
  })

  // Cast to any to avoid type errors
  const handler = savantCode$1[
    toolName
  ] as unknown as SavantCodeToolHandlerFunction<T>

  // Use effective input for spawn_agents so the handler receives the correct agent types
  const finalToolCall =
    toolName === 'spawn_agents'
      ? { ...toolCall, input: effectiveInput }
      : toolCall

  toolCalls.push(finalToolCall)
  if (!excludeToolFromMessageHistory) {
    toolCallsToAddToMessageHistory.push(finalToolCall)
  }

  // FID-2026-0802-005 C2: the handler is a trust boundary — a thrown or
  // rejected exception must surface as a tool error (driving the existing
  // hadToolCallError retry flow via the error chunk below), never propagate
  // past the executor and fail the entire run (Law 14).
  let toolResultPromise: ReturnType<SavantCodeToolHandlerFunction<T>>
  try {
    toolResultPromise = handler({
      ...params,
      toolCall: finalToolCall,
      previousToolCallFinished,
      writeToClient: onResponseChunk,
      // FID-029: `as SavantCodeToolOutput<...>` casts are accepted pre-existing
      // tech debt. See dev/fids/FID-2026-0719-029-as-cast-tech-debt.md.
      // The runtime SDK returns the raw client-tool result shape; bridging
      // to SavantCodeToolOutput<...> at the conditional closure slot requires
      // this cast. On abort, we return a graceful JSON-tool-result matching
      // composio's missing-runtime fallback pattern (rather than `[]`,
      // which propagated a wrong-shape never[] downstream). The cast uses
      // `T extends ClientToolName ? T : never` to align with the slot's
      // exact conditional type so it satisfies ECHO distribution cleanly.
      requestClientToolCall: async (
        clientToolCall: ClientToolCall<T extends ClientToolName ? T : never>,
      ) => {
        if (params.signal.aborted) {
          return [
            {
              type: 'json',
              value: {
                errorMessage: `Tool call aborted: ${clientToolCall.toolName}`,
              },
            },
          ] as SavantCodeToolOutput<T extends ClientToolName ? T : never>
        }

        const clientToolResult = await requestToolCall({
          userInputId,
          toolName: clientToolCall.toolName,
          input: clientToolCall.input,
        })
        return clientToolResult.output as SavantCodeToolOutput<
          T extends ClientToolName ? T : never
        >
      },
    })
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error)
    onResponseChunk({
      type: 'error',
      message: `Tool \`${toolName}\` failed: ${errorMessage}`,
    })
    logger.error(
      { toolName, errorMessage },
      `Tool \`${toolName}\` threw synchronously: ${errorMessage}`,
    )
    return previousToolCallFinished
  }

  return toolResultPromise.then(
    async ({ output, creditsUsed }) => {
      const toolResult: ToolMessage = {
        role: 'tool',
        toolName,
        toolCallId: toolCall.toolCallId,
        content: output,
      }

      // FID-2026-0718-009: M2 — on tool completion, model reasoning resumes.
      setActivity(
        agentState,
        { kind: 'thinking', startedAt: Date.now() },
        onResponseChunk,
      )

      onResponseChunk({
        type: 'tool_result',
        toolCallId: toolResult.toolCallId,
        toolName: toolResult.toolName,
        output: toolResult.content,
      })

      toolResults.push(toolResult)

      if (!excludeToolFromMessageHistory) {
        toolResultsToAddToMessageHistory.push(toolResult)
      }

      // EHEL: Post-tool enforcement tracking
      enforcement.afterToolCall({
        toolName,
        input: toolCall.input as Record<string, unknown>,
        result: {
          text:
            typeof toolResult.content === 'string'
              ? toolResult.content
              : undefined,
        },
      })

      // After tool completes, resolve any pending creditsUsed promise
      if (creditsUsed) {
        onCostCalculated(creditsUsed)
        logger.debug(
          { credits: creditsUsed, totalCredits: agentState.creditsUsed },
          `Added ${creditsUsed} credits from ${toolName} to agent state`,
        )
      }
    },
    async (error) => {
      // FID-2026-0802-005 C2: rejections are caught here and converted into
      // the same retryable tool-error flow instead of failing the run.
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
