import type { Logger } from '@savant-code/common/types/contracts/logger'
import type { Message } from '@savant-code/common/types/messages/savant-code-message'

export interface CompactorOptions {
  logger: Logger
  contextWindow?: number
  model?: string
}

export interface Thresholds {
  /** Token count at which auto-compact triggers */
  autoCompact: number
  /** Token count at which reactive compact triggers (hard limit) */
  reactiveCompact: number
  /** Max messages to keep in micro-compact */
  microCompactMaxKeepRecent: number
}

export interface MicroCompactResult {
  messages: Message[]
  tokensSaved: number
  messagesCleared: number
}

export interface AutoCompactCheck {
  shouldCompact: boolean
  reason?: string
  percentUsed?: number
}

export interface ReactiveCompactResult {
  truncated: boolean
  messages: Message[]
  tokensSaved: number
  messagesRemoved: number
}

/**
 * Circuit breaker states for compaction failures.
 */
export type CircuitState = 'healthy' | 'degraded' | 'open' | 'half-open'

export const CIRCUIT_BREAKER_MAX_FAILURES = 3
export const CIRCUIT_BREAKER_COOLDOWN_MS = 5 * 60 * 1000 // 5 minutes
export const AUTO_COMPACT_BUFFER = 30_000 // 30k token buffer before hard limit
