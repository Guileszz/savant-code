import { describe, expect, test } from 'bun:test'

import { contrastRatio } from '../index'

const REQUIRED_PAIRS = [
  ['foreground/background', '#e2e8f0', '#050508'],
  ['muted/background', '#94a3b8', '#050508'],
  ['primary/background', '#18faf9', '#050508'],
  ['success/background', '#39ff14', '#050508'],
  ['warning/background', '#ff9500', '#050508'],
  ['error/background', '#ff2d55', '#050508'],
  ['foreground/surface', '#e2e8f0', '#0f172a'],
  ['muted/surface', '#94a3b8', '#0f172a'],
  ['keyword/code-surface', '#ffb000', '#1e293b'],
  ['inline-code/code-surface', '#22d3ee', '#1e293b'],
  ['function/code-surface', '#60a5fa', '#1e293b'],
  ['string/code-surface', '#4ade80', '#1e293b'],
  ['number/code-surface', '#fbbf24', '#1e293b'],
  ['diff-added/background', '#7ACC35', '#050508'],
  ['diff-removed/background', '#BF6C69', '#050508'],
] as const

describe('native dark contrast acceptance artifact', () => {
  test('all required normal/status pairs meet WCAG AA', () => {
    const measurements = REQUIRED_PAIRS.map(
      ([name, foreground, background]) => {
        const ratio = contrastRatio(foreground, background)
        return { name, foreground, background, ratio: Number(ratio.toFixed(2)) }
      },
    )

    // The structured value records the exact pair and measured ratio in a
    // failing Bun assertion, making the audit artifact actionable.
    expect(measurements.every(({ ratio }) => ratio >= 4.5)).toBe(true)
  })
})
