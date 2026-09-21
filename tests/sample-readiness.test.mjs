import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { databaseFixture } from './helpers/database.mjs';
import { testDatabase } from './helpers/postgres.mjs';
import { fixture } from './helpers/submission.mjs';
import { connectDatabase, migrate } from '../server/database.mjs';
import { dashboard } from '../server/store.mjs';
import { checkSampleModelReadiness } from '../server/sample-model-readiness.mjs';

const run = promisify(execFile);

async function insertLegacy(db, id, status, { demo = 0 } = {}) {
  await db.query(
    `INSERT INTO imports(
       id,file_name,sha256,province_code,province,city_code,city,
       submitted_name,report_date,created_at,status,format_version,demo
     ) VALUES($1,'old.xlsx','h','420000','湖北省','420100','武汉市',
       '旧上传','2026-09-01',now(),$2,1,$3)`,
    [id, status, demo],
  );
}

void test('旧真实数据阻止新口径就绪，非阻塞状态与演示数据不影响', async (t) => {
  const db = await databaseFixture(t);
  await insertLegacy(db, 'published', 'published');
  await insertLegacy(db, 'staged', 'staged');
  await insertLegacy(db, 'demo-published', 'published', { demo: 1 });
  await insertLegacy(db, 'withdrawn', 'withdrawn');
  await insertLegacy(db, 'expired', 'expired');
  await insertLegacy(db, 'cancelled', 'cancelled');

  assert.deepEqual(await checkSampleModelReadiness(db), {
    ready: false,
    publishedLegacy: 1,
    unfinishedLegacy: 1,
  });
  await assert.rejects(
    dashboard(db, { demo: false }),
    (error) =>
      error.status === 503 &&
      error.expose === true &&
      /历史检测数据尚未完成新口径核对/.test(error.message),
  );
  assert.equal((await dashboard(db, { demo: true })).metrics.samples, 0);

  await db.query(
    "UPDATE imports SET status='withdrawn' WHERE id='published'; UPDATE imports SET status='cancelled' WHERE id='staged'",
  );
  assert.deepEqual(await checkSampleModelReadiness(db), {
    ready: true,
    publishedLegacy: 0,
    unfinishedLegacy: 0,
  });
});

void test('只读预检 CLI 用退出码和聚合计数表达是否就绪', async (t) => {
  const pg = await testDatabase();
  const db = connectDatabase(pg.url);
  t.after(async () => {
    await db.close();
    await pg.close();
  });
  await migrate(db);
  await insertLegacy(db, 'legacy-ready', 'staged');

  await assert.rejects(
    run(process.execPath, ['scripts/postgres/check-sample-model.mjs'], {
      cwd: new URL('..', import.meta.url),
      env: { ...process.env, DATABASE_URL: pg.url },
    }),
    (error) => {
      assert.equal(error.code, 2);
      assert.deepEqual(JSON.parse(error.stdout), {
        ready: false,
        publishedLegacy: 0,
        unfinishedLegacy: 1,
      });
      assert.doesNotMatch(error.stdout, /postgresql?:\/\//);
      return true;
    },
  );

  await db.query(
    "UPDATE imports SET status='cancelled' WHERE id='legacy-ready'",
  );
  const result = await run(
    process.execPath,
    ['scripts/postgres/check-sample-model.mjs'],
    {
      cwd: new URL('..', import.meta.url),
      env: { ...process.env, DATABASE_URL: pg.url },
    },
  );
  assert.deepEqual(JSON.parse(result.stdout), {
    ready: true,
    publishedLegacy: 0,
    unfinishedLegacy: 0,
  });
});

void test(
  '真实大盘通过 HTTP 返回明确 503，管理接口和演示大盘仍可使用',
  { timeout: 40000 },
  async (t) => {
    const f = await fixture(t);
    const db = connectDatabase(f.pg.url);
    t.after(() => db.close());
    await insertLegacy(db, 'legacy-http', 'published');

    const blocked = await f.request('/dashboard?from=2099-01-01');
    assert.equal(blocked.status, 503);
    assert.match(blocked.data.error, /历史检测数据尚未完成新口径核对/);
    assert.equal((await f.request('/dashboard?demo=1')).status, 200);
    assert.equal((await f.request('/imports')).status, 200);
  },
);
