import pg from 'pg';
import { randomUUID } from 'node:crypto';
export async function testDatabase() {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) throw Error('集成测试必须配置隔离的 TEST_DATABASE_URL');
  const pool = new pg.Pool({ connectionString: url });
  const name = 'sentry_test_' + randomUUID().replaceAll('-', '');
  await pool.query(`CREATE DATABASE "${name}"`);
  const target = new URL(url);
  target.pathname = '/' + name;
  return {
    url: target.toString(),
    close: async () => {
      await pool.query(`DROP DATABASE "${name}" WITH (FORCE)`);
      await pool.end();
    },
  };
}
