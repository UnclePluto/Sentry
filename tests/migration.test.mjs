import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir } from 'node:fs/promises';
import { fixture } from './helpers/submission.mjs';
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
