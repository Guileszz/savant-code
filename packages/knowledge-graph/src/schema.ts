/**
 * SQLite schema for the codebase knowledge graph (FID-2026-0806-002 Phase 1).
 *
 * Storage follows the packages/database conventions (bun:sqlite, WAL, schema
 * module with version tracking) and the agents/database guardrail adapter
 * pattern (read-only tool surface, row caps). Structural metadata only — no
 * file contents ever enter the database.
 *
 * Tables:
 * - files  : indexed file registry (path unique, sha256 content hash)
 * - nodes  : symbols (and file anchors) per file; cluster_id written back by
 *            the Louvain pass
 * - edges  : file→file dependency edges (CALLS / IMPORTS / EXTENDS)
 *
 * Foreign keys cascade: deleting a file removes its nodes and every incident
 * edge, which is what makes the incremental update's "prune stale subtree"
 * step a single DELETE.
 */
export const SCHEMA_VERSION = 1

export const GRAPH_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS schema_version (
  version INTEGER PRIMARY KEY,
  applied_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS files (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  path TEXT NOT NULL UNIQUE,
  hash TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS nodes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  name TEXT NOT NULL,
  cluster_id INTEGER
);

CREATE TABLE IF NOT EXISTS edges (
  source_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  target_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  weight REAL NOT NULL DEFAULT 1.0,
  PRIMARY KEY (source_id, target_id, type)
);

-- Per-file call tokens (definitions live in the nodes table). Persisted so
-- the CALLS edge layer can be rebuilt from the complete DB state on every
-- pass without re-parsing unchanged files (the incremental invariant).
CREATE TABLE IF NOT EXISTS file_calls (
  file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  token TEXT NOT NULL,
  PRIMARY KEY (file_id, token)
);

CREATE INDEX IF NOT EXISTS idx_nodes_name ON nodes(name);
CREATE INDEX IF NOT EXISTS idx_nodes_file_id ON nodes(file_id);
CREATE INDEX IF NOT EXISTS idx_edges_source ON edges(source_id);
CREATE INDEX IF NOT EXISTS idx_edges_target ON edges(target_id);

-- Cluster ids written back by the Louvain pass live on nodes; index for
-- query_domain_clusters lookups.
CREATE INDEX IF NOT EXISTS idx_nodes_cluster_id ON nodes(cluster_id);
`

/**
 * One-shot schema migration runner. Opens the database, applies the schema,
 * records the schema version, and enables WAL + foreign keys.
 */
export function applyGraphSchema(db: {
  exec(sql: string): unknown
  prepare(sql: string): { run(...params: unknown[]): unknown }
}): void {
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA foreign_keys = ON')
  db.exec(GRAPH_SCHEMA_SQL)
  db.prepare('INSERT OR IGNORE INTO schema_version (version) VALUES (?)').run(
    SCHEMA_VERSION,
  )
}
