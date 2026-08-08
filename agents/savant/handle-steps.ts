import { SAVANT_FREE_KIMI_MODEL_ID } from '@savant-code/common/constants/savant-free-models'

import type { SecretAgentDefinition } from '../types/secret-agent-definition'

type SavantHandleSteps = NonNullable<SecretAgentDefinition['handleSteps']>

export function getSavantContextPrunerMaxContextLength(
  model: SecretAgentDefinition['model'],
): 250_000 | 400_000 {
  if (model === SAVANT_FREE_KIMI_MODEL_ID) return 250_000
  return 400_000
}

export function getSavantHandleSteps({
  isFree,
  maxContextLength,
}: {
  isFree: boolean
  maxContextLength: 250_000 | 400_000
}): SavantHandleSteps {
  if (isFree) {
    if (maxContextLength === 250_000) return handleStepsFree250k
    return handleStepsFree400k
  }
  if (maxContextLength === 250_000) return handleSteps250k
  return handleSteps400k
}

// FID-2026-0802-005 L5: the four handleSteps variants differed only in two
// literals (the fallback maxContextLength and the free-tier cacheExpiryMs) and
// duplicated `asNumber` four times. They were collapsed into one factory.
// handleSteps is serialized via .toString() and re-eval'd (prebuild-agents.ts
// + run-programmatic-step.ts deserializeHandleSteps), so the generated
// function MUST be fully self-contained: only literals, params, and locals —
// no closure variables. Baking the config values as literals into the
// generated source guarantees that. The eval runs once at module load with
// numeric literals only — the same trust domain as the runtime's existing
// deserializeHandleSteps.
//
// FID-2026-0806-003 Phases 3/6: P3a amortized fold + P3c idle compaction + P3d
// force ratio (Hermes pattern, off by default) are baked the same way — the
// factory is the ONLY surface where compression config becomes trigger
// behavior; protocol.config.yaml values are threaded in here by the caller.
function createSavantHandleSteps(config: {
  defaultMaxContextLength: 250_000 | 400_000
  cacheExpiryMs?: number
  /** P3a — fold one oldest exchange per completed turn (off by default). */
  amortizedFold?: boolean
  /** P3a — fold only above this context floor (tokens). */
  foldFloorTokens?: number
  /** P3c — idle compaction predicate (off by default). */
  idleCompaction?: {
    enabled: boolean
    idleAfterSeconds: number
    floorTokens: number
  }
}): SavantHandleSteps {
  const {
    defaultMaxContextLength,
    cacheExpiryMs,
    amortizedFold = false,
    foldFloorTokens = 40_000,
    idleCompaction = {
      enabled: false,
      idleAfterSeconds: 1800,
      floorTokens: 40_000,
    },
  } = config
  const cacheExpiryParam =
    cacheExpiryMs === undefined ? '' : `cacheExpiryMs: ${cacheExpiryMs},`
  const amortizedFoldLiteral = amortizedFold ? 'true' : 'false'
  const foldFloorLiteral = String(foldFloorTokens)
  const idleEnabledLiteral = idleCompaction.enabled ? 'true' : 'false'
  const idleAfterMsLiteral = String(idleCompaction.idleAfterSeconds * 1000)
  const idleFloorLiteral = String(idleCompaction.floorTokens)
  const source = `function* ({ params, agentState }) {
    function asNumber(value) {
      return typeof value === 'number' ? value : null
    }
    const p = params ?? {}
    const maxContextLength =
      agentState.maxContextLength ?? asNumber(p.maxContextLength) ?? ${defaultMaxContextLength}
    // P3a/P3c/P3d (FID-2026-0806-003) — baked literals; see the factory.
    const amortizedFold = ${amortizedFoldLiteral}
    const foldFloorTokens = ${foldFloorLiteral}
    const idleEnabled = ${idleEnabledLiteral}
    const idleAfterMs = ${idleAfterMsLiteral}
    const idleFloorTokens = ${idleFloorLiteral}
    const forceRatio = 0.9
    let idleChecked = false
    while (true) {
      // P3c idle compaction: evaluate ONCE per run (a run = one user turn, so
      // this is the session-resume moment). Idle gap > idleAfterMs AND context
      // above the floor => compact up front with force so the pruner proceeds
      // even when its own gates wouldn't fire. Self-regulating: a fresh
      // compaction refreshes sentAt timestamps, so the next run sees no gap.
      if (!idleChecked) {
        idleChecked = true
        if (idleEnabled) {
          let newestSentAt = 0
          for (const m of agentState.messageHistory) {
            if (typeof m.sentAt === 'number' && m.sentAt > newestSentAt) {
              newestSentAt = m.sentAt
            }
          }
          const idleMs = newestSentAt > 0 ? Date.now() - newestSentAt : 0
          if (
            idleMs > idleAfterMs &&
            agentState.contextTokenCount > idleFloorTokens
          ) {
            yield {
              toolName: 'spawn_agent_inline',
              input: {
                agent_type: 'context-pruner',
                params: {
                  maxContextLength,
                  ...(params ?? {}),
                  force: true,
                  ${cacheExpiryParam}
                },
              },
              includeToolCall: false,
            }
          }
        }
      }
      // P3d force ratio: above 0.9 the pruner proceeds even for low-value
      // folds (force: true bypasses the pruner's own gates) rather than
      // risking a hard overflow. 0.8 proactive trigger stays as-is.
      if (agentState.contextTokenCount > maxContextLength * forceRatio) {
        yield {
          toolName: 'spawn_agent_inline',
          input: {
            agent_type: 'context-pruner',
            params: {
              maxContextLength,
              ...(params ?? {}),
              force: true,
              ${cacheExpiryParam}
            },
          },
          includeToolCall: false,
        }
      } else if (agentState.contextTokenCount > maxContextLength * 0.8) {
        yield {
          toolName: 'spawn_agent_inline',
          input: {
            agent_type: 'context-pruner',
            params: {
              maxContextLength,
              ...(params ?? {}),
              ${cacheExpiryParam}
            },
          },
          includeToolCall: false,
        }
      }
      const { stepsComplete } = yield 'STEP'
      if (stepsComplete) {
        // P3a amortized fold: at turn end, fold ONE oldest un-absorbed
        // exchange into the running summary (Hermes pattern) when the fold is
        // enabled and context is above the floor. The pruner no-ops when
        // there is nothing un-absorbed, so early turns are cheap. The turn
        // does not close until this pass finishes (same yield contract).
        if (
          amortizedFold &&
          agentState.contextTokenCount > foldFloorTokens
        ) {
          yield {
            toolName: 'spawn_agent_inline',
            input: {
              agent_type: 'context-pruner',
              params: {
                maxContextLength,
                ...(params ?? {}),
                foldOldestExchange: true,
                ${cacheExpiryParam}
              },
            },
            includeToolCall: false,
          }
        }
        break
      }
    }
  }`
  return eval(`(${source})`) as SavantHandleSteps
}

const handleStepsFree250k = createSavantHandleSteps({
  defaultMaxContextLength: 250_000,
  cacheExpiryMs: 30 * 60 * 1000,
})
const handleStepsFree400k = createSavantHandleSteps({
  defaultMaxContextLength: 400_000,
  cacheExpiryMs: 30 * 60 * 1000,
})
const handleSteps250k = createSavantHandleSteps({
  defaultMaxContextLength: 250_000,
})
const handleSteps400k = createSavantHandleSteps({
  defaultMaxContextLength: 400_000,
})
