import { connectDatabase } from '../../server/database.mjs';
import { checkSampleModelReadiness } from '../../server/sample-model-readiness.mjs';

if (!process.env.DATABASE_URL && !process.env.DATABASE_URL_FILE)
  throw Error('必须显式配置 DATABASE_URL 或 DATABASE_URL_FILE');

const db = connectDatabase();
try {
  const report = await db.transaction(
    (tx) => checkSampleModelReadiness(tx),
    { readOnly: true },
  );
  console.log(JSON.stringify(report));
  process.exitCode = report.ready ? 0 : 2;
} finally {
  await db.close();
}
