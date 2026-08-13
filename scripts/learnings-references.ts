import fs from 'node:fs'
import path from 'node:path'

import type {
  LearningIssue,
  StableReference,
  StructuredLearning,
} from './learnings-types.js'

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
function resolvePath(root: string, referencePath: string): string | undefined {
  const target = path.resolve(root, referencePath.replaceAll('/', path.sep))
  const relative = path.relative(root, target)
  if (
    !relative ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  )
    return undefined
  try {
    const realRelative = path.relative(
      fs.realpathSync(root),
      fs.realpathSync(target),
    )
    return realRelative &&
      !realRelative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(realRelative)
      ? target
      : undefined
  } catch {
    return undefined
  }
}

function canStartRegex(content: string, slashIndex: number): boolean {
  let index = slashIndex - 1
  while (index >= 0 && /\s/.test(content[index] ?? '')) index -= 1
  if (index < 0) return true
  const previous = content[index]
  if ('([{=,:;!&|?+\-*%^~<>'.includes(previous ?? '')) return true
  const wordEnd = index + 1
  while (index >= 0 && /[A-Za-z0-9_$]/.test(content[index] ?? '')) index -= 1
  const previousWord = content.slice(index + 1, wordEnd)
  return [
    'case',
    'else',
    'return',
    'throw',
    'typeof',
    'void',
    'yield',
  ].includes(previousWord)
}

/**
 * Remove comments and regex literals while optionally preserving string tokens.
 * All replacements preserve newlines and therefore preserve source positions.
 */
function lexicalCode(content: string, preserveStrings: boolean): string {
  let result = ''
  let quote: '"' | "'" | '`' | undefined
  let index = 0
  while (index < content.length) {
    const current = content[index]
    const next = content[index + 1]
    if (quote) {
      if (current === '\\' && index + 1 < content.length) {
        result += preserveStrings ? current + content[index + 1] : '  '
        index += 2
        continue
      }
      if (current === quote) {
        result += preserveStrings ? current : ' '
        quote = undefined
        index += 1
        continue
      }
      result +=
        preserveStrings && current !== '\r'
          ? current
          : current === '\n'
            ? '\n'
            : ' '
      index += 1
      continue
    }
    if (current === '"' || current === "'" || current === '`') {
      quote = current
      result += preserveStrings ? current : ' '
      index += 1
      continue
    }
    if (current === '/' && next === '/') {
      result += '  '
      index += 2
      while (index < content.length && content[index] !== '\n') {
        result += ' '
        index += 1
      }
      continue
    }
    if (current === '/' && next === '*') {
      result += '  '
      index += 2
      while (index < content.length) {
        if (content[index] === '*' && content[index + 1] === '/') {
          result += '  '
          index += 2
          break
        }
        result += content[index] === '\n' ? '\n' : ' '
        index += 1
      }
      continue
    }
    if (current === '/' && canStartRegex(content, index)) {
      result += '  '
      index += 1
      let escaped = false
      let inCharacterClass = false
      while (index < content.length) {
        const character = content[index]
        if (!escaped) {
          if (character === '[') inCharacterClass = true
          if (character === ']' && inCharacterClass) inCharacterClass = false
          if (character === '/' && !inCharacterClass) {
            result += ' '
            index += 1
            while (/[A-Za-z]/.test(content[index] ?? '')) {
              result += ' '
              index += 1
            }
            break
          }
        }
        result += character === '\n' ? '\n' : ' '
        escaped = !escaped && character === '\\'
        if (character !== '\\') escaped = false
        index += 1
      }
      continue
    }
    result += current
    index += 1
  }
  return result
}

function codeWithoutProse(content: string): string {
  return lexicalCode(content, false)
}

/**
 * Keep declaration-shaped quoted keys, but mask value strings so prose such as
 * `"check: not a command"` cannot become evidence for a command or field.
 */
function declarationCode(content: string): string {
  const code = lexicalCode(content, true)
  let result = ''
  let index = 0
  while (index < code.length) {
    const quote = code[index]
    if (quote !== '"' && quote !== "'" && quote !== '`') {
      result += quote
      index += 1
      continue
    }
    const start = index
    index += 1
    while (index < code.length) {
      if (code[index] === '\\') index += 2
      else if (code[index] === quote) break
      else index += 1
    }
    const end = code[index] === quote ? index + 1 : index
    let lookahead = end
    while (/\s/.test(code[lookahead] ?? '')) lookahead += 1
    const isKey = code[lookahead] === ':'
    result += isKey
      ? code.slice(start, end)
      : code.slice(start, end).replace(/[^\n]/g, ' ')
    index = end
  }
  return result
}

function skipWhitespace(content: string, index: number): number {
  while (index < content.length && /\s/.test(content[index] ?? '')) index += 1
  return index
}

function readQuotedValue(
  content: string,
  start: number,
): { value: string; end: number } | undefined {
  const quote = content[start]
  if (quote !== '"' && quote !== "'") return undefined
  let value = ''
  let index = start + 1
  while (index < content.length) {
    const character = content[index]
    if (character === '\\' && index + 1 < content.length) {
      value += content[index + 1]
      index += 2
      continue
    }
    if (character === quote) return { value, end: index + 1 }
    value += character
    index += 1
  }
  return undefined
}

