/**
 * ECHO Harness Enforcement Layer (EHEL) — shared types.
 *
 * FID-2026-0805-007: Structural enforcement of ECHO laws at the tool
 * middleware level. Enforcement severity is driven by the existing
 * Hybrid/Strict mode system — no separate config flag.
 */

export type EnforcementMode = 'hybrid' | 'strict'

export type EnforcementTier = 'core_4' | 'all_15'

export interface EnforcementState {
  // Law 1: Read tracking
  filesRead: Set<string>
  filesWritten: Set<string>

  // Law 3: Verification gate
  dirtyFiles: Set<string>
  hasVerifiedSinceLastDirty: boolean
  writeCount: number

  // Law 4: Call-graph tracking
  featuresWired: Set<string>
  featuresVerified: Set<string>

  // Law 7: Search tracking (since entering GREEN)
  hasSearchedSinceGreen: boolean

  // Law 8: Intent logged
  intentLogged: boolean

  // FID tracking
  fidFilesWritten: Set<string>

  // FID-2026-0806-005 Layer 1/2: session-init protocol gate state and the
  // turn counter driving the 15-turn protocol refresh.
  protocolRead: boolean
  turnCount: number

  // Advisory violations (Hybrid mode)
  advisoryWarnings: AdvisoryWarning[]

  // Turn-end batch scanner state
  turnStartWriteCount: number

  // P5b (FID-2026-0806-003): YAGNI enforcement state. The Forge emits a
  // `yagni_check` JSON block before writing; the pre-write gate records its
  // verdict here so a speculative write WITHOUT a documented debt marker is
  // blocked, and the Verifier's YAGNI Assessment can audit the record.
  yagni: {
    lastAssessment: {
      isSpeculative: boolean
      reusedEntities: string[]
      debtMarkersInserted: string[]
    } | null
    speculativeWritesRejected: number
  }
}

export interface AdvisoryWarning {
  law: number
  severity: 'info' | 'warning'
  message: string
  file?: string
  line?: number
}

export interface Violation {
  law: number
  message: string
  blocked: boolean
  file?: string
}

export interface EnforcementResult {
  blocked: boolean
  reason?: string
  warnings: AdvisoryWarning[]
}

export interface FidValidationResult {
  valid: boolean
  errors: string[]
}
