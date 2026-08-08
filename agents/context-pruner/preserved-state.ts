/**
 * P1b — Preserved-state JSON block (FID-2026-0806-003 Phase 1).
 *
 * Pure functions (embedded via .toString() at factory time) that extract
 * structured state from the message history so FID state, todos, loaded
 * skills, and file operations survive the compaction boundary — the Savant
 * analogue of Zero's `compaction_preserve.go` (active plan + loaded skills
 * carried across compaction as a single-line JSON block).
 *
 * Hard caps keep the block from defeating the compaction it rides in on.
 * The block must also survive reactive compaction (Layer 4) — see
 * `ContextCompactor.reactiveCompact` preserve-set (R4 fix).
 */
import {
  MAX_FID_CHARS,
  MAX_FILE_PATH_CHARS,
  MAX_FILES_PER_CATEGORY,
  MAX_PRESERVED_STATE_JSON_CHARS,
  MAX_SKILL_NAME_CHARS,
  MAX_SKILLS,
  MAX_TASK_CHARS,
  MAX_TODOS,
} from './constants'
import {
  asObject,
  asString,
  asStringArray,
  asTodoList,
  getTextContent,
} from './helpers'

import type { JSONValue, Message } from '../types/util-types'

export interface PreservedState {
  /** Latest write_todos list (task + completed); newest call wins. */
  todos: Array<{ task: string; completed: boolean }>
  /** File paths read (read_files / read_subtree) — Law 1 read-before-touch evidence. */
  readFiles: string[]
  /** File paths modified (str_replace / propose_str_replace). */
  modifiedFiles: string[]
  /** File paths created (write_file / propose_write_file). */
  createdFiles: string[]
  /** Loaded skill names (skill tool calls). */
  skills: string[]
  /** Most recently referenced FID identifier. */
  fid: string | null
}

// NOTE: every function here must be exported — the module is embedded into the
// generated handleSteps source via .toString() and functions resolve by bare
// name inside the eval'd scope. Module-level constants are NOT carried over
// (only CONTEXT_PRUNER_CONSTANTS is baked), so regexes live inside functions.

export function pushUnique(list: string[], values: string[]): void {
  for (const value of values) {
    if (!value) continue
    if (!list.includes(value)) list.push(value)
  }
}

export function capStringList(
  list: string[],
  maxCount: number,
  maxChars: number,
): string[] {
  return list.slice(0, maxCount).map((s) => s.slice(0, maxChars))
}

export function applyPreservedStateCaps(state: PreservedState): PreservedState {
  return {
    todos: state.todos.slice(0, MAX_TODOS).map((t) => ({
      task: t.task.slice(0, MAX_TASK_CHARS),
      completed: t.completed,
    })),
    readFiles: capStringList(
      state.readFiles,
      MAX_FILES_PER_CATEGORY,
      MAX_FILE_PATH_CHARS,
    ),
    modifiedFiles: capStringList(
      state.modifiedFiles,
      MAX_FILES_PER_CATEGORY,
      MAX_FILE_PATH_CHARS,
    ),
    createdFiles: capStringList(
      state.createdFiles,
      MAX_FILES_PER_CATEGORY,
      MAX_FILE_PATH_CHARS,
    ),
    skills: capStringList(state.skills, MAX_SKILLS, MAX_SKILL_NAME_CHARS),
    fid: state.fid ? state.fid.slice(0, MAX_FID_CHARS) : null,
  }
}

/**
 * Extracts structured state from the full message history. The newest
 * write_todos call wins; file ops and skills are deduplicated unions; the
 * most recent FID reference in any user/assistant text is kept.
 */
export function buildPreservedState(messages: Message[]): PreservedState {
  const state: PreservedState = {
    todos: [],
    readFiles: [],
    modifiedFiles: [],
    createdFiles: [],
    skills: [],
    fid: null,
  }

  for (const message of messages) {
    if (message.role === 'assistant' && Array.isArray(message.content)) {
      for (const part of message.content) {
        if (part.type !== 'tool-call') continue
        const input = asObject(part.input) ?? {}
        switch (part.toolName) {
          case 'write_todos': {
            const todos = asTodoList(input.todos)
            if (todos) state.todos = todos
            break
          }
          case 'read_files':
          case 'read_subtree': {
            const paths = asStringArray(input.paths)
            if (paths) pushUnique(state.readFiles, paths)
            break
          }
          case 'write_file':
          case 'propose_write_file': {
            const path = asString(input.path)
            if (path) pushUnique(state.createdFiles, [path])
            break
          }
          case 'str_replace':
          case 'propose_str_replace': {
            const path = asString(input.path)
            if (path) pushUnique(state.modifiedFiles, [path])
            break
          }
          case 'skill': {
            const name = asString(input.name)
            if (name) pushUnique(state.skills, [name])
            break
          }
          default:
            break
        }
      }
    }

    if (message.role === 'user' || message.role === 'assistant') {
      const matches = getTextContent(message).match(
        /FID-\d{4}-\d{4}-\d{3}(?:-[a-z0-9-]+)?/gi,
      )
      if (matches) state.fid = matches[matches.length - 1]
    }
  }

  return applyPreservedStateCaps(state)
}

