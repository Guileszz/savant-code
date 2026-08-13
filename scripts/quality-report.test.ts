import { describe, expect, it } from 'bun:test'

import { collectQualityIssues, readQualityBaseline } from './quality-report'

describe('quality ratchet', () => {
  it('passes the checked-in baseline without ratchet violations', () => {
    expect(collectQualityIssues(readQualityBaseline())).toEqual([])
  })

  it('accepts measured approved growth with a rationale', () => {
    const issues = collectQualityIssues({
      maxFileLines: 10_000,
      trackedFiles: { 'scripts/quality-report.ts': 1 },
      approvedGrowth: {
        'scripts/quality-report.ts': {
          maxLines: 500,
          rationale:
            'Temporary bounded ceiling while the quality split is implemented.',
        },
      },
    })
    expect(issues).toEqual([])
  })

  it('rejects approved growth below the current measured line count', () => {
    const issues = collectQualityIssues({
      maxFileLines: 10_000,
      trackedFiles: { 'scripts/quality-report.ts': 1 },
      approvedGrowth: {
        'scripts/quality-report.ts': {
          maxLines: 2,
          rationale: 'Too small for the current measured file.',
        },
      },
    })
    expect(issues).toContainEqual({
      file: 'scripts/quality-report.ts',
      message: expect.stringContaining('current measured line count'),
    })
  })

  it('rejects approved growth without a rationale or below the baseline', () => {
    const issues = collectQualityIssues({
      maxFileLines: 10_000,
      trackedFiles: { 'scripts/quality-report.ts': 10 },
      approvedGrowth: {
        'scripts/quality-report.ts': { maxLines: 9, rationale: '' },
      },
    })
    expect(issues).toContainEqual({
      file: 'scripts/quality-report.ts',
      message: expect.stringContaining('approved growth'),
    })
  })

  it('rejects approved growth for an untracked file', () => {
    const issues = collectQualityIssues({
      maxFileLines: 10_000,
      trackedFiles: {},
      approvedGrowth: {
        'scripts/quality-report.ts': {
          maxLines: 500,
          rationale: 'Untracked files are not eligible for approved growth.',
        },
      },
    })
    expect(issues).toContainEqual({
      file: 'scripts/quality-report.ts',
      message: expect.stringContaining('reference a tracked file'),
    })
  })

  it('reports a tracked file that exceeds its baseline', () => {
    const issues = collectQualityIssues({
      maxFileLines: 10_000,
      trackedFiles: { 'scripts/quality-report.ts': 1 },
    })
    expect(issues).toContainEqual({
      file: 'scripts/quality-report.ts',
      message: expect.stringContaining('exceeds baseline 1'),
    })
  })
})
