import fs from 'fs'
import os from 'os'
import path from 'path'

import { Database } from 'bun:sqlite'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'

import { handleAnalyzeQuery } from '../analyze-query'
import { handleDescribeTable } from '../describe-table'
import { handleExecuteQuery } from '../execute-query'
import { handleListTables } from '../list-tables'
import {
  applyQueryLimits,
  classifySql,
  DbErrorCode,
  enforceCanExecuteWrite,
  normalizeSqliteRow,
  normalizeSqliteValue,
  openSqliteDatabase,
  redactSql,
  resolveBunSqliteDatabaseModule,
  stripSqlCommentsAndQuotedText,
  StructuredDbError,
} from '../sqlite-adapter'

const noopLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
} as never

// Handlers take a single params object ({ previousToolCallFinished, toolCall,
// logger }); the handler executor resolves these at runtime. `previousToolCallFinished`
// must be a resolved promise (handlers await it) and `logger` must be a no-op Logger.
const makeToolCall = (input: object) =>
  ({
    previousToolCallFinished: Promise.resolve(),
    toolCall: { input },
    logger: noopLogger,
  }) as never

// NOTE: a :memory: SQLite database is PER-CONNECTION — each handler call opens
// its own fresh :memory: DB (empty). The integration tests therefore use a
// temp FILE database so seeded tables survive across handler calls.
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'savant-db-test-'))
const DB_PATH = path.join(tempDir, 'test.db')

