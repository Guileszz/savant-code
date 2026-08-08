import fs from 'fs'
import path from 'path'

import {
  getAllFilePaths,
  getProjectFileTree,
} from '@savant-code/common/project-file-tree'

import { assignClustersToNodes, computeClusters } from './clusters'
import { buildAllEdges } from './extract'
import { defaultFileHasher } from './hasher'
import { NODE_TYPES } from './types'

import type { FileHasher } from './hasher'
import type { IndexStats, ParseFileFn } from './types'
import type { SavantCodeFileSystem } from '@savant-code/common/types/filesystem'
import type { FileTreeNode } from '@savant-code/common/util/file'
import type { Database } from 'bun:sqlite'

/**
 * Codebase knowledge-graph indexer (FID-2026-0806-002 Phase 1).
 *
 * In-process, incremental, deterministic:
 * 1. Enumerate project files honoring ignore rules (project-file-tree).
 * 2. Hash-compare against the `files` table — unchanged files are skipped.
 * 3. Delete rows for files no longer on disk (FK cascade prunes nodes/edges).
 * 4. Re-parse only changed/new files via code-map (`parseFile`), building
 *    symbol nodes.
 * 5. Rebuild the corpus edge set (CALLS/IMPORTS/EXTENDS) from parse output +
 *    raw source — deterministic "graph assembly" over the indexed snapshot.
 * 6. Run the Louvain pass and write cluster ids back to nodes.
 *
 * The parse function is injectable so tests can stub tree-sitter; the default
 * uses code-map's tree-sitter layer. Imports/extends still come from raw
 * source so the engine works even when parsing is unavailable.
 */

export interface UpdateGraphParams {
  projectRoot: string
  db: Database
  fs?: SavantCodeFileSystem
  hasher?: FileHasher
  /** Injectable parse fn (defaults to code-map). */
  parseFile?: ParseFileFn
  /** Size cap for a single file (bytes). Default 1MB — matches code-map. */
  maxFileBytes?: number
}

const DEFAULT_MAX_FILE_BYTES = 1_000_000

/** Default parse fn backed by code-map's tree-sitter layer. */
const defaultParseFile: ParseFileFn = async (filePath, fullPath) => {
  try {
    const { getLanguageConfig } =
      await import('@savant-code/code-map/languages')
    const { parseTokens } = await import('@savant-code/code-map/parse')
    const languageConfig = await getLanguageConfig(fullPath)
    if (!languageConfig) return null
    const readFile = (p: string): string | null => {
      try {
        return fs.readFileSync(p, 'utf8')
      } catch {
        return null
      }
    }
    const parsed = parseTokens(filePath, languageConfig, readFile)
    return { identifiers: parsed.identifiers, calls: parsed.calls }
  } catch {
    // Parsing is best-effort: graph assembly (imports/extends) still works.
    return null
  }
}

/** The node:fs adapter used when no `fs` is injected. */
const nodeFsAdapter: SavantCodeFileSystem = fs.promises

/**
 * Run an incremental update pass over the project.
 *
 * When `fullRebuild` is true (used by `/graph refresh --full` and by the first
 * pass on an empty database), every file is treated as changed.
 */