/**
 * Serializes the state as a single-line JSON block. If the block exceeds its
 * hard cap, the largest lists are halved iteratively (files first, then todos,
 * then skills) so the JSON always stays parseable and within budget.
 */
export function serializePreservedState(state: PreservedState): string {
  let current: PreservedState = state
  for (let guard = 0; guard < 8; guard++) {
    const json = JSON.stringify(current) ?? '{}'
    if (json.length <= MAX_PRESERVED_STATE_JSON_CHARS) return json
    if (current.readFiles.length > 0) {
      current = {
        ...current,
        readFiles: current.readFiles.slice(
          0,
          Math.ceil(current.readFiles.length / 2),
        ),
      }
    } else if (current.modifiedFiles.length > 0) {
      current = {
        ...current,
        modifiedFiles: current.modifiedFiles.slice(
          0,
          Math.ceil(current.modifiedFiles.length / 2),
        ),
      }
    } else if (current.createdFiles.length > 0) {
      current = {
        ...current,
        createdFiles: current.createdFiles.slice(
          0,
          Math.ceil(current.createdFiles.length / 2),
        ),
      }
    } else if (current.todos.length > 0) {
      current = {
        ...current,
        todos: current.todos.slice(0, Math.ceil(current.todos.length / 2)),
      }
    } else if (current.skills.length > 0) {
      current = {
        ...current,
        skills: current.skills.slice(0, Math.ceil(current.skills.length / 2)),
      }
    } else {
      return json
    }
  }
  return JSON.stringify(current) ?? '{}'
}

/**
 * Extracts the preserved-state JSON from a prior summary text (the
 * `## Preserved state` section of a previous <structured_state> block).
 * Returns null when absent or unparseable.
 */
export function extractPreservedState(text: string): PreservedState | null {
  const match = text.match(/## Preserved state\s*\n(\{.*\})/)
  if (!match) return null
  try {
    return normalizePreservedState(JSON.parse(match[1]))
  } catch {
    return null
  }
}

export function normalizePreservedState(value: unknown): PreservedState | null {
  const obj = asObject(value as JSONValue)
  if (!obj) return null

  const toStringList = (v: JSONValue | undefined): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []

  const todos: Array<{ task: string; completed: boolean }> = []
  if (Array.isArray(obj.todos)) {
    for (const item of obj.todos) {
      const o = asObject(item)
      if (!o) continue
      const task = asString(o.task)
      if (task === undefined) continue
      if (typeof o.completed !== 'boolean') continue
      todos.push({ task, completed: o.completed })
    }
  }

  return applyPreservedStateCaps({
    todos,
    readFiles: toStringList(obj.readFiles),
    modifiedFiles: toStringList(obj.modifiedFiles),
    createdFiles: toStringList(obj.createdFiles),
    skills: toStringList(obj.skills),
    fid: typeof obj.fid === 'string' ? obj.fid : null,
  })
}

export function unionNewestFirst(prev: string[], next: string[]): string[] {
  const merged: string[] = []
  pushUnique(merged, next)
  pushUnique(merged, prev)
  return merged
}

/**
 * Merges a previously carried state with the state extracted from the current
 * window (Continue re-distill rule): the newest write_todos wins, file ops and
 * skills are unions (newest first), and the most recent FID reference wins.
 */
export function mergePreservedState(
  prev: PreservedState | null,
  next: PreservedState,
): PreservedState {
  if (!prev) return next
  return applyPreservedStateCaps({
    todos: next.todos.length > 0 ? next.todos : prev.todos,
    readFiles: unionNewestFirst(prev.readFiles, next.readFiles),
    modifiedFiles: unionNewestFirst(prev.modifiedFiles, next.modifiedFiles),
    createdFiles: unionNewestFirst(prev.createdFiles, next.createdFiles),
    skills: unionNewestFirst(prev.skills, next.skills),
    fid: next.fid ?? prev.fid,
  })
}
