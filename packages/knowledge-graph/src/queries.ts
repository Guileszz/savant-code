import { MAX_TRAVERSAL_DEPTH } from './types'

import type { ClusterRow, NodeEdgesResult, ReachabilityResult } from './types'
import type { Database } from 'bun:sqlite'

/**
 * Read-only graph queries (FID-2026-0806-002 Phase 1/3).
 *
 * Blast radius + reachability use a recursive CTE with:
 * - `instr(path, ':' || id || ':')` cycle detection (path-visited guard), and
 * - a depth cap (MAX_TRAVERSAL_DEPTH = 50).
 *
 * Law 4 honesty: these are deterministic proofs *over the indexed snapshot*,
 * bounded by index freshness and parser-query coverage — not absolute.
 */

interface FileRow {
  id: number
  path: string
  hash: string
}

/** Resolve a file path to its row, or null. */
export function getFileByPath(db: Database, filePath: string): FileRow | null {
  return (
    (db
      .query('SELECT id, path, hash FROM files WHERE path = ?')
      .get(filePath) as FileRow | undefined) ?? null
  )
}

/**
 * Blast radius: every file reachable from `filePath` within `maxDepth` hops
 * over UNDIRECTED edges (both dependency and dependent directions — a change
 * propagates both ways). Cycle-safe via the path guard; depth-capped at
 * MAX_TRAVERSAL_DEPTH.
 */
export function queryBlastRadius(params: {
  db: Database
  filePath: string
  maxDepth?: number
  limit?: number
}): Array<{ path: string; depth: number }> {
  const { db, filePath, maxDepth = MAX_TRAVERSAL_DEPTH, limit = 1000 } = params
  const file = getFileByPath(db, filePath)
  if (!file) return []

  const depth = Math.min(Math.max(1, maxDepth), MAX_TRAVERSAL_DEPTH)

  // Recursive CTE: start at the file node, walk undirected edges, track a
  // visited-path string to break cycles. We join edges twice (source/target)
  // so traversal is undirected.
  const rows = db
    .query(
      `WITH RECURSIVE reach(node_id, depth, path) AS (
         SELECT ?1, 0, ':' || ?1 || ':'
         UNION ALL
         SELECT e.target_id, r.depth + 1, r.path || e.target_id || ':'
         FROM edges e
         JOIN reach r ON e.source_id = r.node_id
         WHERE r.depth < ?2
           AND instr(r.path, ':' || e.target_id || ':') = 0
         UNION ALL
         SELECT e.source_id, r.depth + 1, r.path || e.source_id || ':'
         FROM edges e
         JOIN reach r ON e.target_id = r.node_id
         WHERE r.depth < ?2
           AND instr(r.path, ':' || e.source_id || ':') = 0
       )
       SELECT f.path, MIN(r.depth) AS depth
       FROM reach r
       JOIN files f ON f.id = r.node_id
       WHERE r.node_id != ?1
       GROUP BY f.id
       ORDER BY depth ASC, f.path ASC
       LIMIT ?3`,
    )
    .all(file.id, depth, limit) as Array<{ path: string; depth: number }>

  return rows
}

/**
 * Node edges: a file's symbol nodes, cluster, and direct incoming/outgoing
 * edges with resolved paths.
 */
export function queryNodeEdges(params: {
  db: Database
  filePath: string
  limit?: number
}): NodeEdgesResult {
  const { db, filePath, limit = 500 } = params
  const file = getFileByPath(db, filePath)
  if (!file) {
    return { file: null, symbols: [], outgoing: [], incoming: [] }
  }

  const symbols = db
    .query(
      'SELECT id, name, cluster_id FROM nodes WHERE file_id = ? AND type = ? ORDER BY name LIMIT ?',
    )
    .all(file.id, 'symbol', limit) as Array<{
    id: number
    name: string
    cluster_id: number | null
  }>

  const anchor = db
    .query('SELECT cluster_id FROM nodes WHERE file_id = ? AND type = ?')
    .get(file.id, 'file') as { cluster_id: number | null } | null

  const outgoing = db
    .query(
      `SELECT f.path AS sourcePath, t.path AS targetPath, e.type, e.weight
       FROM edges e
       JOIN files f ON f.id = e.source_id
       JOIN files t ON t.id = e.target_id
       WHERE e.source_id = ?
       ORDER BY e.weight DESC, t.path ASC
       LIMIT ?`,
    )
    .all(file.id, limit) as Array<{
    sourcePath: string
    targetPath: string
    type: 'CALLS' | 'IMPORTS' | 'EXTENDS'
    weight: number
  }>

  const incoming = db
    .query(
      `SELECT f.path AS sourcePath, t.path AS targetPath, e.type, e.weight
       FROM edges e
       JOIN files f ON f.id = e.source_id
       JOIN files t ON t.id = e.target_id
       WHERE e.target_id = ?
       ORDER BY e.weight DESC, f.path ASC
       LIMIT ?`,
    )
    .all(file.id, limit) as Array<{
    sourcePath: string
    targetPath: string
    type: 'CALLS' | 'IMPORTS' | 'EXTENDS'
    weight: number
  }>

  return {
    file: {
      id: file.id,
      path: file.path,
      hash: file.hash,
      clusterId: anchor?.cluster_id ?? null,
    },
    symbols: symbols.map((s) => ({
      id: s.id,
      name: s.name,
      clusterId: s.cluster_id,
    })),
    outgoing,
    incoming,
  }
}

