import { describe, expect, test } from 'bun:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import { initializeThemeStore } from '../../../hooks/use-theme'
import { blendHex, NEON_GREEN, NEON_RED } from '../../../utils/diff-stats'
import { chatThemes } from '../../../utils/theme-system'
import { CopyableBlock } from '../../blocks/copyable-block'
import { DiffStatsBar, DiffViewer } from '../diff-viewer'

initializeThemeStore()

describe('DiffViewer (FID-2026-0804-010)', () => {
  test('tints added rows with the 50% neon-green blend and removed rows with the 50% neon-red blend', () => {
    const diff = '@@ -1,3 +1,3 @@\n const c = 1\n-old\n+new\n'

    const markup = renderToStaticMarkup(<DiffViewer diffText={diff} />)

    const greenBg = blendHex(NEON_GREEN, chatThemes.dark.background, 0.5)
    const redBg = blendHex(NEON_RED, chatThemes.dark.background, 0.5)

    expect(markup).toContain(greenBg)
    expect(markup).toContain(redBg)
    expect(markup).toContain('+new')
    expect(markup).toContain('-old')
    expect(markup).toContain('const c = 1')
  })

  test('does not tint context, hunk, or header rows (no background color emitted)', () => {
    const diff = 'diff --git a/f b/f\n@@ -1 +1 @@\n context\n'
    const markup = renderToStaticMarkup(<DiffViewer diffText={diff} />)

    const greenBg = blendHex(NEON_GREEN, chatThemes.dark.background, 0.5)
    const redBg = blendHex(NEON_RED, chatThemes.dark.background, 0.5)

    expect(markup).not.toContain(greenBg)
    expect(markup).not.toContain(redBg)
    expect(markup).toContain('context')
    expect(markup).toContain('@@')
  })
})

describe('DiffStatsBar (FID-2026-0804-010)', () => {
  test('renders the [-N/+M] counter with removed first', () => {
    const markup = renderToStaticMarkup(<DiffStatsBar removed={5} added={20} />)
    expect(markup).toContain('[-5/+20]')
  })

  test('renders zero/zero', () => {
    const markup = renderToStaticMarkup(<DiffStatsBar removed={0} added={0} />)
    expect(markup).toContain('[-0/+0]')
  })

  test('sits immediately left of the copy button in the CopyableBlock footer row', () => {
    const markup = renderToStaticMarkup(
      <CopyableBlock
        getCopyText={() => 'body text'}
        footerLeft={<DiffStatsBar removed={2} added={3} />}
      >
        <text>diff body</text>
      </CopyableBlock>,
    )

    const bodyIndex = markup.indexOf('diff body')
    const statsIndex = markup.indexOf('[-2/+3]')
    const copyIndex = markup.indexOf('⎘')

    expect(bodyIndex).toBeGreaterThan(-1)
    expect(statsIndex).toBeGreaterThan(-1)
    expect(copyIndex).toBeGreaterThan(-1)
    // Same footer row: body first, counter next, copy button last.
    expect(bodyIndex).toBeLessThan(statsIndex)
    expect(statsIndex).toBeLessThan(copyIndex)
  })
})
