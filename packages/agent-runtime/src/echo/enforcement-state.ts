/**
 * ECHO Harness Enforcement Layer (EHEL) — enforcement state management.
 *
 * FID-2026-0805-007: Creates and manages per-conversation enforcement
 * state. Each conversation gets its own state instance, reset at turn
 * boundaries for batch scanning.
 */

import type { EnforcementState } from './types'

/**
 * Create a fresh enforcement state for a new conversation.
 */
export function createEnforcementState(): EnforcementState {
  return {
    filesRead: new Set(),
    filesWritten: new Set(),
    dirtyFiles: new Set(),
    hasVerifiedSinceLastDirty: true,
    writeCount: 0,
    featuresWired: new Set(),
    featuresVerified: new Set(),
    hasSearchedSinceGreen: false,
    intentLogged: false,
    fidFilesWritten: new Set(),
    // FID-2026-0806-005: session-init gate starts unread; turns start at 0.
    protocolRead: false,
    turnCount: 0,
    advisoryWarnings: [],
    turnStartWriteCount: 0,
    // P5b (FID-2026-0806-003): YAGNI enforcement state, initially empty.
    yagni: {
      lastAssessment: null,
      speculativeWritesRejected: 0,
    },
  }
}

/**
 * Reset turn-specific counters at the start of a new turn.
 * Preserves cross-turn state (filesRead, filesWritten, etc.).
 */
export function resetForNewTurn(state: EnforcementState): void {
  state.turnStartWriteCount = state.writeCount
}
