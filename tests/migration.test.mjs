import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fixture } from './helpers/submission.mjs';
import { connectDatabase } from '../server/database.mjs';
import { checkSampleModelReadiness } from '../server/sample-model-readiness.mjs';

const run = promisify(execFile);
void test(
  '旧数据升级：未知归属作废、对照剔除、清理原文件，演示与重启一致',
  { timeout: 40000 },
  async (t) => {
    const f = await fixture(t, { legacy: true, demo: true });
    const backups = await readdir(f.dir + '/snapshots');
    assert.equal(backups.length, 1);
    const history = (await f.request('/imports')).data.items;
    assert.equal(history.length, 1);
    assert.equal(history[0].status, 'withdrawn');
    assert.equal(history[0].summary.tested, 1);
    assert.equal(history[0].summary.excluded, 1);
    assert.match(history[0].submitted_name, /归属未知/);
    assert.equal((await f.request('/dashboard')).data.metrics.tested, 0);
    const demo = (await f.request('/dashboard?demo=1')).data;
    assert.ok(demo.metrics.tested > 0);
    assert.equal(demo.metrics.untested, 0);
    assert.ok(!demo.ranking.some((r) => r.code === 'N'));
    assert.ok(
      !(await readdir(f.dir, { recursive: true })).some((x) =>
        x.endsWith('.xlsx'),
      ),
    );
    await f.stop();
    await f.start();
    assert.equal(
      (await f.request('/dashboard?demo=1')).data.metrics.tested,
      demo.metrics.tested,
    );
    assert.equal((await f.request('/imports')).data.items.length, 1);
    assert.equal((await f.request('/auth/me')).status, 200);
    assert.deepEqual(await readdir(f.dir + '/snapshots'), backups);
  },
);

void test(
  '旧有效待确认任务改为不可发布的已取消状态并保留审计 payload',
  { timeout: 40000 },
  async (t) => {
    const f = await fixture(t, { legacy: true, readyPreview: true });
    const tasks = (await f.request('/jobs')).data.items;
    const task = tasks.find((item) => item.id === 'ready-preview');
    assert.equal(task.job_status, 'cancelled');
    assert.match(task.error, /旧格式预览请重新上传/);
    assert.equal(
      (await f.post('/imports/commit', { id: 'ready-preview' })).status,
      400,
    );

    const db = connectDatabase(f.pg.url);
    t.after(() => db.close());
    const migrated = await db.get(
      "SELECT status,format_version,payload IS NOT NULL has_payload FROM imports WHERE id='ready-preview'",
    );
    assert.deepEqual(migrated, {
      status: 'cancelled',
      format_version: 1,
      has_payload: true,
    });
    assert.deepEqual(await checkSampleModelReadiness(db), {
      ready: true,
      publishedLegacy: 0,
      unfinishedLegacy: 0,
    });
  },
);

void test(
  '旧真实已发布数据完整保留并阻止新版真实大盘，重复导入拒绝覆盖',
  { timeout: 40000 },
  async (t) => {
    const f = await fixture(t, { legacy: true, publishedLegacy: true });
    const blocked = await f.request('/dashboard');
    assert.equal(blocked.status, 503);
    assert.match(blocked.data.error, /历史检测数据尚未完成新口径核对/);
    assert.equal((await f.request('/dashboard?demo=1')).status, 200);

    const db = connectDatabase(f.pg.url);
    t.after(() => db.close());
    assert.deepEqual(await checkSampleModelReadiness(db), {
      ready: false,
      publishedLegacy: 1,
      unfinishedLegacy: 0,
    });
    assert.equal(
      (
        await db.get(
          'SELECT count(*) n FROM imports WHERE format_version=1 AND status=\'published\'',
        )
      ).n,
      1,
    );
    assert.equal(
      (
        await db.get(
          'SELECT checksum FROM schema_migrations WHERE version=1',
        )
      ).checksum,
      'e280af173242b3c7931123eadb77c3bca2559d997926a9705cf1d1c1b9be0192',
    );
    assert.equal((await db.get('SELECT count(*) n FROM import_pathogens')).n, 0);
    assert.equal((await db.get('SELECT count(*) n FROM sample_detections')).n, 0);
    assert.equal(
      (
        await db.get(
          'SELECT count(*) n FROM samples WHERE format_version=2',
        )
      ).n,
      0,
    );

    await assert.rejects(
      run(
        process.execPath,
        [
          'scripts/postgres/import-sqlite.mjs',
          '--source',
          f.dir + '/sentry.sqlite',
          '--snapshot-dir',
          f.dir + '/snapshots-second',
        ],
        { env: { ...process.env, DATABASE_URL: f.pg.url } },
      ),
      /迁移目标必须为空/,
    );
  },
);

void test(
  '空旧库和仅旧演示数据均不阻止真实新口径就绪',
  { timeout: 40000 },
  async (t) => {
    const empty = await fixture(t, { legacy: true, emptyLegacy: true });
    const emptyDb = connectDatabase(empty.pg.url);
    t.after(() => emptyDb.close());
    assert.deepEqual(await checkSampleModelReadiness(emptyDb), {
      ready: true,
      publishedLegacy: 0,
      unfinishedLegacy: 0,
    });
    assert.equal((await empty.request('/dashboard')).status, 200);

    const demo = await fixture(t, { legacy: true, legacyDemo: true });
    const demoDb = connectDatabase(demo.pg.url);
    t.after(() => demoDb.close());
    assert.deepEqual(await checkSampleModelReadiness(demoDb), {
      ready: true,
      publishedLegacy: 0,
      unfinishedLegacy: 0,
    });
    const legacyDemo = await demoDb.get(
      "SELECT status,format_version,demo FROM imports WHERE id='legacy'",
    );
    assert.deepEqual(legacyDemo, {
      status: 'published',
      format_version: 1,
      demo: 1,
    });
    assert.equal((await demo.request('/dashboard')).status, 200);
  },
);

void test(
  '旧过期预览保留可见任务摘要，不自动发布或恢复有效期',
  { timeout: 40000 },
  async (t) => {
    const f = await fixture(t, { legacy: true, expiredPreview: true });
    const tasks = (await f.request('/jobs')).data.items;
    assert.ok(
      tasks.some(
        (j) => j.id === 'expired-preview' && j.job_status === 'expired',
      ),
    );
    assert.equal(
      (await f.post('/imports/commit', { id: 'expired-preview' })).status,
      400,
    );
    assert.equal((await f.request('/dashboard')).data.metrics.tested, 0);
  },
);
