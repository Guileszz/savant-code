import * as path from 'node:path'

import { AdvisoryLogger } from './advisory-logger'
import { createEnforcementState, resetForNewTurn } from './enforcement-state'
import { evaluateLaw4TurnEnd } from './law4-turn-end'
import { runPostWriteScanners } from './post-write-scanners'
import { runPreWriteGates } from './pre-write-gates'
import {
  buildProtocolRefreshSummary,
  PROTOCOL_REFRESH_INTERVAL,
} from './protocol-summary'
import { buildSteeringText, formatTurnEndReport } from './violation-handler'

import type {
  AdvisoryWarning,
  EnforcementMode,
  EnforcementResult,
} from './types'

function getTier(mode: EnforcementMode): 'core_4' | 'all_15' {
  return mode === 'strict' ? 'all_15' : 'core_4'
}

export interface EchoEnforcementOptions {
  /** Protocol file the session-init gate requires (default `ECHO.md`). */
  protocolFile?: string
  /**
   * FID-2026-0806-005: seed the session-init gate as already satisfied.
   * Subagents spawned by a compliant parent inherit the parent's read.
   */
  protocolPreSeeded?: boolean
}

export class EchoEnforcement {
  private state = createEnforcementState()
  private logger = new AdvisoryLogger()
  private mode: EnforcementMode
  private requiredProtocolFile: string

  // Steering budget (mirrors the tracker's FID-2026-0804-009 budgeting): a
  // blocked pre-write advisory (Law 7/8) collects corrective text that the
  // tool executor injects into the agent's message history so the running
  // agent knows what to do next — bounded, deduped per law+file, so a
  // non-compliant agent is nudged a couple of times, never looped.
  private pendingSteering: AdvisoryWarning[] = []
  private steeredKeys = new Set<string>()
  private steeringCount = 0
  private readonly steeringPerLaw = new Map<number, number>()

  // With the current per-law caps (7:1, 8:1) the practical maximum is two
  // steers per instance; MAX_STEERING_TOTAL is a defensive ceiling should a
  // future advisory law carry a larger per-law budget.
  private static readonly MAX_STEERING_TOTAL = 3
  private static readonly MAX_STEERING_PER_LAW: Record<number, number> = {
    7: 1,
    8: 1,
  }

  constructor(mode: EnforcementMode, options: EchoEnforcementOptions = {}) {
    this.mode = mode
    this.requiredProtocolFile = options.protocolFile ?? 'ECHO.md'
    // FID-2026-0806-005: subagents inherit the parent's protocol read.
    if (options.protocolPreSeeded === true) {
      this.state.protocolRead = true
    }
  }

