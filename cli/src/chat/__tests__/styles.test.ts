import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, test } from 'bun:test'

import {
  createChatScrollbarOptions,
  createChatSurfaceStyle,
  createSidebarSurfaceStyle,
  SCROLLBOX_STYLE,
} from '../styles'

describe('chat surface styles', () => {
  test('uses one theme-driven base surface for chat and sidebar', () => {
    expect(createChatSurfaceStyle('#050508')).toMatchObject({
      flexGrow: 1,
      backgroundColor: '#050508',
    })
    expect(createSidebarSurfaceStyle('#050508')).toMatchObject({
      width: 40,
      height: '100%',
      flexGrow: 1,
      flexShrink: 0,
      shouldFill: true,
      backgroundColor: '#050508',
    })
  })

  test('uses the Savant palette for the existing chat scrollbar', () => {
    expect(createChatScrollbarOptions('#050508', '#18faf9')).toEqual({
      trackOptions: {
        width: 1,
        backgroundColor: '#050508',
        foregroundColor: '#18faf9',
      },
    })
  })

  test('keeps the chat layout wired to the shared scrollbar contract', () => {
    const panelsSource = readFileSync(
      resolve(import.meta.dir, '..', 'panels.tsx'),
      'utf8',
    )

    expect(panelsSource).toMatch(
      /verticalScrollbarOptions=\{\{[\s\S]*\.\.\.createChatScrollbarOptions\(theme\.background, theme\.primary\),[\s\S]*\}\}/,
    )
  })

  test('keeps the pinned header non-focusable in source', () => {
    const panelsSource = readFileSync(
      resolve(import.meta.dir, '..', 'panels.tsx'),
      'utf8',
    )

    const headerRefIndex = panelsSource.indexOf('ref={headerRef}')
    const headerStart = panelsSource.lastIndexOf('<box', headerRefIndex)
    const headerEnd =
      panelsSource.indexOf('</box>', headerRefIndex) + '</box>'.length
    const headerSource = panelsSource.slice(headerStart, headerEnd)

    expect(headerRefIndex).toBeGreaterThanOrEqual(0)
    expect(headerStart).toBeGreaterThanOrEqual(0)
    expect(headerSource).toContain('focusable={false}')
    expect(headerSource).not.toContain('selectable={false}')
  })

  test('keeps nested scroll wrappers transparent for intentional inheritance', () => {
    expect(SCROLLBOX_STYLE.rootOptions.backgroundColor).toBe('transparent')
    expect(SCROLLBOX_STYLE.wrapperOptions.backgroundColor).toBe('transparent')
    expect(SCROLLBOX_STYLE.contentOptions.backgroundColor).toBe('transparent')
  })
})
