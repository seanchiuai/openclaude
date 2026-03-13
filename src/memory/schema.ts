import type { DatabaseSync } from "node:sqlite";

export const EMBEDDING_CACHE_TABLE = "embedding_cache";
export const FTS_TABLE = "chunks_fts";
export const VECTOR_TABLE = "chunks_vec";

function ensureColumn(
  db: DatabaseSync,
  table: string,
  column: string,
  definition: string,
): void {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{
    name: string;
  }>;
  if (rows.some((row) => row.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

export function ensureMemorySchema(db: DatabaseSync): {
  ftsAvailable: boolean;
  ftsError?: string;
} {
  db.exec(`
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS files (
      path TEXT PRIMARY KEY,
      source TEXT NOT NULL DEFAULT 'memory',
      hash TEXT NOT NULL,
      mtime INTEGER NOT NULL,
      size INTEGER NOT NULL
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS chunks (
      id TEXT PRIMARY KEY,
      path TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'memory',
      start_line INTEGER NOT NULL,
      end_line INTEGER NOT NULL,
      hash TEXT NOT NULL,
      model TEXT NOT NULL,
      text TEXT NOT NULL,
      embedding TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);

  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_chunks_path ON chunks(path)`,
  );
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_chunks_source ON chunks(source)`,
  );

  db.exec(`
    CREATE TABLE IF NOT EXISTS ${EMBEDDING_CACHE_TABLE} (
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      provider_key TEXT NOT NULL,
      hash TEXT NOT NULL,
      embedding TEXT NOT NULL,
      dims INTEGER,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (provider, model, provider_key, hash)
    )
  `);

  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_embedding_cache_updated_at ON ${EMBEDDING_CACHE_TABLE}(updated_at)`,
  );

  // Backward compat columns
  ensureColumn(db, "files", "source", "TEXT NOT NULL DEFAULT 'memory'");
  ensureColumn(db, "chunks", "source", "TEXT NOT NULL DEFAULT 'memory'");

  // FTS5 — standalone table (not content-sync) so we insert/query directly
  let ftsAvailable = false;
  let ftsError: string | undefined;

  try {
    db.exec(
      `CREATE VIRTUAL TABLE IF NOT EXISTS ${FTS_TABLE} USING fts5(\n` +
        `  text,\n` +
        `  id UNINDEXED,\n` +
        `  path UNINDEXED,\n` +
        `  source UNINDEXED,\n` +
        `  model UNINDEXED,\n` +
        `  start_line UNINDEXED,\n` +
        `  end_line UNINDEXED\n` +
        `)`,
    );
    ftsAvailable = true;
  } catch (err: unknown) {
    ftsError =
      err instanceof Error ? err.message : "Unknown FTS5 initialization error";
  }

  return { ftsAvailable, ftsError };
}
