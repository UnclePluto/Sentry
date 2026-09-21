import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { connectDatabase, migrate } from '../../server/database.mjs';
import { testDatabase } from './postgres.mjs';

export async function databaseFixture(t, { version = 2 } = {}) {
  const pg = await testDatabase();
  const db = connectDatabase(pg.url);
  t.after(async () => {
    await db.close();
    await pg.close();
  });
  if (version === 1) {
    const sql = await readFile(
      new URL('../../server/schema.sql', import.meta.url),
      'utf8',
    );
    await db.transaction(async (tx) => {
      await tx.exec(sql);
      await tx.exec(
        'CREATE TABLE schema_migrations(version integer PRIMARY KEY,checksum text NOT NULL,applied_at timestamptz NOT NULL DEFAULT now())',
      );
      await tx.query(
        'INSERT INTO schema_migrations(version,checksum) VALUES(1,$1)',
        [createHash('sha256').update(sql).digest('hex')],
      );
    });
  } else await migrate(db);
  return db;
}
