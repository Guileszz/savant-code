/**
 * @module echo/fid-validator
 *
 * FID Completeness Validator for the ECHO Harness Enforcement Layer.
 *
 * Checks FID markdown files for structural completeness before
 * allowing creation or status transitions.
 *
 * Required sections (all modes):
 *   Summary, Environment, Detailed Description, Impact Assessment,
 *   Proposed Solution, Perfection Loop, Resolution, Lessons Learned
 *
 * Additional required sections (strict mode):
 *   Unanswered Questions (minimum MIN_UNANSWERED_QUESTIONS)
 *
 * Also checks for placeholder text ([pending], TODO, TBD).
 */

import type { FidValidationResult } from './types'

/** Sections required in every FID, regardless of mode. */
const REQUIRED_SECTIONS = [
  '## Summary',
  '## Environment',
  '## Detailed Description',
  '## Impact Assessment',
  '## Proposed Solution',
  '## Perfection Loop',
  '## Resolution',
  '## Lessons Learned',
]

/** Additional sections required in strict mode. */
const STRICT_SECTIONS = ['### Unanswered Questions']

/** Minimum number of unanswered questions in strict mode. */
const MIN_UNANSWERED_QUESTIONS = 2

/** Pattern matching placeholder text that should not appear in FIDs. */
const PLACEHOLDER_PATTERN = /\[pending\]|\bTODO\b|\bTBD\b|\[TBD\]/gi

/**
 * Validate a FID file's structural completeness.
 *
 * @param content  - The full markdown content of the FID file.
 * @param tier     - Enforcement tier ('core_4' for hybrid, 'all_15' for strict).
 * @returns FidValidationResult with errors array (empty if valid).
 */
export function validateFid(
  content: string,
  tier: 'core_4' | 'all_15',
): FidValidationResult {
  const errors: string[] = []

  // ── Required sections (all modes) ───────────────────────────────────
  for (const section of REQUIRED_SECTIONS) {
    if (!content.includes(section)) {
      errors.push(`Missing required section: ${section}`)
    }
  }

  // ── Strict-mode sections ────────────────────────────────────────────
  if (tier === 'all_15') {
    for (const section of STRICT_SECTIONS) {
      if (!content.includes(section)) {
        errors.push(`Missing strict-mode section: ${section}`)
      }
    }

    // Check Unanswered Questions has minimum question count
    const uqMatch = content.match(
      /### Unanswered Questions[\s\S]*?(?=### |## |$)/,
    )
    if (uqMatch) {
      const questionCount = (uqMatch[0].match(/^\d+\./gm) ?? []).length
      if (questionCount < MIN_UNANSWERED_QUESTIONS) {
        errors.push(
          `Unanswered Questions has ${questionCount} questions ` +
            `(minimum is ${MIN_UNANSWERED_QUESTIONS})`,
        )
      }
    }
  }

  // ── Placeholder detection ───────────────────────────────────────────
  const matches = content.match(PLACEHOLDER_PATTERN)
  if (matches && matches.length > 0) {
    const unique = [...new Set(matches.map((m) => m.toUpperCase()))]
    errors.push(`Contains placeholder text: ${unique.join(', ')}`)
  }

  return { valid: errors.length === 0, errors }
}

/**
 * Check whether a file path targets a FID file.
 *
 * @param path - The file path to check.
 * @returns true if the path matches the FID naming convention.
 */
export function isFidFile(path: string): boolean {
  return /dev\/fids\/FID-[\w.-]+\.md$/.test(path)
}