  beforeToolCall(params: {
    toolName: string
    input: Record<string, unknown>
    agentId: string
  }): EnforcementResult {
    const tier = getTier(this.mode)

    // FID-2026-0806-005 Layer 1: session-init protocol gate (strict mode).
    // Until the governing protocol file has been read 0-EOF, only read-only
    // context tools, intent logging, and clarification are allowed. The gate
    // clears when a read targets the protocol file (normalized basename match).
    if (!this.state.protocolRead && tier === 'all_15') {
      if (this.isProtocolReadCall(params.toolName, params.input)) {
        this.state.protocolRead = true
      } else if (!this.isPreReadAllowed(params.toolName)) {
        return {
          blocked: true,
          reason: `Must read ${this.requiredProtocolFile} 0-EOF before using tools`,
          warnings: [],
        }
      }
    }

    // Track reads for Law 1
    if (
      params.toolName === 'read_files' ||
      params.toolName === 'read_subtree'
    ) {
      const paths = this.extractPaths(params.input)
      for (const p of paths) {
        this.state.filesRead.add(p)
      }
    }

    // Track searches for Law 7
    if (
      params.toolName === 'glob' ||
      params.toolName === 'code_search' ||
      params.toolName === 'list_directory' ||
      params.toolName === 'detective' ||
      params.toolName === 'scout'
    ) {
      this.state.hasSearchedSinceGreen = true
    }

    // Track intent logging for Law 8
    if (params.toolName === 'write_todos' || params.toolName === 'ask_user') {
      this.state.intentLogged = true
    }

    // Track verification for Law 3
    if (params.toolName === 'run_terminal_command') {
      this.state.hasVerifiedSinceLastDirty = true
    }

    // Track FID file writes
    const targetPath = this.getTargetPath(params.input)
    if (
      (params.toolName === 'write_file' || params.toolName === 'str_replace') &&
      targetPath != null &&
      this.isFidFile(targetPath)
    ) {
      this.state.fidFilesWritten.add(targetPath)
    }

    // Run pre-write gates for write tools
    if (this.isWriteTool(params.toolName)) {
      const result = runPreWriteGates({
        toolName: params.toolName,
        input: params.input,
        agentId: params.agentId,
        state: this.state,
        mode: this.mode,
        tier,
      })

      // Any advisory attached to a gate result (Law 7/8) also becomes
      // corrective steering — the tool executor drains it via
      // takeSteeringMessages() and injects it into the agent's history.
      if (result.warnings.length > 0) {
        this.pendingSteering.push(...result.warnings)
      }

      if (result.blocked) {
        return result
      }

      if (result.warnings.length > 0) {
        this.logger.logBatch(result.warnings)
        this.state.advisoryWarnings.push(...result.warnings)
      }
      // Return the warnings so the tool executor can emit them as
      // compliance_warning receipts (the state.advisoryWarnings copy above
      // remains the internal audit trail). Previously they were swallowed,
      // making the executor's advisory emission unreachable.
      return { blocked: false, warnings: result.warnings }
    }

    return { blocked: false, warnings: [] }
  }

  afterToolCall(params: {
    toolName: string
    input: Record<string, unknown>
    result: { text?: string; error?: string }
  }): EnforcementResult {
    // Record write
    if (this.isWriteTool(params.toolName)) {
      const path = this.getTargetPath(params.input)
      if (path) {
        this.state.filesWritten.add(path)
        this.state.dirtyFiles.add(path)
        this.state.hasVerifiedSinceLastDirty = false
        this.state.writeCount++

        // Check for export statements (Law 4 wiring)
        const content =
          (params.input.content as string) ??
          (params.input.newString as string) ??
          ''
        if (/export\s+(default\s+)?/.test(content)) {
          this.state.featuresWired.add(path)
        }
      }
    }

    // Track verification commands for Law 3
    if (params.toolName === 'run_terminal_command') {
      const cmd = (params.input.command as string) ?? ''
      if (
        cmd.includes('typecheck') ||
        cmd.includes('lint') ||
        cmd.includes('eslint') ||
        cmd.includes('test')
      ) {
        this.state.hasVerifiedSinceLastDirty = true
        this.state.dirtyFiles.clear()
      }
    }

    // Track grep/search for Law 4 (call-graph verification)
    if (
      params.toolName === 'code_search' ||
      params.toolName === 'run_terminal_command'
    ) {
      const pattern = (params.input.pattern as string) ?? ''
      const cmd = (params.input.command as string) ?? ''
      if (
        pattern.includes('grep') ||
        cmd.includes('grep') ||
        cmd.includes('find')
      ) {
        for (const wired of this.state.featuresWired) {
          this.state.featuresVerified.add(wired)
        }
      }
    }

    return { blocked: false, warnings: [] }
  }

