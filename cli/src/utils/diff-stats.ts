/**
 * Diff parsing + tint helpers — FID-2026-0804-010.
 *
 * Pure, renderer-agnostic utilities that power two features:
 * 1. `parseDiffLines` classifies every row of a unified-diff string
 *    (`add` / `remove` / `context` / `hunk` / `header`) and counts the real
 *    added/removed content lines (excluding `+++`/`---` file headers and `@@`
 *    hunks), which feeds the `[-N/+M]` edit-stats counter.
 * 2. `blendHex` computes the "50% opacity" tint. Terminals/OpenTUI cannot
 *    render true alpha, so a 50%-opacity neon overlay on the transparent
 *    backdrop is defined as a 50/50 linear RGB blend with the theme
 *    background — deterministic and unit-testable.
 */

export type DiffLineKind =
  | 'add'
  | 'remove'
  | 'context'
  | 'hunk'
  | 'header'

export interface DiffLine {
  kind: DiffLineKind
  text: string
}

export interface DiffStats {
  lines: DiffLine[]
  /** Count of real added content lines (excludes `+++` headers + `@@` hunks). */
  added: number
  /** Count of real removed content lines (excludes `---` headers + `@@` hunks). */
  removed: number
}

/** Neon green — added-line tint source (FID-2026-0804-010). */
export const NEON_GREEN = '#39ff14'
/** Neon red — removed-line tint source (FID-2026-0804-010). */
export const NEON_RED = '#ff3131'
/** Dark foreground used on the green-tinted add rows for contrast. */
export const DIFF_ADD_FOREGROUND = '#0a3d0a'
/** Dark foreground used on the red-tinted remove rows for contrast. */
export const DIFF_REMOVE_FOREGROUND = '#3d0a0a'

/**
 * Prefixes that mark a unified-diff header row. Checked BEFORE the generic
 * `+`/`-` classification so `+++ b/file` / `--- a/file` never count as
 * additions/removals.
 */
const HEADER_PREFIXES = [
  'diff ',
  'index ',
  'new file ',
  'deleted file ',
  'old mode ',
  'new mode ',
  'similarity index ',
  'rename from ',
  'rename to ',
  'Binary files ',
  '+++',
  '---',
]

/**
 * Parse a unified-diff string into classified rows + add/remove counts.
 *
 * Classification order (first match wins):
 *   header  → diff/index/new-file/+++/---/... prefixes
 *   hunk    → starts with `@@`
 *   add     → starts with `+`
 *   remove  → starts with `-`
 *   context → anything else (including blank lines, preserved as rows)
 *
 * @param diffText - Raw unified diff (`unifiedDiff`/`patch` text).
 */
export function parseDiffLines(diffText: string): DiffStats {
  const lines: DiffLine[] = []
  let added = 0
  let removed = 0

  for (const raw of diffText.split('\n')) {
    let kind: DiffLineKind
    if (HEADER_PREFIXES.some((prefix) => raw.startsWith(prefix))) {
      kind = 'header'
    } else if (raw.startsWith('@@')) {
      kind = 'hunk'
    } else if (raw.startsWith('+')) {
      kind = 'add'
      added += 1
    } else if (raw.startsWith('-')) {
      kind = 'remove'
      removed += 1
    } else {
      kind = 'context'
    }
    lines.push({ kind, text: raw })
  }

  return { lines, added, removed }
}

function parseHex(color: string): { r: number; g: number; b: number } {
  let hex = color.trim().replace(/^#/, '')
  if (hex.length === 3) {
    hex = hex
      .split('')
      .map((ch) => ch + ch)
      .join('')
  }
  // Full-hex regex guard: parseInt would otherwise partially parse malformed
  // 6-char strings (e.g. '12345g' → 0x12345) and return a bogus color.
  if (!/^[0-9a-f]{6}$/i.test(hex)) {
    return { r: 0, g: 0, b: 0 }
  }
  const value = Number.parseInt(hex, 16)
  return {
    r: (value >> 16) & 0xff,
    g: (value >> 8) & 0xff,
    b: value & 0xff,
  }
}

/**
 * Mix two hex colors linearly: `t = 0` yields `a`, `t = 1` yields `b`.
 * `t = 0.5` is the "50% opacity" semantic for overlaying a neon color on the
 * theme background (see module docs). Malformed input degrades to black.
 */
export function blendHex(a: string, b: string, t: number): string {
  const ca = parseHex(a)
  const cb = parseHex(b)
  const clamp = Math.min(1, Math.max(0, t))
  const mix = (x: number, y: number) => Math.round(x + (y - x) * clamp)
  const toHex = (v: number) => v.toString(16).padStart(2, '0')
  return `#${toHex(mix(ca.r, cb.r))}${toHex(mix(ca.g, cb.g))}${toHex(
    mix(ca.b, cb.b),
  )}`
}
