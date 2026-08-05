import { describe, expect, test } from 'bun:test'

import {
  blendHex,
  DIFF_ADD_FOREGROUND,
  DIFF_REMOVE_FOREGROUND,
  NEON_GREEN,
  NEON_RED,
  parseDiffLines,
} from '../diff-stats'

describe('parseDiffLines', () => {
  test('classifies a full unified diff and counts real content lines', () => {
    const diff = [
      'diff --git a/src/foo.ts b/src/foo.ts',
      'index abc123..def456 100644',
      '--- a/src/foo.ts',
      '+++ b/src/foo.ts',
      '@@ -1,3 +1,4 @@',
      ' const unchanged = 1',
      '-const removed = 2',
      '+const added = 2',
      '+const alsoAdded = 3',
      ' const trailing = 4',
    ].join('\n')

    const { lines, added, removed } = parseDiffLines(diff)

    expect(added).toBe(2)
    expect(removed).toBe(1)
    // Header rows: diff/index/---/+++ (4) — none counted as add/remove.
    expect(lines[0].kind).toBe('header')
    expect(lines[1].kind).toBe('header')
    expect(lines[2].kind).toBe('header')
    expect(lines[3].kind).toBe('header')
    // Hunk row.
    expect(lines[4].kind).toBe('hunk')
    // Context rows.
    expect(lines[5].kind).toBe('context')
    expect(lines[9].kind).toBe('context')
    // Content rows.
    expect(lines[6].kind).toBe('remove')
    expect(lines[7].kind).toBe('add')
    expect(lines[8].kind).toBe('add')
  })

  test('counts [-5/+20] from a large edit', () => {
    const removedLines = Array.from({ length: 5 }, (_, i) => `-old${i}`)
    const addedLines = Array.from({ length: 20 }, (_, i) => `+new${i}`)
    const diff = ['@@ -1,5 +1,20 @@', ...removedLines, ...addedLines].join(
      '\n',
    )

    const { added, removed } = parseDiffLines(diff)
    expect(removed).toBe(5)
    expect(added).toBe(20)
  })

  test('never counts +++/--- file headers or @@ hunks as content', () => {
    const { added, removed } = parseDiffLines(
      '+++ b/file.ts\n--- a/file.ts\n@@ -1 +1 @@\n',
    )
    expect(added).toBe(0)
    expect(removed).toBe(0)
  })

  test('classifies new_file/deleted_file headers', () => {
    const created = parseDiffLines('new file mode 100644\n@@ -0,0 +1 @@\n+hi\n')
    expect(created.lines[0].kind).toBe('header')
    expect(created.added).toBe(1)

    const deleted = parseDiffLines(
      'deleted file mode 100644\n@@ -1 +0,0 @@\n-bye\n',
    )
    expect(deleted.lines[0].kind).toBe('header')
    expect(deleted.removed).toBe(1)
  })

  test('handles empty and whitespace-only input', () => {
    const empty = parseDiffLines('')
    expect(empty.lines).toHaveLength(1)
    expect(empty.lines[0].kind).toBe('context')
    expect(empty.added).toBe(0)
    expect(empty.removed).toBe(0)

    const blank = parseDiffLines('\n\n')
    expect(blank.lines).toHaveLength(3)
    expect(blank.lines.every((l) => l.kind === 'context')).toBe(true)
  })

  test('works without a trailing newline', () => {
    const { added, removed, lines } = parseDiffLines('+a\n-b')
    expect(added).toBe(1)
    expect(removed).toBe(1)
    expect(lines).toHaveLength(2)
  })

  test('treats non-diff text as context', () => {
    const { lines, added, removed } = parseDiffLines(
      'const a = 1\nconsole.log(a)\n',
    )
    expect(added).toBe(0)
    expect(removed).toBe(0)
    expect(lines.every((l) => l.kind === 'context')).toBe(true)
  })

  test('a --- prefix is a header, while a -- content removal still classifies as remove', () => {
    // `--- comment` matches the `---` file-header prefix (standard unified
    // diffs emit `--- a/path` headers) — never a removal.
    const header = parseDiffLines('--- comment\n')
    expect(header.removed).toBe(0)
    expect(header.lines[0].kind).toBe('header')

    // `--1` (removed line whose content started with `-`) is NOT a `---`
    // header — two dashes only — so it counts as a removal.
    const removal = parseDiffLines('--1\n')
    expect(removal.removed).toBe(1)
    expect(removal.lines[0].kind).toBe('remove')
  })
})

describe('blendHex', () => {
  test('50/50 blend of neon green over black is #1d800a', () => {
    expect(blendHex(NEON_GREEN, '#000000', 0.5)).toBe('#1d800a')
  })

  test('50/50 blend of neon red over black is #801919', () => {
    expect(blendHex(NEON_RED, '#000000', 0.5)).toBe('#801919')
  })

  test('t=0 returns a, t=1 returns b', () => {
    expect(blendHex('#123456', '#abcdef', 0)).toBe('#123456')
    expect(blendHex('#123456', '#abcdef', 1)).toBe('#abcdef')
  })

  test('supports 3-digit hex input', () => {
    expect(blendHex('#fff', '#000000', 0.5)).toBe('#808080')
  })

  test('clamps t outside [0,1]', () => {
    expect(blendHex('#000000', '#ffffff', -1)).toBe('#000000')
    expect(blendHex('#000000', '#ffffff', 2)).toBe('#ffffff')
  })

  test('malformed input degrades to black', () => {
    expect(blendHex('nope', '#ffffff', 0.5)).toBe('#808080')
    expect(blendHex('#12345', '#000000', 0.5)).toBe('#000000')
  })
})

describe('diff constants', () => {
  test('neon palette and dark foregrounds are exported', () => {
    expect(NEON_GREEN).toBe('#39ff14')
    expect(NEON_RED).toBe('#ff3131')
    expect(DIFF_ADD_FOREGROUND).toBe('#0a3d0a')
    expect(DIFF_REMOVE_FOREGROUND).toBe('#3d0a0a')
  })
})
