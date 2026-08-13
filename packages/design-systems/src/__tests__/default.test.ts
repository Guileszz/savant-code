import { createHash } from 'node:crypto'

import { describe, expect, test } from 'bun:test'

import {
  DEFAULT_SOURCE,
  contrastRatio,
  getDefaultDesignSystemResource,
} from '../index'

describe('native Savant Cyberpunk design system', () => {
  test('uses the near-black cyan-led semantic palette without violet branding', () => {
    const resource = getDefaultDesignSystemResource()
    const colors = resource.tokens.colors

    expect(colors).toMatchObject({
      primary: '#18faf9',
      secondary: '#18faf9',
      background: '#050508',
      surface: '#0f172a',
      surfaceHover: '#1e293b',
      success: '#39ff14',
      warning: '#ff9500',
      error: '#ff2d55',
      muted: '#94a3b8',
      syntaxKeyword: '#ffb000',
      inlineCodeFg: '#22d3ee',
      listBulletFg: '#39ff14',
    })

    const nativeSemanticColors = [
      colors.secondary,
      colors.syntaxKeyword,
      colors.inlineCodeFg,
      colors.listBulletFg,
    ]
    expect(nativeSemanticColors.join(' ')).not.toMatch(
      /#(?:a78bfa|c084fc|7c3aed)/i,
    )

    const hash = (value: string) =>
      createHash('sha256').update(value, 'utf8').digest('hex')
    const normalizedPayload = JSON.stringify({
      schemaVersion: '1',
      id: 'savant-cyberpunk',
      displayName: 'Savant Cyberpunk',
      description: 'Savant native terminal-first design system.',
      tokens: resource.tokens,
      fonts: [],
      targets: ['terminal', 'react'],
      provenance: resource.provenance,
    })
    expect(resource.sourceContentHash).toBe(hash(DEFAULT_SOURCE))
    expect(resource.normalizedContentHash).toBe(hash(normalizedPayload))

    const requiredPairs = [
      ['#e2e8f0', '#050508'],
      ['#94a3b8', '#050508'],
      ['#18faf9', '#050508'],
      ['#39ff14', '#050508'],
      ['#ff9500', '#050508'],
      ['#ff2d55', '#050508'],
      ['#e2e8f0', '#0f172a'],
      ['#ffb000', '#1e293b'],
      ['#22d3ee', '#1e293b'],
    ] as const
    for (const [foreground, background] of requiredPairs) {
      const ratio = contrastRatio(foreground, background)
      expect({ foreground, background, ratio }).toMatchObject({
        foreground,
        background,
      })
      expect(ratio).toBeGreaterThanOrEqual(4.5)
    }
  })
})
