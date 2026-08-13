import { describe, expect, it } from 'bun:test'

import { createEnforcementState } from '../enforcement-state'
import { runPostWriteScanners } from '../post-write-scanners'

describe('runPostWriteScanners', () => {
  it('scans exact successful content and reports law violations', () => {
    const state = createEnforcementState()
    state.dirtyFiles.add('src/example.ts')

    const result = runPostWriteScanners({
      state,
      mode: 'strict',
      tier: 'all_15',
      getWrittenFileContent: () => 'const value: any = 1 // TODO',
    })

    expect(result.blocked).toBe(true)
    expect(result.warnings.map((warning) => warning.law)).toEqual(
      expect.arrayContaining([5, 6]),
    )
  })

  it('treats an empty string as available content', () => {
    const state = createEnforcementState()
    state.dirtyFiles.add('src/empty.ts')

    const result = runPostWriteScanners({
      state,
      mode: 'strict',
      tier: 'all_15',
      getWrittenFileContent: () => '',
    })

    expect(
      result.warnings.some((warning) =>
        warning.message.includes('content unavailable'),
      ),
    ).toBe(false)
  })

  it('fails closed when successful write content is unavailable', () => {
    const state = createEnforcementState()
    state.dirtyFiles.add('src/unavailable.ts')

    const result = runPostWriteScanners({
      state,
      mode: 'strict',
      tier: 'all_15',
    })

    expect(result.blocked).toBe(true)
    expect(result.reason).toContain('content unavailable')
    expect(result.warnings[0]?.file).toBe('src/unavailable.ts')
  })

  it('does not block or scan extended laws in hybrid mode', () => {
    const state = createEnforcementState()
    state.dirtyFiles.add('src/example.ts')

    const result = runPostWriteScanners({
      state,
      mode: 'hybrid',
      tier: 'core_4',
      getWrittenFileContent: () => 'const value: any = 1 // TODO',
    })

    expect(result).toEqual({ blocked: false, warnings: [] })
  })
})
