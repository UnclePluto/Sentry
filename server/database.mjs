import pg from 'pg';
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
const migrations = [
  { version: 1, url: new URL('./schema.sql', import.meta.url) },
  {
    version: 2,
    url: new URL(
      './migrations/002-sample-pathogen-model.sql',
      import.meta.url,
    ),
  },
];
pg.types.setTypeParser(20, (v) => {
  const n = Number(v);
  if (!Number.isSafeInteger(n)) throw Error('数据库整数超出安全范围');
  return n;
});
pg.types.setTypeParser(1082, (v) => v);
pg.types.setTypeParser(1184, (v) => new Date(v).toISOString());
export function connectDatabase(connectionString = process.env.DATABASE_URL) {
  if (!connectionString && process.env.DATABASE_URL_FILE)
    connectionString = readFileSync(
      process.env.DATABASE_URL_FILE,
      'utf8',
    ).trim();
  if (!connectionString)
    throw Error('必须配置 DATABASE_URL，生产运行不支持 SQLite 回退');
  const pool = new pg.Pool({
    connectionString,
    max: Number(process.env.PG_POOL_MAX || 5),
    connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 30000,
    statement_timeout: 30000,
    idle_in_transaction_session_timeout: 30000,
    application_name: 'sentry',
  });
  pool.on('error', (e) =>
    console.error(
      JSON.stringify({
        event: 'database_pool_error',
        code: e.code || 'unknown',
      }),
    ),
  );
  const db = session(pool);
  db.close = () => pool.end();
  db.transaction = async (fn, { readOnly = false } = {}) => {
    const client = await pool.connect();
    try {
      await client.query(
        readOnly ? 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY' : 'BEGIN',
      );
      const value = await fn(session(client));
      await client.query('COMMIT');
      return value;
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      throw e;
    } finally {
      client.release();
    }
  };
  return db;
}
function session(client) {
  return {
    query: (sql, values = []) => client.query(sql, values),
    exec: (sql) => client.query(sql),
    get: async (sql, ...values) => (await client.query(sql, values)).rows[0],
    all: async (sql, ...values) => (await client.query(sql, values)).rows,
    run: async (sql, ...values) => {
      const r = await client.query(sql, values);
      return { changes: r.rowCount, rows: r.rows };
    },
  };
}
export async function migrate(db) {
  const loaded = await Promise.all(
    migrations.map(async (migration) => {
      const sql = await readFile(migration.url, 'utf8');
      return {
        ...migration,
        sql,
        checksum: createHash('sha256').update(sql).digest('hex'),
      };
    }),
  );
  await db.transaction(async (tx) => {
    await tx.query('SELECT pg_advisory_xact_lock(78230401)');
    await tx.query(
      'CREATE TABLE IF NOT EXISTS schema_migrations(version integer PRIMARY KEY,checksum text NOT NULL,applied_at timestamptz NOT NULL DEFAULT now())',
    );
    for (const migration of loaded) {
      const prior = await tx.get(
        'SELECT checksum FROM schema_migrations WHERE version=$1',
        migration.version,
      );
      if (prior && prior.checksum !== migration.checksum)
        throw Error(
          `迁移版本 ${migration.version} 校验不一致，请使用新版本迁移，禁止修改已应用迁移`,
        );
      if (prior) continue;
      await tx.query(migration.sql);
      await tx.query(
        'INSERT INTO schema_migrations(version,checksum) VALUES($1,$2)',
        [migration.version, migration.checksum],
      );
    }
  });
}
export async function verifySchema(db) {
  const loaded = await Promise.all(
    migrations.map(async (migration) => {
      const sql = await readFile(migration.url, 'utf8');
      return {
        version: migration.version,
        checksum: createHash('sha256').update(sql).digest('hex'),
      };
    }),
  );
  for (const migration of loaded) {
    const row = await db.get(
      'SELECT checksum FROM schema_migrations WHERE version=$1',
      migration.version,
    );
    if (!row) throw Error(`数据库迁移版本 ${migration.version} 尚未完成`);
    if (row.checksum !== migration.checksum)
      throw Error(`数据库迁移版本 ${migration.version} 校验不一致`);
  }
}
