import { connectDatabase } from '../../server/database.mjs';
const mode = process.argv[2];
if (!['on', 'off', 'status'].includes(mode))
  throw Error('使用 maintenance.mjs on|off|status');
const db = connectDatabase();
try {
  if (mode !== 'status')
    await db.query('UPDATE dataset_state SET maintenance=$1 WHERE id=1', [
      mode === 'on',
    ]);
  console.log(
    JSON.stringify(
      await db.get(
        'SELECT maintenance,revision,updated_at FROM dataset_state WHERE id=1',
      ),
    ),
  );
} finally {
  await db.close();
}
