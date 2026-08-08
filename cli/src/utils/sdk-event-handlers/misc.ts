import { appendTextToRootStream } from '../block-operations'
import { resetUiToIdle } from '../finish-logic'

import type { EventHandlerState } from './types'
import type {
  PrintModeEvent as SDKEvent,
  PrintModeFinish,
} from '@savant-code/common/types/print-mode'

/**
 * FID-2026-0804-009: render a harness ECHO compliance receipt as a muted
 * transcript line. Non-blocking by design — the receipt informs, it never
 * blocks the stream or opens a modal. The runtime also injects corrective
 * steering into the agent's own context, so the model sees the same notice.
 */
const COMPLIANCE_LABELS: Record<string, string> = {
  law1: 'ECHO Law 1 (read-before-write)',
  law3: 'ECHO Law 3 (verify-before-proceed)',
  law7: 'ECHO Law 7 (search-before-create)',
  law8: 'ECHO Law 8 (intent-before-coding)',
  verifier_criteria: 'ECHO Verifier trigger',
  fid: 'ECHO active-FID review',
}
export const handleComplianceWarning = (
  state: EventHandlerState,
  event: Extract<SDKEvent, { type: 'compliance_warning' }>,
) => {
  const label = COMPLIANCE_LABELS[event.law] ?? 'ECHO compliance'
  const marker = event.severity === 'info' ? 'ℹ️' : '⚖️'
  const line = `\n${marker} **${label}:** ${event.message}${event.path ? ` \`${event.path}\`` : ''}`
  state.logger.warn(
    { law: event.law, severity: event.severity, path: event.path },
    `[${label}] ${event.message}`,
  )
  state.message.updater.updateAiMessageBlocks((blocks) =>
    appendTextToRootStream(blocks, { type: 'text', text: line }),
  )
}
export const handleFinish = (
  state: EventHandlerState,
  event: PrintModeFinish,
) => {
  if (typeof event.totalCost === 'number' && state.onTotalCost) {
    state.onTotalCost(event.totalCost)
  }
  // FID-2026-0718-010 (F2 backstop, D5): if finish arrives, ensure UI is
  // reset to idle. Some runs don't fire subagent_finish for the parent
  // until after onStreamEnded. Treat `finish` as a strong backstop.
  resetUiToIdle('finish')
}
