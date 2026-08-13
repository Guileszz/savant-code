import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'bun:test'

import { collectHygieneIssues } from './hygiene'

const tempRoots: string[] = []

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

describe('current hygiene scan', () => {
  it('passes the checked-in current source scope', () => {
    expect(collectHygieneIssues()).toEqual([])
  })

  it('rejects an actionable marker in a fixture source file', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'savant-hygiene-'))
    tempRoots.push(root)
    mkdirSync(path.join(root, 'agents'), { recursive: true })
    writeFileSync(
      path.join(root, 'agents', 'unfinished.ts'),
      '// TODO: implement\n',
    )

    expect(collectHygieneIssues(root)).toEqual([
      expect.objectContaining({
        code: 'production-placeholder',
        file: 'agents/unfinished.ts',
      }),
    ])
  })

  it('does not exempt an actionable marker merely because a file has tool vocabulary', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'savant-hygiene-'))
    tempRoots.push(root)
    mkdirSync(path.join(root, 'cli/src/components/tools'), { recursive: true })
    writeFileSync(
      path.join(root, 'cli/src/components/tools/write-todos.tsx'),
      'TODOs\n// TODO: implement\n',
    )

    const issues = collectHygieneIssues(root)
    expect(issues).toHaveLength(1)
    expect(issues[0]?.file).toBe('cli/src/components/tools/write-todos.tsx')
  })
})
