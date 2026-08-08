/**
 * @module echo/law4-turn-end
 *
 * Law 4: Verify Call-Graph Reachability — turn-end evaluation.
 *
 * After a feature is wired (export added), the agent must grep for
 * callers to confirm reachability. If features were wired but not
 * verified, this gate fires.
 *
 * In strict mode: blocking violation.
 * In hybrid mode: advisory warning only.
 */

import type {
  EnforcementMode,
  EnforcementResult,
  EnforcementState,
  AdvisoryWarning,
} from './types'

/**
 * Evaluate Law 4 at turn end.
 *
 * Compares `featuresWired` against `featuresVerified` to detect
 * features that were exported but whose callers were never grepped.
 *
 * @returns EnforcementResult — blocked in strict mode, advisory in hybrid.
 */
export function evaluateLaw4TurnEnd(params: {
  state: EnforcementState
  mode: EnforcementMode
  tier: 'core_4' | 'all_15'
}): EnforcementResult {
  const { state } = params
  const warnings: AdvisoryWarning[] = []

  // Find unwired features: in featuresWired but not in featuresVerified
  const unwired: string[] = []
  for (const feature of state.featuresWired) {
    if (!state.featuresVerified.has(feature)) {
      unwired.push(feature)
    }
  }

  if (unwired.length === 0) {
    return { blocked: false, warnings }
  }

  const featureList = unwired.join(', ')
  const msg =
    `Law 4: Call-graph reachability — ${unwired.length} feature(s) ` +
    `wired but not verified for callers: [${featureList}]. ` +
    `Run code_search or grep for production entry points.`

  const warning: AdvisoryWarning = {
    law: 4,
    severity: 'warning',
    message: msg,
  }
  warnings.push(warning)

  // In strict mode: block. In hybrid: advisory only.
  const blocked = params.tier === 'all_15'

  return {
    blocked,
    reason: blocked ? msg : undefined,
    warnings,
  }
}
