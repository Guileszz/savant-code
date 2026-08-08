import type { JSONValue } from '@savant-code/common/types/json'
import type { Database } from 'bun:sqlite'

// bun:sqlite is Bun-only and the database tools only ever execute under the
// Bun runtime. The SDK bundles these handlers through the tool executor, so a
// top-level value import would emit a hoisted `require("bun:sqlite")` into
// dist/index.cjs and break Node.js consumers of the SDK at load time (the
// published SDK ships `engines.node >= 18` and a Node dist smoke test). Resolve
// the constructor lazily on first database-tool use instead (precedent:
// sdk/src/run-state.ts:550).
let sqliteDatabaseCtor: typeof Database | undefined

/** The module-scope `require` when it exists; `undefined` under Node ESM. */
function getRuntimeRequire(): ((id: string) => unknown) | undefined {
  // `typeof` is safe even where `require` is undeclared (Node ESM) — it
  // evaluates to 'undefined' without throwing a ReferenceError.
  return typeof require === 'function' ? require : undefined
}

/**
 * Resolve the bun:sqlite Database constructor, or throw a clear
 * StructuredDbError when the runtime cannot provide it (Node.js CJS/ESM
 * consumers of the SDK dist). The require is deferred to call time so the
 * SDK dist stays loadable in Node; this guard turns what would otherwise be a
 * bare `ReferenceError: require is not defined` (Node ESM) or a raw
 * `Cannot find module 'bun:sqlite'` (Node CJS) into an actionable message.
 * `requireFn` is injectable for tests. Note the default-parameter semantics:
 * omitting it (or passing explicit `undefined`) injects the runtime `require`;
 * pass explicit `null` to simulate an environment without `require` (Node ESM).
 */
export function resolveBunSqliteDatabaseModule(
  requireFn: ((id: string) => unknown) | null | undefined = getRuntimeRequire(),
): { Database: typeof Database } {
  if (typeof requireFn !== 'function') {
    throw new StructuredDbError(
      DbErrorCode.CONNECTION_FAILED,
      'The database tools require the Bun runtime: bun:sqlite is only available under Bun. Run the CLI/agent with Bun (e.g. `bun run savant-code`) instead of Node.js.',
    )
  }
  try {
    return requireFn('bun:sqlite') as { Database: typeof Database }
  } catch (error) {
    throw new StructuredDbError(
      DbErrorCode.CONNECTION_FAILED,
      `The database tools require the Bun runtime: failed to load bun:sqlite (${
        error instanceof Error ? error.message : String(error)
      }). Run the CLI/agent with Bun instead of Node.js.`,
    )
  }
}

function getSqliteDatabaseCtor(): typeof Database {
  if (sqliteDatabaseCtor === undefined) {
    sqliteDatabaseCtor = resolveBunSqliteDatabaseModule().Database
  }
  return sqliteDatabaseCtor
}

/**
 * SQLite adapter with the adapter-enforced safety contract ported from
 * googleapis/mcp-toolbox `internal/sources/cockroachdb/cockroachdb.go`
 * (Apache-2.0, FID-2026-0804-004 Loop 3 MQ-2..MQ-9). The guardrails are
 * deterministic code in the adapter boundary — never prompt constraints:
 *
 * - Read-only default: SELECT/SHOW/EXPLAIN/PRAGMA only
 * - Write statements require `allowWrite: true` AND explicit per-statement
 *   user approval (enforced by the caller wiring)
 * - Destructive DDL (DROP/TRUNCATE/ALTER/CREATE) always blocked in v1
 * - Result cap: 1000 rows (LIMIT injected when absent) — MCP compliance
 * - 30s timeout contract (measured post-execution for sync SQLite; the row
 *   cap is the primary runaway guard)
 * - Telemetry redaction: string literals + 10+ digit numbers
 */

export const MAX_ROW_LIMIT = 1000
export const QUERY_TIMEOUT_MS = 30_000

/** Structured error codes (ported naming, DB_ prefix for TS space). */
export const DbErrorCode = {
  READONLY_VIOLATION: 'DB_READONLY_VIOLATION',
  WRITE_MODE_REQUIRED: 'DB_WRITE_MODE_REQUIRED',
  DESTRUCTIVE_DDL_BLOCKED: 'DB_DESTRUCTIVE_DDL_BLOCKED',
  QUERY_TIMEOUT: 'DB_QUERY_TIMEOUT',
  ROW_LIMIT_EXCEEDED: 'DB_ROW_LIMIT_EXCEEDED',
  INVALID_SQL: 'DB_INVALID_SQL',
  CONNECTION_FAILED: 'DB_CONNECTION_FAILED',
  QUERY_EXECUTION_FAILED: 'DB_QUERY_EXECUTION_FAILED',
  UNCLASSIFIED_SQL: 'DB_UNCLASSIFIED_SQL',
} as const

export type DbErrorCode = (typeof DbErrorCode)[keyof typeof DbErrorCode]

export class StructuredDbError extends Error {
  readonly code: DbErrorCode
  readonly details?: Record<string, unknown>

