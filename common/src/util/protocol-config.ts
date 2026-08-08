import fs from 'fs'
import path from 'path'

export interface SavantProtocolConfig {
  version: string
  strictMode: boolean
}

/** Token-optimization settings (FID-2026-0806-003, design doc §5). */
export interface ProtocolCompressionConfig {
  enabled: boolean
  /** P3a per-turn folding — off by default (breaks the prompt-cache prefix). */
  microCompact: boolean
  /** P2a fixed verbatim recent-tail token budget. */
  keepRecentTokens: number
  /** P3d auto-compact trigger ratio. */
  autoCompactRatio: number
  /** P3d force-compact trigger ratio. */
  forceCompactRatio: number
  /** P3c idle compaction — off by default. */
  idleCompaction: {
    enabled: boolean
    idleAfterSeconds: number
    floorTokens: number
  }
  /** Dedicated summarization model override (OpenClaw pattern); null = parent model. */
  model: string | null
  /** P1a summary contract. */
  summary: {
    requiredSections: boolean
    exactIdentifiers: 'strict' | 'normal'
  }
}

/** YAGNI enforcement settings (P5b/P5c). */
export interface ProtocolYagniConfig {
  /** P5b — Forge `yagni_check` gate active. */
  enforced: boolean
  /** P5c — ponytail-debt ledger path relative to the project root. */
  ledger: string
}

/** P5f — Caveman telegraphic output rules (opt-in). */
export interface ProtocolCavemanConfig {
  enabled: boolean
  /** Auto-Clarity bypass: code, paths, errors, security warnings stay byte-exact. */
  autoClarity: boolean
}

/** P4 — token telemetry + cache-hit monitoring. */
export interface ProtocolTelemetryConfig {
  enabled: boolean
  /** Alert when the cached-token ratio drops this many points (e.g. 0.3 = 30). */
  cacheHitAlertDrop: number
}

export interface ProtocolConfig {
  strictMode: boolean
  language: string | null
  openFids: string[]
  /** Perfection-loop circuit breaker limit from `perfection_loop.max_iterations`. */
  maxIterations: number
  savant: SavantProtocolConfig | null
  /** Token-optimization settings (FID-2026-0806-003). */
  compression: ProtocolCompressionConfig
  /** YAGNI enforcement settings (FID-2026-0806-003 P5b/P5c). */
  yagni: ProtocolYagniConfig
  /** P5f Caveman telegraphic output rules (opt-in). */
  caveman: ProtocolCavemanConfig
  /** P4 token telemetry + cache-hit monitoring. */
  telemetry: ProtocolTelemetryConfig
}

const DEFAULT_COMPRESSION: ProtocolCompressionConfig = {
  enabled: true,
  microCompact: false,
  keepRecentTokens: 16_384,
  autoCompactRatio: 0.8,
  forceCompactRatio: 0.9,
  idleCompaction: {
    enabled: false,
    idleAfterSeconds: 1_800,
    floorTokens: 40_000,
  },
  model: null,
  summary: {
    requiredSections: true,
    exactIdentifiers: 'strict',
  },
}

const DEFAULT_YAGNI: ProtocolYagniConfig = {
  enforced: true,
  ledger: 'dev/YAGNI-LEDGER.md',
}

const DEFAULT_CAVEMAN: ProtocolCavemanConfig = {
  enabled: false,
  autoClarity: true,
}

const DEFAULT_TELEMETRY: ProtocolTelemetryConfig = {
  enabled: true,
  cacheHitAlertDrop: 0.3,
}

function extractYamlSection(
  lines: string[],
  key: string,
  indentation: number,
): string[] {
  const header = `${key}:`
  const start = lines.findIndex(
    (line) =>
      line.trim() === header &&
      line.length - line.trimStart().length === indentation,
  )
  if (start === -1) return []

  const section: string[] = []
  for (const line of lines.slice(start + 1)) {
    if (line.trim() === '') {
      section.push(line)
      continue
    }
    const lineIndentation = line.length - line.trimStart().length
    if (lineIndentation <= indentation) break
    section.push(line)
  }
  return section
}

/**
 * Reads protocol.config.yaml from the project root.
 * Returns parsed config with defaults for the Savant protocol contract.
 */