function findClosingDelimiter(
  content: string,
  start: number,
  opening: string,
  closing: string,
): number | undefined {
  if (content[start] !== opening) return undefined
  const code = codeWithoutProse(content)
  let depth = 0
  let index = start
  while (index < code.length) {
    const character = code[index]
    if (character === opening) depth += 1
    if (character === closing) {
      depth -= 1
      if (depth === 0) return index + 1
    }
    index += 1
  }
  return undefined
}

/**
 * Resolve call-style tests and `test.each(<simple balanced expression>)("name", ...)`.
 * Comments, regex literals, and quoted strings are ignored while balancing.
 * Tagged-template test.each syntax and template-literal interpolation are
 * intentionally unsupported and fail closed.
 */
function testTargetCount(content: string, target: string): number {
  const code = codeWithoutProse(content)
  let count = 0
  for (const match of code.matchAll(/\b(test|it|describe)\b/g)) {
    const name = match[1]
    if (!name || match.index === undefined) continue
    let index = skipWhitespace(content, match.index + name.length)
    if (content.slice(index, index + 5) === '.each') {
      index = skipWhitespace(content, index + 5)
      const tableEnd = findClosingDelimiter(content, index, '(', ')')
      if (tableEnd === undefined) continue
      index = skipWhitespace(content, tableEnd)
    }
    if (content[index] !== '(') continue
    index = skipWhitespace(content, index + 1)
    const quoted = readQuotedValue(content, index)
    if (quoted?.value === target) count += 1
  }
  return count
}

function targetCount(content: string, reference: StableReference): number {
  const target = escapeRegExp(reference.target)
  const code = codeWithoutProse(content)
  if (reference.kind === 'heading')
    return [
      ...content.matchAll(new RegExp(String.raw`^#+\s+${target}\s*$`, 'gm')),
    ].length
  if (reference.kind === 'symbol')
    return [
      ...code.matchAll(
        new RegExp(
          String.raw`(?:export\s+)?(?:default\s+)?(?:declare\s+)?(?:async\s+)?function\s+${target}\b|(?:export\s+)?(?:const|class|interface|type)\s+${target}\b`,
          'g',
        ),
      ),
    ].length
  if (reference.kind === 'command' || reference.kind === 'field') {
    const declaration = declarationCode(content)
    return [
      ...declaration.matchAll(
        new RegExp(
          String.raw`(?:^|[\n,{])\s*(?:["']${target}["']|${target})\s*:`,
          'gm',
        ),
      ),
    ].length
  }
  if (reference.kind === 'test')
    return testTargetCount(content, reference.target)
  return [
    ...code.matchAll(
      new RegExp(String.raw`(?:^|[.\s"'\x60])${target}\s*[:=]`, 'gm'),
    ),
  ].length
}
function resolves(root: string, reference: StableReference): boolean {
  const targetPath = resolvePath(root, reference.path)
  if (!targetPath) return false
  try {
    return (
      fs.statSync(targetPath).isFile() &&
      targetCount(fs.readFileSync(targetPath, 'utf8'), reference) === 1
    )
  } catch {
    return false
  }
}
export function validateStableReferences(
  root: string,
  entries: readonly StructuredLearning[],
): LearningIssue[] {
  const issues: LearningIssue[] = []
  for (const entry of entries)
    for (const reference of entry.evidence) {
      if (!resolves(root, reference))
        issues.push({
          code: 'learning.evidence.unresolved',
          message: `${entry.title}: evidence target is missing or ambiguous: ${reference.raw}.`,
        })
      if (reference.line !== undefined) {
        let lineCount = 0
        try {
          const targetPath = resolvePath(root, reference.path)
          if (targetPath)
            lineCount = fs
              .readFileSync(targetPath, 'utf8')
              .split(/\r?\n/).length
        } catch {
          lineCount = 0
        }
        if (reference.line < 1 || reference.line > lineCount)
          issues.push({
            code: 'learning.evidence.line.invalid',
            message: `${entry.title}: supplemental line snapshot is outside the target file.`,
          })
      }
    }
  return issues
}
export function validateCanonicalRuleCatalog(
  root: string,
  entries: readonly StructuredLearning[],
): LearningIssue[] {
  const catalogPath = path.join(root, 'dev', 'LEARNING-RULES.md')
  if (!fs.existsSync(catalogPath))
    return [
      {
        code: 'learning.rules.missing',
        message: 'Canonical rule catalog is missing.',
      },
    ]
  const headings = [
    ...fs.readFileSync(catalogPath, 'utf8').matchAll(/^## Rule: (.+)$/gm),
  ]
    .map((match) => match[1]?.trim())
    .filter((name): name is string => Boolean(name))
  const counts = new Map<string, number>()
  for (const heading of headings)
    counts.set(heading, (counts.get(heading) ?? 0) + 1)
  const issues: LearningIssue[] = []
  for (const [name, count] of counts)
    if (count !== 1)
      issues.push({
        code: 'learning.rules.duplicate',
        message: `Canonical rule ${name} has ${count} headings; expected exactly one.`,
      })
  for (const entry of entries)
    if (entry.canonicalRule && counts.get(entry.canonicalRule) !== 1)
      issues.push({
        code: 'learning.rules.unresolved',
        message: `${entry.title}: canonical rule ${entry.canonicalRule} must have one catalog target.`,
      })
  return issues
}
