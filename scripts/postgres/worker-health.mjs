import { connectDatabase } from '../../server/database.mjs';
const db = connectDatabase();
try {
  if (
    !(await db.get(
      "SELECT id FROM worker_heartbeats WHERE seen_at>now()-interval '90 seconds' LIMIT 1",
    ))
  )
    process.exitCode = 1;
} catch {
  process.exitCode = 1;
} finally {
  await db.close();
}
