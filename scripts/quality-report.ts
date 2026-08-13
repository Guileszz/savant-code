#!/usr/bin/env bun

import fs from 'node:fs'
import path from 'node:path'

type ApprovedGrowth = {
  maxLines: number
  rationale: string
}

type QualityBaseline = {
  maxFileLines: number
  trackedFiles: Record<string, number>
  approvedGrowth?: Record<string, ApprovedGrowth>
}

type QualityIssue = {
  file: string
  message: string
}

const root = path.resolve(import.meta.dir, '..')
const baselinePath = path.join(root, 'dev', 'quality-baseline.json')
const sourceRoots = [
  'agents',
  'cli/src',
  'common/src',
  'evals',
  'packages',
  'sdk/src',
  'scripts',
]
const excluded =
  /(^|[\\/])(__tests__|node_modules)([\\/]|$)|\.test\.ts$|\.spec\.ts$|generated\./

export function readQualityBaseline(): QualityBaseline {
  return JSON.parse(fs.readFileSync(baselinePath, 'utf8')) as QualityBaseline
}

function sourceFiles(): string[] {
  const files: string[] = []
  const visit = (directory: string): void => {
    if (!fs.existsSync(directory)) return
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const fullPath = path.join(directory, entry.name)
      if (entry.isDirectory()) visit(fullPath)
      else if (/\.(ts|tsx)$/.test(entry.name) && !excluded.test(fullPath))
        files.push(fullPath)
    }
  }
  for (const relativeRoot of sourceRoots) visit(path.join(root, relativeRoot))
  return files.sort()
}

export function collectQualityIssues(
  baseline: QualityBaseline,
): QualityIssue[] {
  const issues: QualityIssue[] = []
  for (const filePath of sourceFiles()) {
    const relative = path.relative(root, filePath).replaceAll(path.sep, '/')
    const lineCount = fs.readFileSync(filePath, 'utf8').split(/\r?\n/).length
    const baselineLines = baseline.trackedFiles[relative]
    const approvedGrowth = baseline.approvedGrowth?.[relative]
    const effectiveBaseline = approvedGrowth?.maxLines ?? baselineLines
    if (
      approvedGrowth !== undefined &&
      (baselineLines === undefined ||
        approvedGrowth.maxLines < baselineLines ||
        approvedGrowth.maxLines < lineCount ||
        approvedGrowth.rationale.trim().length === 0)
    ) {
      issues.push({
        file: relative,
        message:
          'approved growth must reference a tracked file, have a non-empty rationale, and have a maxLines value covering the current measured line count without lowering the baseline',
      })
      continue
    }

    if (lineCount > baseline.maxFileLines && effectiveBaseline === undefined) {
      issues.push({
        file: relative,
        message: `${lineCount} lines exceeds new-file baseline`,
      })
    }
    if (effectiveBaseline !== undefined && lineCount > effectiveBaseline) {
      issues.push({
        file: relative,
        message: `${lineCount} lines exceeds baseline ${effectiveBaseline}`,
      })
    }
  }
  return issues
}

if (import.meta.main) {
  const baseline = readQualityBaseline()
  const issues = collectQualityIssues(baseline)
  if (issues.length === 0) {
    console.log(
      `quality: PASS (${Object.keys(baseline.trackedFiles).length} baselined files)`,
    )
  } else {
    console.error(`quality: FAIL (${issues.length} ratchet violation(s))`)
    for (const issue of issues.slice(0, 50))
      console.error(`- ${issue.file}: ${issue.message}`)
    if (issues.length > 50) console.error(`- (+${issues.length - 50} more)`)
    process.exitCode = 1
  }
}
