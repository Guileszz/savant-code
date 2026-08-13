import { describe, expect, test } from 'bun:test'

import { runDesignContractScanner } from '../design-contract'
import { createEnforcementState } from '../enforcement-state'

import type { DesignContract } from '@savant-code/common/types/design-system'

describe('design contract scanner', () => {
  const contract: DesignContract = {
    id: 'demo',
    displayName: 'Demo',
    targets: ['react'],
    colors: { primary: '#00ff00' },
    typography: { body: { fontFamily: 'Inter, sans-serif' } },
    spacing: { sm: '8px' },
    radius: { sm: '4px' },
    components: {},
    accessibility: { requiredTokens: ['aria-label'] },
  }

  test('ignores colors in prose and comments but scans color declarations', () => {
    const state = createEnforcementState()
    state.dirtyFiles.add('src/App.tsx')
    state.writtenFileContent.set(
      'src/App.tsx',
      '// #ff0000\nconst note = "#ff0000"\nconst style = { color: "#ff0000" }',
    )
    const result = runDesignContractScanner({
      state,
      mode: 'strict',
      contract,
      getWrittenFileContent: (filePath) =>
        state.writtenFileContent.get(filePath),
    })
    expect(result.blocked).toBe(true)
    expect(result.reason).toContain('colors')
  })

  test('flags colors outside the active contract', () => {
    const state = createEnforcementState()
    state.dirtyFiles.add('src/App.tsx')
    state.writtenFileContent.set('src/App.tsx', 'const color = "#ff0000"')
    const result = runDesignContractScanner({
      state,
      mode: 'strict',
      contract,
      getWrittenFileContent: (filePath) =>
        state.writtenFileContent.get(filePath),
    })
    expect(result.blocked).toBe(true)
    expect(result.classification).toBe('design_contract')
    expect(result.warnings[0]?.classification).toBe('design_contract')
  })

  test('allows supported typography and ignores unrelated dimensions', () => {
    const state = createEnforcementState()
    state.dirtyFiles.add('src/App.tsx')
    state.writtenFileContent.set(
      'src/App.tsx',
      'font-family: Inter; width: 12px; height: 6px; padding: 8px 8px; aria-label="Demo";',
    )
    const result = runDesignContractScanner({
      state,
      mode: 'strict',
      contract,
      getWrittenFileContent: (filePath) =>
        state.writtenFileContent.get(filePath),
    })
    expect(result.blocked).toBe(false)
  })

  test('requires explicit review for computed spacing values', () => {
    const state = createEnforcementState()
    state.dirtyFiles.add('src/App.tsx')
    state.writtenFileContent.set(
      'src/App.tsx',
      'padding: calc(8px + 4px); aria-label="Demo";',
    )
    const result = runDesignContractScanner({
      state,
      mode: 'strict',
      contract,
      getWrittenFileContent: (filePath) =>
        state.writtenFileContent.get(filePath),
    })
    expect(result.blocked).toBe(true)
    expect(result.reason).toContain('computed-values NEEDS-REVIEW')
  })

  test('requires token boundaries for accessibility requirements', () => {
    const state = createEnforcementState()
    state.dirtyFiles.add('src/App.tsx')
    state.writtenFileContent.set(
      'src/App.tsx',
      'const text = "data-aria-label"; padding: 8px;',
    )
    const result = runDesignContractScanner({
      state,
      mode: 'strict',
      contract,
      getWrittenFileContent: (filePath) =>
        state.writtenFileContent.get(filePath),
    })
    expect(result.blocked).toBe(true)
    expect(result.reason).toContain('accessibility')
  })

  test('accepts CSS variables and valid spacing shorthands', () => {
    const state = createEnforcementState()
    state.dirtyFiles.add('src/App.tsx')
    state.writtenFileContent.set(
      'src/App.tsx',
      'padding: 8px 8px; margin: var(--space-sm); border-radius: 4px; aria-label="Demo";',
    )
    const result = runDesignContractScanner({
      state,
      mode: 'strict',
      contract,
      getWrittenFileContent: (filePath) =>
        state.writtenFileContent.get(filePath),
    })
    expect(result.blocked).toBe(false)
  })

  test('flags unitless OpenTUI spacing values outside the contract', () => {
    const state = createEnforcementState()
    state.dirtyFiles.add('src/App.tsx')
    state.writtenFileContent.set(
      'src/App.tsx',
      'const style = { padding: 12, margin: 1, borderRadius: 6 }; aria-label="Demo";',
    )
    const result = runDesignContractScanner({
      state,
      mode: 'strict',
      contract,
      getWrittenFileContent: (filePath) =>
        state.writtenFileContent.get(filePath),
    })
    expect(result.blocked).toBe(true)
    expect(result.reason).toContain('spacing')
    expect(result.reason).toContain('radius')
  })

  test('requires review for dynamic OpenTUI visual expressions', () => {
    const state = createEnforcementState()
    state.dirtyFiles.add('src/App.tsx')
    state.writtenFileContent.set(
      'src/App.tsx',
      'const style = { fg: theme.primary, bg: getColor(), padding: spacing("sm") }; aria-label="Demo";',
    )
    const result = runDesignContractScanner({
      state,
      mode: 'strict',
      contract,
      getWrittenFileContent: (filePath) =>
        state.writtenFileContent.get(filePath),
    })
    expect(result.blocked).toBe(true)
    expect(result.reason).toContain('dynamic-values NEEDS-REVIEW')
  })

  test('flags spacing, radius, typography, and required accessibility values', () => {
    const state = createEnforcementState()
    state.dirtyFiles.add('src/App.tsx')
    state.writtenFileContent.set(
      'src/App.tsx',
      'font-family: Arial; padding: 12px; border-radius: 6px;',
    )
    const result = runDesignContractScanner({
      state,
      mode: 'strict',
      contract,
      getWrittenFileContent: (filePath) =>
        state.writtenFileContent.get(filePath),
    })
    expect(result.blocked).toBe(true)
    expect(result.reason).toContain('spacing')
    expect(result.reason).toContain('radius')
    expect(result.reason).toContain('typography')
    expect(result.reason).toContain('accessibility')
  })
})
