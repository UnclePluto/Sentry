import { connectDatabase, migrate } from '../../server/database.mjs';
const db = connectDatabase(
  process.env.MIGRATION_DATABASE_URL || process.env.DATABASE_URL,
);
try {
  await migrate(db);
  console.log(JSON.stringify({ event: 'schema_migrated', version: 1 }));
} finally {
  await db.close();
}
