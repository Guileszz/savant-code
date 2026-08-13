#!/usr/bin/env bun

import fs from 'node:fs'
import path from 'node:path'

export * from './learnings-core.js'

import {
  validateEmbeddedLearningSource,
  validateLearnings,
} from './learnings-core.js'

export function readAndValidateLearnings(root: string) {
  return validateLearnings(
    fs.readFileSync(path.join(root, 'dev', 'LEARNINGS.md'), 'utf8'),
    root,
  )
}

if (import.meta.main) {
  const root = path.resolve(import.meta.dir, '..')
  const result = readAndValidateLearnings(root)
  const sourcePath = path.join(root, 'docs', 'embedded-learnings.md')
  result.issues.push(
    ...(fs.existsSync(sourcePath)
      ? validateEmbeddedLearningSource(
          'docs/embedded-learnings.md',
          fs.readFileSync(sourcePath, 'utf8'),
        )
      : [
          {
            code: 'learning.embedded.missing',
            message: 'docs/embedded-learnings.md is missing.',
          },
        ]),
  )
  if (result.issues.length > 0) {
    console.error(`learnings: FAIL (${result.issues.length} issue(s))`)
    for (const entry of result.issues)
      console.error(`- [${entry.code}] ${entry.message}`)
    process.exitCode = 1
  } else {
    console.log(`learnings: PASS (${result.entries.length} structured entries)`)
  }
}