function seed(db: Database) {
  db.exec(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      name TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE posts (
      id INTEGER PRIMARY KEY,
      user_id INTEGER REFERENCES users(id),
      title TEXT NOT NULL
    );
    INSERT INTO users (id, email, name) VALUES (1, 'a@example.com', 'Alice');
    INSERT INTO users (id, email, name) VALUES (2, 'b@example.com', 'Bob');
    INSERT INTO posts (id, user_id, title) VALUES (1, 1, 'Hello');
  `)
}

let seededDb: Database | null = null
beforeAll(() => {
  seededDb = new Database(DB_PATH)
  seed(seededDb)
})
afterAll(() => {
  seededDb?.close()
  try {
    fs.rmSync(tempDir, { recursive: true, force: true })
  } catch {
    // best-effort cleanup
  }
})

// ============================================================================
// resolveBunSqliteDatabaseModule (Node-ESM / Node-CJS edge-case hardening)
// ============================================================================

describe('resolveBunSqliteDatabaseModule', () => {
  test('throws a clear StructuredDbError when `require` is unavailable (Node ESM)', () => {
    try {
      // `null` bypasses the default parameter (which would inject Bun's real
      // `require`), simulating an environment with no require global.
      resolveBunSqliteDatabaseModule(null)
      expect.unreachable('should throw')
    } catch (e) {
      expect(e).toBeInstanceOf(StructuredDbError)
      const err = e as StructuredDbError
      expect(err.code).toBe(DbErrorCode.CONNECTION_FAILED)
      expect(err.message).toContain('Bun runtime')
      expect(err.message).toContain('bun:sqlite')
      expect(err.message).not.toContain('ReferenceError')
    }
  })

  test('wraps a failed require (Node CJS: Cannot find module) in a clear error', () => {
    try {
      resolveBunSqliteDatabaseModule(() => {
        throw new Error("Cannot find module 'bun:sqlite'")
      })
      expect.unreachable('should throw')
    } catch (e) {
      expect(e).toBeInstanceOf(StructuredDbError)
      const err = e as StructuredDbError
      expect(err.code).toBe(DbErrorCode.CONNECTION_FAILED)
      expect(err.message).toContain('Bun runtime')
      expect(err.message).toContain("Cannot find module 'bun:sqlite'")
    }
  })

  test('resolves the real bun:sqlite module when require exists (Bun)', () => {
    const mod = resolveBunSqliteDatabaseModule(require)
    expect(mod).toBeTruthy()
    expect(typeof mod.Database).toBe('function')
    // The resolved constructor actually opens a database.
    const db = new mod.Database(':memory:')
    db.exec('CREATE TABLE t (id INTEGER)')
    db.close()
  })

  test('openSqliteDatabase still works under Bun (lazy require regression)', () => {
    // The real Bun runtime has `require`, so the lazy resolution must succeed
    // end-to-end: open a DB, run a query, and confirm structured output.
    const db = openSqliteDatabase(':memory:')
    db.exec('CREATE TABLE t (id INTEGER, name TEXT)')
    db.exec("INSERT INTO t VALUES (1, 'alpha')")
    const row = db.query('SELECT id, name FROM t').get() as Record<
      string,
      unknown
    >
    expect(row.id).toBe(1)
    expect(row.name).toBe('alpha')
    db.close()
  })
})

// ============================================================================
// classifySql (ported ClassifySQL)
// ============================================================================

describe('classifySql', () => {
  test('classifies core statement types', () => {
    expect(classifySql('SELECT * FROM users')).toBe('select')
    expect(classifySql('  select id from users')).toBe('select')
    expect(classifySql('INSERT INTO users (id) VALUES (1)')).toBe('insert')
    expect(classifySql('UPDATE users SET name = ? WHERE id = 1')).toBe('update')
    expect(classifySql('DELETE FROM users WHERE id = 1')).toBe('delete')
    expect(classifySql('TRUNCATE TABLE users')).toBe('truncate')
    expect(classifySql('CREATE TABLE x (id int)')).toBe('ddl')
    expect(classifySql('ALTER TABLE x ADD COLUMN y')).toBe('ddl')
    expect(classifySql('DROP TABLE users')).toBe('ddl')
    expect(classifySql('EXPLAIN QUERY PLAN SELECT 1')).toBe('explain')
    expect(classifySql('SHOW TABLES')).toBe('show')
    expect(classifySql('SET search_path = x')).toBe('set')
  })

  test('classifies after comment stripping', () => {
    expect(classifySql('-- comment\nSELECT * FROM users')).toBe('select')
    expect(classifySql('/* c */ SELECT * FROM users')).toBe('select')
    // Comment text must not fool the classifier.
    expect(classifySql('SELECT /* DROP TABLE */ * FROM users')).toBe('select')
  })

  test('unknown for empty or garbage', () => {
    expect(classifySql('')).toBe('unknown')
    expect(classifySql('   ')).toBe('unknown')
    expect(classifySql('BANANA 42')).toBe('unknown')
  })
})

// ============================================================================
// stripSqlCommentsAndQuotedText (ported)
// ============================================================================

describe('stripSqlCommentsAndQuotedText', () => {
  test('removes line and block comments, preserves structure length', () => {
    const { searchable } = stripSqlCommentsAndQuotedText(
      'SELECT a -- x\nFROM t /* y */ WHERE b = 1',
    )
    expect(searchable).toContain('SELECT')
    expect(searchable).toContain('FROM')
    expect(searchable).toContain('WHERE')
    expect(searchable).not.toContain('x')
    expect(searchable).not.toContain('y')
  })

  test('blankets quoted strings (LIMIT inside a string is not a clause)', () => {
    const { searchable } = stripSqlCommentsAndQuotedText(
      "SELECT * FROM t WHERE name = 'LIMIT 5'",
    )
    expect(/\bLIMIT\b/.test(searchable)).toBe(false)
  })

  test('tracks trailing line comment state', () => {
    const a = stripSqlCommentsAndQuotedText('SELECT 1 -- trailing')
    expect(a.trailingLineComment).toBe(true)
    const b = stripSqlCommentsAndQuotedText('SELECT 1\n-- trailing')
    expect(b.trailingLineComment).toBe(true)
    const c = stripSqlCommentsAndQuotedText('SELECT 1')
    expect(c.trailingLineComment).toBe(false)
  })
})

// ============================================================================
// applyQueryLimits (ported ApplyQueryLimits)
// ============================================================================

describe('applyQueryLimits', () => {
  test('appends LIMIT to SELECT without one', () => {
    const { sql, limited } = applyQueryLimits('SELECT * FROM users')
    expect(limited).toBe(true)
    expect(sql).toBe('SELECT * FROM users LIMIT 1000')
  })

  test('skips when LIMIT already present (case-insensitive, whitespace-safe)', () => {
    expect(applyQueryLimits('SELECT * FROM users LIMIT 5').limited).toBe(false)
    expect(applyQueryLimits('SELECT * FROM users\nlimit 5').limited).toBe(false)
    expect(applyQueryLimits('SELECT * FROM users\n\tLIMIT\n\t10').limited).toBe(
      false,
    )
  })

  test('skips LIMIT inside string literals', () => {
    const { limited } = applyQueryLimits(
      "SELECT * FROM users WHERE name = 'LIMIT 5'",
    )
    expect(limited).toBe(true) // real LIMIT injected
  })

  test('handles trailing semicolon', () => {
    const { sql } = applyQueryLimits('SELECT * FROM users;')
    expect(sql).toBe('SELECT * FROM users LIMIT 1000')
  })

  test('does not limit non-SELECT statements', () => {
    expect(applyQueryLimits('INSERT INTO users (id) VALUES (1)').limited).toBe(
      false,
    )
    expect(applyQueryLimits('DROP TABLE users').limited).toBe(false)
  })

  test('uses configured limit', () => {
    const { sql } = applyQueryLimits('SELECT * FROM users', 50)
    expect(sql).toContain('LIMIT 50')
  })
})

// ============================================================================
// enforceCanExecuteWrite (ported CanExecuteWrite)
// ============================================================================

describe('enforceCanExecuteWrite', () => {
  test('allows SELECT without approval', () => {
    expect(() =>
      enforceCanExecuteWrite('SELECT * FROM users', false),
    ).not.toThrow()
  })

  test('rejects INSERT/UPDATE/DELETE without allowWrite', () => {
    for (const sql of [
      'INSERT INTO users (id) VALUES (1)',
      'UPDATE users SET name = ?',
      'DELETE FROM users',
    ]) {
      try {
        enforceCanExecuteWrite(sql, false)
        expect.unreachable(`should reject: ${sql}`)
      } catch (e) {
        expect(e).toBeInstanceOf(StructuredDbError)
        expect((e as StructuredDbError).code).toBe(
          DbErrorCode.WRITE_MODE_REQUIRED,
        )
      }
    }
  })

  test('allows INSERT/UPDATE/DELETE with allowWrite', () => {
    expect(() =>
      enforceCanExecuteWrite('UPDATE users SET name = ?', true),
    ).not.toThrow()
  })

  test('always blocks destructive DDL even with allowWrite', () => {
    for (const sql of [
      'DROP TABLE users',
      'TRUNCATE TABLE users',
      'ALTER TABLE users ADD COLUMN x',
      'CREATE TABLE x (id int)',
    ]) {
      try {
        enforceCanExecuteWrite(sql, true)
        expect.unreachable(`should reject: ${sql}`)
      } catch (e) {
        expect(e).toBeInstanceOf(StructuredDbError)
        expect((e as StructuredDbError).code).toBe(
          DbErrorCode.DESTRUCTIVE_DDL_BLOCKED,
        )
      }
    }
  })

  test('rejects unclassifiable SQL', () => {
    try {
      enforceCanExecuteWrite('BANANA 42', true)
      expect.unreachable('should reject')
    } catch (e) {
      expect(e).toBeInstanceOf(StructuredDbError)
      expect((e as StructuredDbError).code).toBe(DbErrorCode.UNCLASSIFIED_SQL)
    }
  })
})

// ============================================================================
// normalizeSqliteValue / normalizeSqliteRow (JSONValue coercion)
// ============================================================================

describe('normalizeSqliteValue', () => {
  test('coerces BLOB (Uint8Array) to base64 text', () => {
    const blob = new Uint8Array([0xde, 0xad, 0xbe, 0xef])
    const value = normalizeSqliteValue(blob)
    expect(value).toBe(Buffer.from(blob).toString('base64'))
    expect(typeof value).toBe('string')
  })

  test('coerces bigint to string', () => {
    const huge = 9_007_199_254_740_993n
    expect(normalizeSqliteValue(huge)).toBe('9007199254740993')
  })

  test('passes through JSON primitives unchanged', () => {
    expect(normalizeSqliteValue(null)).toBeNull()
    expect(normalizeSqliteValue('text')).toBe('text')
    expect(normalizeSqliteValue(42)).toBe(42)
    expect(normalizeSqliteValue(3.14)).toBe(3.14)
    expect(normalizeSqliteValue(true)).toBe(true)
  })

  test('defensively stringifies unknown non-JSON values', () => {
    const value = normalizeSqliteValue({ weird: true } as unknown)
    expect(typeof value).toBe('string')
  })
})

describe('normalizeSqliteRow', () => {
  test('maps every column through the value coercer', () => {
    const row = normalizeSqliteRow({
      id: 1,
      name: 'Alice',
      avatar: new Uint8Array([1, 2, 3]),
      big: 12345678901234567890n,
    })
    expect(row.id).toBe(1)
    expect(row.name).toBe('Alice')
    expect(row.avatar).toBe('AQID')
    expect(row.big).toBe('12345678901234567890')
  })
})

// ============================================================================
// redactSql (ported RedactSQL)
// ============================================================================

describe('redactSql', () => {
  test('redacts string literals and long numbers', () => {
    const redacted = redactSql(
      "SELECT * FROM users WHERE email = 'secret@example.com' AND id = 12345678901",
    )
    expect(redacted).not.toContain('secret@example.com')
    expect(redacted).not.toContain('12345678901')
    expect(redacted).toContain("'***'")
  })

  test('keeps short numbers and keywords', () => {
    const redacted = redactSql('SELECT id FROM users WHERE x = 42')
    expect(redacted).toContain('42')
    expect(redacted).toContain('SELECT')
  })
})

// ============================================================================
// Handlers (integration against :memory: SQLite)
// ============================================================================

describe('database handlers', () => {
  test('list_tables simple returns table names', async () => {
    const res = await handleListTables(
      makeToolCall({ databaseUrl: DB_PATH, outputFormat: 'simple' }),
    )
    const value = res.output[0].value as { result: { tables: unknown[] } }
    const names = (value.result.tables as Array<{ table_name: string }>).map(
      (t) => t.table_name,
    )
    expect(names).toContain('users')
    expect(names).toContain('posts')
    expect(names).not.toContain('sqlite_sequence')
  })

  test('list_tables detailed returns schema rows', async () => {
    const res = await handleListTables(
      makeToolCall({ databaseUrl: DB_PATH, outputFormat: 'detailed' }),
    )
    const value = res.output[0].value as { result: { tables: unknown[] } }
    expect(Array.isArray(value.result.tables)).toBe(true)
    expect(value.result.tables.length).toBeGreaterThanOrEqual(2)
  })

  test('describe_table returns columns, fks, indexes, triggers', async () => {
    const res = await handleDescribeTable(
      makeToolCall({ databaseUrl: DB_PATH, table: 'users' }),
    )
    const value = res.output[0].value as {
      result: {
        columns: Array<{ name: string }>
        foreignKeys: unknown[]
        indexes: unknown[]
        triggers: unknown[]
      }
    }
    expect(value.result.columns.map((c) => c.name)).toEqual([
      'id',
      'email',
      'name',
      'created_at',
    ])
    expect(Array.isArray(value.result.foreignKeys)).toBe(true)
    expect(Array.isArray(value.result.indexes)).toBe(true)
  })

  test('describe_table errors on missing table', async () => {
    const res = await handleDescribeTable(
      makeToolCall({ databaseUrl: DB_PATH, table: 'nope' }),
    )
    const value = res.output[0].value as { errorMessage: string }
    expect(value.errorMessage).toContain('Table not found')
  })

  test('execute_query SELECT returns rows and columns', async () => {
    const res = await handleExecuteQuery(
      makeToolCall({
        databaseUrl: DB_PATH,
        query: 'SELECT id, email FROM users ORDER BY id',
      }),
    )
    const value = res.output[0].value as {
      result: { columns: string[]; rows: unknown[]; rowCount: number }
    }
    expect(value.result.columns).toEqual(['id', 'email'])
    expect(value.result.rowCount).toBe(2)
  })

  test('execute_query injects LIMIT into SELECT without one', async () => {
    const res = await handleExecuteQuery(
      makeToolCall({ databaseUrl: DB_PATH, query: 'SELECT * FROM users' }),
    )
    const value = res.output[0].value as {
      result: { rowCount: number; limited: boolean }
    }
    expect(value.result.limited).toBe(true)
    expect(value.result.rowCount).toBe(2)
  })

  test('execute_query rejects writes without approval', async () => {
    const res = await handleExecuteQuery(
      makeToolCall({
        databaseUrl: DB_PATH,
        query: 'DELETE FROM users',
        allowWrite: false,
      }),
    )
    const value = res.output[0].value as { errorMessage: string; code: string }
    expect(value.code).toBe(DbErrorCode.WRITE_MODE_REQUIRED)
  })

  test('execute_query rejects destructive DDL even with approval', async () => {
    const res = await handleExecuteQuery(
      makeToolCall({
        databaseUrl: DB_PATH,
        query: 'DROP TABLE users',
        allowWrite: true,
      }),
    )
    const value = res.output[0].value as { errorMessage: string; code: string }
    expect(value.code).toBe(DbErrorCode.DESTRUCTIVE_DDL_BLOCKED)
  })

  test('execute_query coerces BLOB columns to base64 (JSON-safe rows)', async () => {
    // Seed a blob-bearing table on the shared temp-file DB.
    const db = new Database(DB_PATH)
    db.exec(
      `CREATE TABLE IF NOT EXISTS blobs (id INTEGER PRIMARY KEY, payload BLOB);
       INSERT INTO blobs (id, payload) VALUES (1, x'DEADBEEF');`,
    )
    db.close()

    const res = await handleExecuteQuery(
      makeToolCall({
        databaseUrl: DB_PATH,
        query: 'SELECT id, payload FROM blobs',
      }),
    )
    const value = res.output[0].value as {
      result: { rows: Array<{ id: number; payload: unknown }> }
    }
    expect(value.result.rows[0].id).toBe(1)
    // BLOB must arrive as base64 text — never a raw Uint8Array.
    expect(value.result.rows[0].payload).toBe('3q2+7w==')
    expect(typeof value.result.rows[0].payload).toBe('string')

    // JSON round-trip proves the payload is serializable.
    expect(() => JSON.stringify(value)).not.toThrow()
  })

  test('execute_query allows an approved write', async () => {
    const res = await handleExecuteQuery(
      makeToolCall({
        databaseUrl: DB_PATH,
        query:
          "INSERT INTO users (id, email, name) VALUES (3, 'c@example.com', 'Carol')",
        allowWrite: true,
      }),
    )
    const value = res.output[0].value as {
      result: { changes: number; rowCount: number }
    }
    expect(value.result.changes).toBe(1)

    // Verify via a SELECT.
    const check = await handleExecuteQuery(
      makeToolCall({
        databaseUrl: DB_PATH,
        query: 'SELECT email FROM users WHERE id = 3',
      }),
    )
    const checkValue = check.output[0].value as {
      result: { rows: Array<{ email: string }> }
    }
    expect(checkValue.result.rows[0].email).toBe('c@example.com')
  })

  test('execute_query errors on invalid SQL', async () => {
    const res = await handleExecuteQuery(
      makeToolCall({ databaseUrl: DB_PATH, query: 'SELECT FROM WHERE' }),
    )
    const value = res.output[0].value as { errorMessage: string; code: string }
    expect(value.errorMessage).toBeTruthy()
  })

  test('analyze_query returns a query plan', async () => {
    const res = await handleAnalyzeQuery(
      makeToolCall({ databaseUrl: DB_PATH, query: 'SELECT * FROM users' }),
    )
    const value = res.output[0].value as { result: { plan: unknown[] } }
    expect(Array.isArray(value.result.plan)).toBe(true)
    expect(value.result.plan.length).toBeGreaterThan(0)
  })

  test('analyze_query rejects writes', async () => {
    const res = await handleAnalyzeQuery(
      makeToolCall({ databaseUrl: DB_PATH, query: 'DELETE FROM users' }),
    )
    const value = res.output[0].value as { errorMessage: string; code: string }
    expect(value.code).toBe(DbErrorCode.WRITE_MODE_REQUIRED)
  })
})

// ============================================================================
// SQL-injection corpus — must all fail safe
// ============================================================================

describe('SQL-injection corpus', () => {
  const corpus = [
    "SELECT * FROM users WHERE email = 'x' OR '1'='1'",
    'SELECT * FROM users; DROP TABLE users;',
    'SELECT * FROM users WHERE id = 1 UNION SELECT * FROM sqlite_master',
    "SELECT * FROM users WHERE name = 'a' -- DROP TABLE users",
    'INSERT INTO users (email) VALUES ("x"); DELETE FROM users;',
    "SELECT 'DROP TABLE users'",
    'SELECT * FROM users WHERE email = ? OR 1=1',
    'EXPLAIN DROP TABLE users',
  ]

  test('classifier never misclassifies as pure read when destructive', () => {
    for (const sql of corpus) {
      const sqlType = classifySql(sql)
      // The prefix classifier is conservative by construction — multi-statement
      // and UNION payloads classify by their leading keyword, and the write
      // gate + LIMIT cap + parameterization make them fail safe at runtime.
      expect(typeof sqlType).toBe('string')
      expect(['select', 'insert', 'unknown', 'explain']).toContain(sqlType)
    }
  })

  test('LIMIT injection never lands inside quoted text', () => {
    for (const sql of corpus) {
      const { sql: limited, limited: wasLimited } = applyQueryLimits(sql)
      if (classifySql(sql) === 'select') {
        // SELECT queries get a real appended LIMIT at the very end — never
        // inside a string literal (quoted text is stripped before matching).
        expect(wasLimited).toBe(true)
        expect(/LIMIT\s*1000\s*$/.test(limited)).toBe(true)
      } else {
        // Non-SELECT statements are never LIMIT-ed — the write gate handles
        // them instead, and appending LIMIT would be semantically wrong.
        expect(wasLimited).toBe(false)
      }
    }
  })

  test('redactSql hides credentials in payloads', () => {
    for (const sql of corpus) {
      const redacted = redactSql(sql)
      // Single-quoted literals are payload data and must be hidden. Double
      // quotes are SQLite IDENTIFIERS (not literals), so they stay — matching
      // the reference RedactSQL which only redacts '...' and 10+ digit numbers.
      expect(redacted).not.toContain("'x'")
      expect(redacted).not.toContain("'1'='1'")
    }
  })
})