export async function updateKnowledgeGraph(
  params: UpdateGraphParams & { fullRebuild?: boolean },
): Promise<IndexStats> {
  const {
    projectRoot,
    db,
    fs: injectedFs,
    hasher = defaultFileHasher,
    parseFile = defaultParseFile,
    maxFileBytes = DEFAULT_MAX_FILE_BYTES,
    fullRebuild = false,
  } = params

  const start = Date.now()
  const fsImpl = injectedFs ?? nodeFsAdapter

  // 1. Enumerate the project (ignore rules honored). The graph's own home
  // (.savant/) is always excluded — the DB must never index itself, and the
  // FID hygiene requirement keeps it out of the repository too.
  const fileTree: FileTreeNode[] = await getProjectFileTree({
    projectRoot,
    fs: fsImpl,
  })
  // Paths are normalized to forward slashes for storage and querying:
  // getProjectFileTree returns platform-native separators (backslashes on
  // Windows), but every resolver/query in this package speaks posix — and the
  // CLI tool API surface is forward-slash by convention. Normalizing here
  // keeps `files.path` and every query key in one canonical form.
  const filePaths = getAllFilePaths(fileTree)
    .map((p) => p.replaceAll('\\', '/'))
    .filter((p) => !p.startsWith('.savant/'))
  const filePathSet = new Set(filePaths)

  // 2. Load the existing index state.
  const existingRows = db
    .query('SELECT id, path, hash FROM files')
    .all() as Array<{ id: number; path: string; hash: string }>
  const existingByPath = new Map(existingRows.map((r) => [r.path, r]))

  const stats: IndexStats = {
    filesOnDisk: filePaths.length,
    filesAdded: 0,
    filesModified: 0,
    filesDeleted: 0,
    filesUnchanged: 0,
    nodeCount: 0,
    edgeCount: 0,
    clusterCount: 0,
    durationMs: 0,
  }

  // 3. Delete files no longer on disk (cascade prunes nodes/edges).
  const stalePaths = existingRows
    .filter((row) => !filePathSet.has(row.path))
    .map((row) => row.path)
  if (stalePaths.length > 0) {
    const deleteStmt = db.prepare('DELETE FROM files WHERE path = ?')
    db.exec('BEGIN')
    try {
      for (const p of stalePaths) {
        deleteStmt.run(p)
      }
      db.exec('COMMIT')
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
    stats.filesDeleted = stalePaths.length
  }

  // 4. Hash-compare + parse changed/new files.
  const parsedFiles = new Map<
    string,
    { identifiers: string[]; calls: string[] }
  >()
  const sources = new Map<string, string>()

  const readSource = async (fullPath: string): Promise<string | null> => {
    try {
      const st = await fsImpl.stat(fullPath)
      const size = typeof st.size === 'number' ? st.size : 0
      if (size > maxFileBytes) return null
      return await fsImpl.readFile(fullPath, 'utf8')
    } catch {
      return null
    }
  }

  for (const filePath of filePaths) {
    const fullPath = path.join(projectRoot, filePath)
    const source = await readSource(fullPath)
    if (source === null) continue

    sources.set(filePath, source)
    const hash = hasher.hash(source)
    const existing = existingByPath.get(filePath)

    // Unchanged (and not forcing a full rebuild) → skip entirely.
    if (!fullRebuild && existing && existing.hash === hash) {
      stats.filesUnchanged++
      continue
    }

    // Changed/new → parse (best-effort) and stage for upsert.
    const parsed = await parseFile(filePath, fullPath)
    if (parsed) {
      parsedFiles.set(filePath, parsed)
    }

    if (existing && existing.hash === hash) {
      // Only reachable under fullRebuild — count as reindexed.
      stats.filesModified++
    } else if (existing) {
      stats.filesModified++
    } else {
      stats.filesAdded++
    }
  }

  // 4b. Upsert file rows + nodes + call tokens for every changed/new file.
  // Prune the old subtree first (single DELETE; FK cascade removes stale
  // nodes/edges/file_calls).
  const pruneStmt = db.prepare('DELETE FROM files WHERE path = ?')
  const insertFileStmt = db.prepare(
    'INSERT INTO files (path, hash) VALUES (?, ?)',
  )
  const insertNodeStmt = db.prepare(
    'INSERT INTO nodes (file_id, type, name) VALUES (?, ?, ?)',
  )
  const insertCallStmt = db.prepare(
    'INSERT INTO file_calls (file_id, token) VALUES (?, ?)',
  )

  db.exec('BEGIN')
  try {
    for (const filePath of filePaths) {
      const source = sources.get(filePath)
      if (source === undefined) continue
      const existing = existingByPath.get(filePath)
      if (!fullRebuild && existing && existing.hash === hasher.hash(source)) {
        continue // unchanged — already counted
      }

      pruneStmt.run(filePath)
      const hash = hasher.hash(source)
      const insertResult = insertFileStmt.run(filePath, hash) as {
        lastInsertRowid: number
      }
      const fileId = Number(insertResult.lastInsertRowid)

      const parsed = parsedFiles.get(filePath)
      if (parsed) {
        for (const identifier of parsed.identifiers) {
          insertNodeStmt.run(fileId, NODE_TYPES.SYMBOL, identifier)
        }
        for (const call of parsed.calls) {
          insertCallStmt.run(fileId, call)
        }
      }
      // Anchor node so files with no symbols still appear in node queries.
      insertNodeStmt.run(fileId, NODE_TYPES.FILE, filePath)
    }
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }

  // 5. Rebuild the full corpus edge set from the fresh index state.
  const fileRows = db.query('SELECT id, path FROM files').all() as Array<{
    id: number
    path: string
  }>
  const idByPath = new Map(fileRows.map((r) => [r.path, r.id]))
  const currentFilePaths = new Set(fileRows.map((r) => r.path))

  // Symbol index from DB (covers files parsed in previous passes too).
  const pathById = new Map(fileRows.map((r) => [r.id, r.path]))
  const nodeRows = db
    .query('SELECT file_id, name FROM nodes WHERE type = ?')
    .all(NODE_TYPES.SYMBOL) as Array<{ file_id: number; name: string }>
  const dbSymbolIndex = new Map<string, string[]>()
  for (const row of nodeRows) {
    const filePath = pathById.get(row.file_id)
    if (!filePath) continue
    const list = dbSymbolIndex.get(row.name) ?? []
    if (!list.includes(filePath)) list.push(filePath)
    dbSymbolIndex.set(row.name, list)
  }

  // Call tokens from DB — the incremental invariant: the CALLS layer is
  // rebuilt from persisted per-file calls (only changed files are re-parsed,
  // so parsedFiles alone would silently drop edges for unchanged callers).
  const callRows = db
    .query('SELECT file_id, token FROM file_calls')
    .all() as Array<{ file_id: number; token: string }>
  const callsByFile = new Map<string, string[]>()
  for (const row of callRows) {
    const filePath = pathById.get(row.file_id)
    if (!filePath) continue
    const list = callsByFile.get(filePath) ?? []
    list.push(row.token)
    callsByFile.set(filePath, list)
  }

  const edges = buildAllEdges({
    parsedFiles: new Map(
      [...fileRows].map((row) => [
        row.path,
        { identifiers: [], calls: callsByFile.get(row.path) ?? [] },
      ]),
    ),
    sources,
    filePaths: currentFilePaths,
    symbolIndex: dbSymbolIndex,
  })

  // Clear + rewrite edges (deterministic full rebuild of the edge layer).
  db.exec('DELETE FROM edges')
  const insertEdgeStmt = db.prepare(
    'INSERT INTO edges (source_id, target_id, type, weight) VALUES (?, ?, ?, ?)',
  )
  db.exec('BEGIN')
  try {
    for (const [key, entry] of edges) {
      const [source, target] = key.split('\u0000')
      const sourceId = idByPath.get(source)
      const targetId = idByPath.get(target)
      if (sourceId === undefined || targetId === undefined) continue
      insertEdgeStmt.run(sourceId, targetId, entry.type, entry.weight)
    }
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }

  // 6. Louvain clustering + cluster_id write-back.
  const clusterAssignments = computeClusters({ db })
  assignClustersToNodes({ db, assignments: clusterAssignments })

  stats.nodeCount = (
    db.query('SELECT COUNT(*) AS c FROM nodes').get() as { c: number }
  ).c
  stats.edgeCount = (
    db.query('SELECT COUNT(*) AS c FROM edges').get() as { c: number }
  ).c
  // clusterCount must be the number of DISTINCT Louvain communities, not the
  // number of assigned files — `clusterAssignments.size` is the file count
  // (every file maps to exactly one cluster id), which grossly overstates the
  // domain count on real repos (e.g. 1975 reported vs 412 actual).
  stats.clusterCount = (
    db
      .query(
        'SELECT COUNT(DISTINCT cluster_id) AS c FROM nodes WHERE cluster_id IS NOT NULL',
      )
      .get() as { c: number }
  ).c
  stats.durationMs = Date.now() - start

  return stats
}

/**
 * Lightweight synonym for updateKnowledgeGraph used by callers that want the
 * "refresh" verb (keeps the API self-documenting).
 */
export function refreshKnowledgeGraph(
  params: UpdateGraphParams,
): Promise<IndexStats> {
  return updateKnowledgeGraph(params)
}
