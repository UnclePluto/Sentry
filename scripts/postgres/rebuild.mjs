import { connectDatabase } from '../../server/database.mjs';
import { rebuildAll } from '../../server/store.mjs';
const db = connectDatabase();
try {
  await rebuildAll(db);
  console.log(JSON.stringify({ event: 'summaries_rebuilt' }));
} finally {
  await db.close();
}
