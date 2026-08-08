import { type SandboxPermissionMode } from '@savant-code/common/tools/safety'

import { createDefaultSandboxPolicy, evaluateToolCall } from '../sandbox'

import type { Logger } from '@savant-code/common/types/contracts/logger'
import type { JSONValue } from '@savant-code/common/types/json'
import type { PrintModeEvent } from '@savant-code/common/types/print-mode'

/**
 * FID-2026-07-27-001: Evaluate a tool call against the sandbox policy after
 * FSM and agent-restriction gating, but before streaming the tool_call event
 * or invoking the handler. devMode bypasses the sandbox (logged elsewhere).
 * Returns true when the call was rejected (an error chunk was emitted and the
 * caller should return early).
 */
export function checkSandboxPolicy(params: {
  isDevOverride: boolean
  toolName: string
  toolCallToolName: string
  toolCallInput: Record<string, JSONValue>
  projectRoot: string | undefined
  permissionMode: 'safe' | 'prompt' | 'unsafe' | undefined
  logger: Logger
  onResponseChunk: (chunk: string | PrintModeEvent) => void
}): boolean {
  const {
    isDevOverride,
    toolName,
    toolCallToolName,
    toolCallInput,
    projectRoot,
    permissionMode,
    logger,
    onResponseChunk,
  } = params

  if (isDevOverride) {
    return false
  }
  if (!projectRoot) {
    logger.warn(
      { toolName },
      'Sandbox check skipped: fileContext.projectRoot is missing. This is a configuration error and may allow unsafe tool calls.',
    )
    return false
  }

  const sandboxPolicy = createDefaultSandboxPolicy(
    projectRoot,
    permissionMode as SandboxPermissionMode | undefined,
  )
  const sandboxDecision = evaluateToolCall({
    toolName: toolCallToolName,
    // C1: same safe narrowing as the write gate — validated input only.
    input: toolCallInput,
    policy: sandboxPolicy,
  })
  if (sandboxDecision.type === 'deny') {
    onResponseChunk({
      type: 'error',
      message: `Tool \`${toolName}\` was blocked by the sandbox: ${sandboxDecision.reason}`,
    })
    return true
  }
  if (sandboxDecision.type === 'prompt') {
    // Phase 1: no interactive TUI permission modal yet. Downgrade to deny
    // in headless mode. Future work will surface a permission request event.
    logger.debug(
      { toolName, reason: sandboxDecision.reason },
      'Sandbox prompt decision downgraded to deny in headless mode',
    )
    onResponseChunk({
      type: 'error',
      message: `Tool \`${toolName}\` requires approval: ${sandboxDecision.reason}. Run with permission mode \`unsafe\` or re-run interactively when supported.`,
    })
    return true
  }
  return false
}