  constructor(
    code: DbErrorCode,
    message: string,
    details?: Record<string, unknown>,
  ) {
    super(message)
    this.name = 'StructuredDbError'
    this.code = code
    this.details = details
  }
}

// ============================================================================
// SQL classification (ported ClassifySQL)
// ============================================================================

export type SqlStatementType =
  | 'unknown'
  | 'select'
  | 'insert'
  | 'update'
  | 'delete'
  | 'ddl'
  | 'truncate'
  | 'explain'
  | 'show'
  | 'set'

/**
 * Classify a SQL statement by normalized prefix after stripping comments.
 * Ported from cockroachdb.go ClassifySQL.
 */
export function classifySql(sql: string): SqlStatementType {
  // Normalize: trim and uppercase for prefix analysis.
  let normalized = sql.trim().toUpperCase()

  if (normalized === '') return 'unknown'

  // Remove comments.
  normalized = normalized.replace(/--.*/g, '')
  normalized = normalized.replace(/\/\*.*?\*\//gs, '')
  normalized = normalized.trim()

  if (normalized.startsWith('SELECT')) return 'select'
  if (normalized.startsWith('INSERT')) return 'insert'
  if (normalized.startsWith('UPDATE')) return 'update'
  if (normalized.startsWith('DELETE')) return 'delete'
  if (normalized.startsWith('TRUNCATE')) return 'truncate'
  if (normalized.startsWith('CREATE')) return 'ddl'
  if (normalized.startsWith('ALTER')) return 'ddl'
  if (normalized.startsWith('DROP')) return 'ddl'
  if (normalized.startsWith('EXPLAIN')) return 'explain'
  if (normalized.startsWith('SHOW')) return 'show'
  if (normalized.startsWith('SET')) return 'set'
  return 'unknown'
}

const WRITE_TYPES: ReadonlySet<SqlStatementType> = new Set([
  'insert',
  'update',
  'delete',
  'truncate',
  'ddl',
])

export function isWriteOperation(sqlType: SqlStatementType): boolean {
  return WRITE_TYPES.has(sqlType)
}

// ============================================================================
// LIMIT injection (ported ApplyQueryLimits + stripSQLCommentsAndQuotedText)
// ============================================================================

const limitClauseRegexp = /\bLIMIT\b/i

/**
 * Strip SQL comments and quoted text, replacing them with whitespace so the
 * remaining text can be searched for structural keywords. Returns the
 * searchable text and whether a trailing line comment was present (which
 * forces a newline separator before appending LIMIT).
 * Ported from cockroachdb.go stripSQLCommentsAndQuotedText.
 */
export function stripSqlCommentsAndQuotedText(sql: string): {
  searchable: string
  trailingLineComment: boolean
} {
  let result = ''
  let trailingLineComment = false

  for (let i = 0; i < sql.length;) {
    const ch = sql[i]
    // -- line comment
    if (ch === '-' && sql[i + 1] === '-') {
      trailingLineComment = true
      while (i < sql.length && sql[i] !== '\n') {
        result += ' '
        i++
      }
      continue
    }
    // /* */ block comment (nested depth counted)
    if (ch === '/' && sql[i + 1] === '*') {
      let depth = 1
      result += '  '
      i += 2
      while (i < sql.length && depth > 0) {
        if (sql[i] === '/' && sql[i + 1] === '*') {
          depth++
          result += '  '
          i += 2
        } else if (sql[i] === '*' && sql[i + 1] === '/') {
          depth--
          result += '  '
          i += 2
        } else {
          result += ' '
          i++
        }
      }
      continue
    }
    // '...' or "..." quoted text (with '' / "" escaping and \ escapes)
    if (ch === "'" || ch === '"') {
      const quote = ch
      result += ' '
      i++
      while (i < sql.length) {
        result += ' '
        if (sql[i] === '\\' && i + 1 < sql.length) {
          result += ' '
          i += 2
          continue
        }
        if (sql[i] === quote) {
          if (sql[i + 1] === quote) {
            result += ' '
            i += 2
            continue
          }
          i++
          break
        }
        i++
      }
      continue
    }
    // $tag$...$tag$ dollar-quoted
    if (ch === '$') {
      let end = i + 1
      while (
        end < sql.length &&
        (sql[end] === '_' ||
          (sql[end] >= 'a' && sql[end] <= 'z') ||
          (sql[end] >= 'A' && sql[end] <= 'Z') ||
          (end > i + 1 && sql[end] >= '0' && sql[end] <= '9'))
      ) {
        end++
      }
      if (end >= sql.length || sql[end] !== '$') {
        result += ch
        i++
        continue
      }
      const delimiter = sql.slice(i, end + 1)
      const closing = sql.indexOf(delimiter, end + 1)
      if (closing < 0) {
        result += ch
        i++
        continue
      }
      const quotedLength = end + 1 + closing + delimiter.length - i
      result += ' '.repeat(quotedLength)
      i += quotedLength
      continue
    }
    result += ch
    if (ch === '\n') trailingLineComment = false
    i++
  }

  return { searchable: result, trailingLineComment }
}

/**
 * Apply the row limit to a SELECT query: skip when a LIMIT clause already
 * exists (matching mcp-toolbox behavior), otherwise append `LIMIT n`.
 * Only SELECT queries are limited.
 * Ported from cockroachdb.go ApplyQueryLimits.
 */
export function applyQueryLimits(
  sql: string,
  maxRowLimit: number = MAX_ROW_LIMIT,
): { sql: string; limited: boolean } {
  const sqlType = classifySql(sql)
  if (sqlType !== 'select' || maxRowLimit <= 0) {
    return { sql, limited: false }
  }

  const { searchable, trailingLineComment } = stripSqlCommentsAndQuotedText(sql)
  if (limitClauseRegexp.test(searchable)) {
    return { sql, limited: false }
  }

  // Trim trailing whitespace/semicolon and append LIMIT.
  const trimmedSearchable = searchable.trimEnd()
  if (trimmedSearchable.endsWith(';')) {
    const semiColonIdx = trimmedSearchable.length - 1
    sql = sql.slice(0, semiColonIdx) + sql.slice(semiColonIdx + 1)
  }
  sql = sql.trim()
  const separator = trailingLineComment ? '\n' : ' '
  return { sql: `${sql}${separator}LIMIT ${maxRowLimit}`, limited: true }
}

// ============================================================================
// Telemetry redaction (ported RedactSQL)
// ============================================================================

/** Redact string literals and 10+ digit numbers from SQL for telemetry. */
export function redactSql(sql: string): string {
  return sql.replace(/'[^']*'/g, "'***'").replace(/\b\d{10,}\b/g, '***')
}

// ============================================================================
// Connection resolution
// ============================================================================

/**
 * Resolve the connection target. Precedence: explicit `databaseUrl` param,
 * then SAVANT_CODE_DATABASE_URL, then DATABASE_URL. A missing target is a
 * connection failure (never silently defaults).
 */
export function resolveDatabaseUrl(databaseUrl: string | undefined): string {
  if (databaseUrl && databaseUrl.trim() !== '') return databaseUrl
  const envUrl =
    process.env.SAVANT_CODE_DATABASE_URL ?? process.env.DATABASE_URL
  if (envUrl && envUrl.trim() !== '') return envUrl
  throw new StructuredDbError(
    DbErrorCode.CONNECTION_FAILED,
    'No database connection configured. Pass databaseUrl, or set SAVANT_CODE_DATABASE_URL / DATABASE_URL.',
  )
}

/**
 * Coerce a raw bun:sqlite column value into a JSONValue. BLOB values arrive
 * as Uint8Array and integers can arrive as bigint — neither is JSONValue,
 * and blindly casting would surface at output validation/serialization.
 * BLOB → base64 text (portable); bigint → string.
 */
export function normalizeSqliteValue(value: unknown): JSONValue {
  if (value instanceof Uint8Array) {
    return Buffer.from(value).toString('base64')
  }
  if (typeof value === 'bigint') {
    return value.toString()
  }
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    return value
  }
  // Defensive catch-all: never let a non-JSON value escape the adapter.
  return String(value)
}