export function readProtocolConfig(cwd: string): ProtocolConfig {
  let strictMode = true
  let language: string | null = null
  let maxIterations = 10
  let savant: SavantProtocolConfig | null = null
  const compression: ProtocolCompressionConfig = {
    ...DEFAULT_COMPRESSION,
    idleCompaction: { ...DEFAULT_COMPRESSION.idleCompaction },
    summary: { ...DEFAULT_COMPRESSION.summary },
  }
  const yagni: ProtocolYagniConfig = { ...DEFAULT_YAGNI }
  const caveman: ProtocolCavemanConfig = { ...DEFAULT_CAVEMAN }
  const telemetry: ProtocolTelemetryConfig = { ...DEFAULT_TELEMETRY }

  try {
    const configPath = path.join(cwd, 'protocol.config.yaml')
    const content = fs.readFileSync(configPath, 'utf8')
    const lines = content.split(/\r?\n/)

    const protocolLines = extractYamlSection(lines, 'protocol', 0)
    const protocolStrictMatch = protocolLines
      .join('\n')
      .match(/^\s+strict_mode:\s*(true|false)/m)
    if (protocolStrictMatch) {
      strictMode = protocolStrictMatch[1] === 'true'
    }

    // perfection_loop.max_iterations drives the FSM circuit breaker
    // (transition-phase.ts). FID-2026-0803-001 ECHO-3.
    const perfectionLoopLines = extractYamlSection(lines, 'perfection_loop', 0)
    const maxIterationsMatch = perfectionLoopLines
      .join('\n')
      .match(/^\s+max_iterations:\s*(\d+)/m)
    if (maxIterationsMatch) {
      const parsed = Number.parseInt(maxIterationsMatch[1], 10)
      if (Number.isFinite(parsed) && parsed > 0) {
        maxIterations = parsed
      }
    }

    // Single-agent protocol documents use `single_agent.protocol`. Normalize
    // that contract into the Savant runtime shape while also accepting the
    // forward-looking `savant.protocol` alias.
    const singleAgentLines = extractYamlSection(lines, 'single_agent', 0)
    const savantLines = extractYamlSection(lines, 'savant', 0)
    const singleAgentProtocolLines = extractYamlSection(
      singleAgentLines,
      'protocol',
      2,
    )
    const savantProtocolLines = extractYamlSection(savantLines, 'protocol', 2)
    const protocolContractLines =
      savantProtocolLines.length > 0
        ? savantProtocolLines
        : singleAgentProtocolLines
    const savantVersionMatch = protocolContractLines
      .join('\n')
      .match(/^\s+version:\s*["']([^"']+)["']/m)
    const savantStrictMatch = protocolContractLines
      .join('\n')
      .match(/^\s+strict_mode:\s*(true|false)/m)
    if (savantVersionMatch && savantStrictMatch) {
      savant = {
        version: savantVersionMatch[1],
        strictMode: savantStrictMatch[1] === 'true',
      }
    }

    const langMatch = lines
      .map((line) => line.match(/^language:\s*["']([^"']+)["']/))
      .find((match): match is RegExpMatchArray => match !== null)
    if (langMatch && langMatch[1] !== 'CHANGE_ME') {
      language = langMatch[1]
    }

    // Token-optimization settings (FID-2026-0806-003, design doc §5). All
    // keys are optional — missing keys keep the defaults above, so old configs
    // and configs that only override one field behave predictably.
    const compressionLines = extractYamlSection(lines, 'compression', 0)
    const compressionText = compressionLines.join('\n')
    const parseBool = (text: string, key: string): boolean | undefined => {
      const match = text.match(new RegExp(`^\\s+${key}:\\s*(true|false)`, 'm'))
      return match ? match[1] === 'true' : undefined
    }
    const parseNumber = (text: string, key: string): number | undefined => {
      const match = text.match(new RegExp(`^\\s+${key}:\\s*([0-9.]+)`, 'm'))
      return match ? Number.parseFloat(match[1]) : undefined
    }
    const parseString = (text: string, key: string): string | undefined => {
      const match = text.match(
        new RegExp(`^\\s+${key}:\\s*["']?([^#\\s"']+)["']?`, 'm'),
      )
      return match ? match[1] : undefined
    }
    const boolOr = (v: boolean | undefined, d: boolean): boolean => v ?? d

    if (compressionLines.length > 0) {
      const enabled = parseBool(compressionText, 'enabled')
      const microCompact = parseBool(compressionText, 'microCompact')
      const keepRecentTokens = parseNumber(compressionText, 'keepRecentTokens')
      const autoCompactRatio = parseNumber(compressionText, 'autoCompactRatio')
      const forceCompactRatio = parseNumber(
        compressionText,
        'forceCompactRatio',
      )
      const model = parseString(compressionText, 'model')
      compression.enabled = boolOr(enabled, compression.enabled)
      compression.microCompact = boolOr(microCompact, compression.microCompact)
      if (keepRecentTokens !== undefined) {
        compression.keepRecentTokens = keepRecentTokens
      }
      if (autoCompactRatio !== undefined) {
        compression.autoCompactRatio = autoCompactRatio
      }
      if (forceCompactRatio !== undefined) {
        compression.forceCompactRatio = forceCompactRatio
      }
      if (model !== undefined) {
        compression.model = model
      }

      const idleLines = extractYamlSection(
        compressionLines,
        'idleCompaction',
        2,
      )
      const idleText = idleLines.join('\n')
      if (idleLines.length > 0) {
        compression.idleCompaction.enabled = boolOr(
          parseBool(idleText, 'enabled'),
          compression.idleCompaction.enabled,
        )
        const idleAfterSeconds = parseNumber(idleText, 'idleAfterSeconds')
        if (idleAfterSeconds !== undefined) {
          compression.idleCompaction.idleAfterSeconds = idleAfterSeconds
        }
        const floorTokens = parseNumber(idleText, 'floorTokens')
        if (floorTokens !== undefined) {
          compression.idleCompaction.floorTokens = floorTokens
        }
      }

      const summaryLines = extractYamlSection(compressionLines, 'summary', 2)
      const summaryText = summaryLines.join('\n')
      if (summaryLines.length > 0) {
        compression.summary.requiredSections = boolOr(
          parseBool(summaryText, 'requiredSections'),
          compression.summary.requiredSections,
        )
        const exactIdentifiers = parseString(summaryText, 'exactIdentifiers')
        if (exactIdentifiers === 'strict' || exactIdentifiers === 'normal') {
          compression.summary.exactIdentifiers = exactIdentifiers
        }
      }
    }

    const yagniLines = extractYamlSection(lines, 'yagni', 0)
    const yagniText = yagniLines.join('\n')
    if (yagniLines.length > 0) {
      yagni.enforced = boolOr(parseBool(yagniText, 'enforced'), yagni.enforced)
      const ledger = parseString(yagniText, 'ledger')
      if (ledger !== undefined) {
        yagni.ledger = ledger
      }
    }

    const cavemanLines = extractYamlSection(lines, 'caveman', 0)
    const cavemanText = cavemanLines.join('\n')
    if (cavemanLines.length > 0) {
      caveman.enabled = boolOr(
        parseBool(cavemanText, 'enabled'),
        caveman.enabled,
      )
      caveman.autoClarity = boolOr(
        parseBool(cavemanText, 'autoClarity'),
        caveman.autoClarity,
      )
    }

    const telemetryLines = extractYamlSection(lines, 'telemetry', 0)
    const telemetryText = telemetryLines.join('\n')
    if (telemetryLines.length > 0) {
      telemetry.enabled = boolOr(
        parseBool(telemetryText, 'enabled'),
        telemetry.enabled,
      )
      const cacheHitAlertDrop = parseNumber(telemetryText, 'cacheHitAlertDrop')
      if (cacheHitAlertDrop !== undefined) {
        telemetry.cacheHitAlertDrop = cacheHitAlertDrop
      }
    }
  } catch {
    // File doesn't exist or can't be read — use defaults
  }

  const openFids = scanOpenFids(cwd)

  return {
    strictMode,
    language,
    openFids,
    maxIterations,
    savant,
    compression,
    yagni,
    caveman,
    telemetry,
  }
}

/**
 * Scans dev/fids/ for open FID files (FID-*.md, not in archive/).
 * Exported for direct use by the FSM transition handler to avoid
 * re-reading protocol.config.yaml on every transition.
 */
export function scanOpenFids(cwd: string): string[] {
  const fidsDir = path.join(cwd, 'dev', 'fids')
  try {
    const entries = fs.readdirSync(fidsDir)
    return entries.filter(
      (entry) =>
        entry.startsWith('FID-') &&
        entry.endsWith('.md') &&
        !entry.includes('archive'),
    )
  } catch {
    return []
  }
}