  evaluateTurnEnd(): { blocked: boolean; report: string } {
    const tier = getTier(this.mode)
    const results: EnforcementResult[] = []

    // Law 4: call-graph reachability
    results.push(
      evaluateLaw4TurnEnd({
        state: this.state,
        mode: this.mode,
        tier,
      }),
    )

    // Law 15: build stays clean
    if (
      !this.state.hasVerifiedSinceLastDirty &&
      this.state.dirtyFiles.size > 0
    ) {
      if (tier === 'all_15') {
        results.push({
          blocked: true,
          reason:
            'Law 15: Files modified without verification (typecheck/lint)',
          warnings: [],
        })
      } else {
        results.push({
          blocked: false,
          warnings: [
            {
              law: 15,
              severity: 'warning',
              message: 'Files modified without running typecheck/lint',
            },
          ],
        })
      }
    }

    // Post-write scanners (Strict mode only)
    if (tier === 'all_15') {
      results.push(
        runPostWriteScanners({
          state: this.state,
          mode: this.mode,
          tier,
          getWrittenFileContent: () => undefined,
        }),
      )
    }

    const blocked = results.some((r) => r.blocked)
    const report = formatTurnEndReport(results)

    // Reset for next turn
    resetForNewTurn(this.state)
    this.state.hasSearchedSinceGreen = false
    this.state.intentLogged = false

    return { blocked, report }
  }

  /**
   * FID-2026-0806-005 Layer 2: called once per main-agent loop iteration.
   * Increments the turn counter and, every 15 turns, returns a condensed
   * protocol summary (carrying the critical-context sentinel) for the loop to
   * re-inject into the message history. Only fires after the protocol has
   * been read at session init.
   */
  onStepBoundary(): { refreshText?: string } {
    this.state.turnCount++
    if (
      this.state.protocolRead &&
      this.state.turnCount % PROTOCOL_REFRESH_INTERVAL === 0
    ) {
      return { refreshText: buildProtocolRefreshSummary() }
    }
    return {}
  }

  private isProtocolReadCall(
    toolName: string,
    input: Record<string, unknown>,
  ): boolean {
    if (toolName !== 'read_files' && toolName !== 'read_subtree') {
      return false
    }
    const target = path.basename(this.requiredProtocolFile).toLowerCase()
    return this.extractPaths(input).some((p) => {
      const base = path.basename(String(p)).toLowerCase()
      return base === target || base === `${target}.md`
    })
  }

  private isPreReadAllowed(toolName: string): boolean {
    return (
      toolName === 'read_files' ||
      toolName === 'read_subtree' ||
      toolName === 'ask_user' ||
      toolName === 'write_todos'
    )
  }

  /**
   * Drain budgeted corrective steering messages for blocked pre-write
   * advisories (Law 7/8). Bounded per enforcement instance: at most
   * MAX_STEERING_TOTAL messages total, one per law (deduped per law+file).
   */
  takeSteeringMessages(): string[] {
    const messages: string[] = []
    for (const warning of this.pendingSteering) {
      if (this.steeringCount >= EchoEnforcement.MAX_STEERING_TOTAL) break
      const key = `${warning.law}:${warning.file ?? ''}`
      if (this.steeredKeys.has(key)) continue
      const perLaw = this.steeringPerLaw.get(warning.law) ?? 0
      const cap = EchoEnforcement.MAX_STEERING_PER_LAW[warning.law] ?? 1
      if (perLaw >= cap) continue
      this.steeredKeys.add(key)
      this.steeringPerLaw.set(warning.law, perLaw + 1)
      this.steeringCount += 1
      messages.push(buildSteeringText(warning))
    }
    this.pendingSteering = []
    return messages
  }

  getState(): Readonly<ReturnType<typeof createEnforcementState>> {
    return this.state
  }

  getMode(): EnforcementMode {
    return this.mode
  }

  setMode(mode: EnforcementMode): void {
    this.mode = mode
  }

  private isWriteTool(toolName: string): boolean {
    return (
      toolName === 'write_file' ||
      toolName === 'str_replace' ||
      toolName === 'apply_patch'
    )
  }

  private isFidFile(path: string): boolean {
    return /dev\/fids\/FID-[\w.-]+\.md$/.test(path)
  }

  private getTargetPath(input: Record<string, unknown>): string | undefined {
    return input.path as string | undefined
  }

  private extractPaths(input: Record<string, unknown>): string[] {
    if (Array.isArray(input.paths))
      return input.paths.filter((p): p is string => typeof p === 'string')
    if (typeof input.path === 'string') return [input.path]
    return []
  }
}