/** Map a raw SQLite row to a JSONValue record (BLOB/bigint coerced). */
export function normalizeSqliteRow(
  row: Record<string, unknown>,
): Record<string, JSONValue> {
  const out: Record<string, JSONValue> = {}
  for (const [key, value] of Object.entries(row)) {
    out[key] = normalizeSqliteValue(value)
  }
  return out
}

/** Open a SQLite database (sync). ':memory:' or a file path. */
export function openSqliteDatabase(target: string): Database {
  try {
    const DatabaseCtor = getSqliteDatabaseCtor()
    return new DatabaseCtor(target)
  } catch (error) {
    throw new StructuredDbError(
      DbErrorCode.CONNECTION_FAILED,
      `Failed to open SQLite database: ${
        error instanceof Error ? error.message : String(error)
      }`,
      { target: redactSql(target) },
    )
  }
}

/**
 * Enforce the write gate. Read-only by default; INSERT/UPDATE/DELETE require
 * allowWrite; DROP/TRUNCATE/ALTER/CREATE are always blocked in v1.
 */
export function enforceCanExecuteWrite(sql: string, allowWrite: boolean): void {
  const sqlType = classifySql(sql)

  if (sqlType === 'truncate' || sqlType === 'ddl') {
    throw new StructuredDbError(
      DbErrorCode.DESTRUCTIVE_DDL_BLOCKED,
      'Destructive DDL (DROP/TRUNCATE/ALTER/CREATE) is blocked in v1.',
      { sql_type: sqlType },
    )
  }

  if (isWriteOperation(sqlType) && !allowWrite) {
    throw new StructuredDbError(
      DbErrorCode.WRITE_MODE_REQUIRED,
      'Write statements require allowWrite: true AND explicit per-statement user approval.',
      { sql_type: sqlType, allow_write: allowWrite },
    )
  }

  if (sqlType === 'unknown') {
    throw new StructuredDbError(
      DbErrorCode.UNCLASSIFIED_SQL,
      'Could not classify the SQL statement. Only SELECT/SHOW/EXPLAIN/PRAGMA and explicitly approved writes are allowed.',
      { sql_type: sqlType },
    )
  }
}
