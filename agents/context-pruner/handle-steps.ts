import { applyBudgets } from './apply-budgets'
import { CONTEXT_PRUNER_CONSTANTS } from './constants'
import * as helpers from './helpers'
import { runContextPrunerMain } from './main'
import * as preservedState from './preserved-state'
import * as structuredSummary from './structured-summary'
import { summarizeMessages } from './summarize-messages'
import { summarizeToolCall } from './summarize-tool-call'

import type { AgentDefinition } from '../types/agent-definition'

type ContextPrunerHandleSteps = NonNullable<AgentDefinition['handleSteps']>

/**
 * Builds the context-pruner handleSteps generator as a fully self-contained
 * source string (the savant pattern, FID-2026-0802-005 L5): handleSteps is
 * serialized via .toString() (prebuild-agents.ts) and re-eval'd
 * (deserializeHandleSteps), so the generated function MUST reference only
 * literals, params, and locals — no closure variables.
 *
 * Composition:
 *   - constants are baked in as `const NAME = <JSON literal>` declarations;
 *   - the pure helper modules and the extracted Phase 1 / Phase 2+3 / main
 *     orchestrator functions are embedded via .toString(). Bun transpiles
 *     TypeScript on import, so each serialized body is already plain JS; all
 *     cross-references between them resolve inside the generated generator
 *     scope (function declarations hoist, constants evaluate first).
 *   - the generator delegates to runContextPrunerMain via `yield*`.
 *
 * The eval runs once at module load with string literals only — the same
 * trust domain as the runtime's existing deserializeHandleSteps.
 */
export function createContextPrunerHandleSteps(): ContextPrunerHandleSteps {
  const bakedConstants = Object.entries(CONTEXT_PRUNER_CONSTANTS)
    .map(([name, value]) => `const ${name} = ${JSON.stringify(value)}`)
    .join('\n')

  const embeddedHelpers = [
    ...Object.values(helpers).map((fn) => fn.toString()),
    summarizeToolCall.toString(),
    summarizeMessages.toString(),
    applyBudgets.toString(),
    // P1 modules (FID-2026-0806-003 Phase 1): filter to functions only —
    // exported interfaces are type-only (erased) and there are no exported
    // runtime constants in these modules.
    ...Object.values(preservedState)
      .filter((v) => typeof v === 'function')
      .map((fn) => (fn as () => unknown).toString()),
    ...Object.values(structuredSummary)
      .filter((v) => typeof v === 'function')
      .map((fn) => (fn as () => unknown).toString()),
    runContextPrunerMain.toString(),
  ].join('\n\n')

  const source = [
    'function* ({ agentState, params, logger }) {',
    bakedConstants,
    embeddedHelpers,
    '  yield* runContextPrunerMain(agentState, params, logger)',
    '}',
  ].join('\n\n')

  return eval(`(${source})`) as ContextPrunerHandleSteps
}