/** Domain clusters with sizes and representative files. */
export function queryDomainClusters(params: {
  db: Database
  limit?: number
}): ClusterRow[] {
  const { db, limit = 100 } = params

  const rows = db
    .query(
      `WITH file_clusters AS (
         SELECT n.file_id, n.cluster_id, f.path
         FROM nodes n
         JOIN files f ON f.id = n.file_id
         WHERE n.type = 'file' AND n.cluster_id IS NOT NULL
       ),
       clusters AS (
         SELECT
           cluster_id,
           COUNT(DISTINCT file_id) AS file_count,
           COUNT(*) AS node_count
         FROM file_clusters
         GROUP BY cluster_id
       )
       SELECT
         c.cluster_id AS clusterId,
         c.file_count AS fileCount,
         c.node_count AS nodeCount
       FROM clusters c
       ORDER BY c.file_count DESC, c.cluster_id ASC
       LIMIT ?`,
    )
    .all(limit) as Array<{
    clusterId: number
    fileCount: number
    nodeCount: number
  }>

  // Representative files per cluster (top 5 by path).
  return rows.map((row) => {
    const files = db
      .query(
        `SELECT f.path FROM nodes n
         JOIN files f ON f.id = n.file_id
         WHERE n.type = 'file' AND n.cluster_id = ?
         ORDER BY f.path ASC
         LIMIT 5`,
      )
      .all(row.clusterId) as Array<{ path: string }>
    return {
      clusterId: row.clusterId,
      fileCount: row.fileCount,
      nodeCount: row.nodeCount,
      files: files.map((f) => f.path),
    }
  })
}

/**
 * Directed reachability from `fromPath` to `toPath` over the dependency edges
 * (source → target). Returns the shortest directed path chain, or reachable:
 * false. Used by the harness `verify_call_reachability` path.
 */
export function queryReachability(params: {
  db: Database
  fromPath: string
  toPath: string
  maxDepth?: number
}): ReachabilityResult {
  const { db, fromPath, toPath, maxDepth = MAX_TRAVERSAL_DEPTH } = params
  const from = getFileByPath(db, fromPath)
  const to = getFileByPath(db, toPath)
  if (!from || !to) {
    return { reachable: false, depth: null, path: null }
  }
  if (from.id === to.id) {
    return { reachable: true, depth: 0, path: [fromPath] }
  }

  const depth = Math.min(Math.max(1, maxDepth), MAX_TRAVERSAL_DEPTH)

  // BFS-shaped recursive CTE with path tracking. We take the minimum-depth
  // path (shortest directed dependency chain), cycle-guarded.
  const rows = db
    .query(
      `WITH RECURSIVE search(node_id, depth, path_ids, path_str) AS (
         SELECT e.target_id, 1, CAST(e.target_id AS TEXT), ':' || e.source_id || ':' || e.target_id || ':'
         FROM edges e
         WHERE e.source_id = ?1
         UNION ALL
         SELECT e.target_id, s.depth + 1,
                s.path_ids || ',' || e.target_id,
                s.path_str || e.target_id || ':'
         FROM edges e
         JOIN search s ON e.source_id = s.node_id
         WHERE s.depth < ?2
           AND instr(s.path_str, ':' || e.target_id || ':') = 0
       )
       SELECT s.path_ids, s.depth
       FROM search s
       WHERE s.node_id = ?3
       ORDER BY s.depth ASC
       LIMIT 1`,
    )
    .all(from.id, depth, to.id) as Array<{ path_ids: string; depth: number }>

  const best = rows[0]
  if (!best) {
    return { reachable: false, depth: null, path: null }
  }

  const ids = best.path_ids.split(',').map(Number)
  const pathRows = db
    .query(
      `SELECT path FROM files WHERE id IN (${ids.map(() => '?').join(',')})`,
    )
    .all(...ids) as Array<{ path: string }>
  const pathByFile = pathRows.map((r) => r.path)
  const idToPath = new Map<number, string>(
    ids.map((id, i) => [id, pathByFile[i]]),
  )
  const chain = [fromPath, ...ids.map((id) => idToPath.get(id) ?? String(id))]

  return { reachable: true, depth: best.depth, path: chain }
}
