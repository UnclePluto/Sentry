import test from 'node:test';
import assert from 'node:assert/strict';
import { unlink, utimes, readdir } from 'node:fs/promises';
import { fixture, workbook, validRows } from './helpers/submission.mjs';
import { connectDatabase } from '../server/database.mjs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

void test(
  '过期租约接管、原文件丢失、7天暂存及24小时文件清理',
  { timeout: 40000 },
  async (t) => {
    const f = await fixture(t),
      bytes = await workbook(validRows),
      db = connectDatabase(f.pg.url);
    t.after(() => db.close());
    await f.stopWorker();
    const a = (await f.previewRaw(bytes)).data;
    await db.query(
      "UPDATE jobs SET status='running',attempts=1,lease_token='stale',lease_until=now()-interval '1 minute' WHERE id=$1",
      [a.id],
    );
    f.startWorker();
    assert.equal((await f.waitJob(a.id)).data.status, 'ready');
    await f.stopWorker();
    await db.query(
      "UPDATE imports SET expires_at=now()-interval '1 second' WHERE id=$1",
      [a.id],
    );
    assert.equal((await f.post('/imports/commit', { id: a.id })).status, 400);
    const missing = (await f.previewRaw(bytes)).data;
    await unlink(f.dir + '/uploads/' + missing.id + '.xlsx');
    const old = (await f.previewRaw(bytes)).data;
    const yesterday = new Date(Date.now() - 25 * 3600000);
    await utimes(f.dir + '/uploads/' + old.id + '.xlsx', yesterday, yesterday);
    f.startWorker();
    assert.equal((await f.waitJob(a.id, ['expired'])).data.status, 'expired');
    const failure = (await f.waitJob(missing.id)).data;
    assert.equal(failure.status, 'failed');
    assert.match(failure.error, /丢失/);
    assert.equal(failure.retryable, false);
    assert.equal((await f.waitJob(old.id)).data.status, 'failed');
    assert.equal((await readdir(f.dir + '/uploads')).length, 0);
    const tasks = (await f.request('/jobs')).data.items;
    assert.ok(tasks.some((x) => x.id === a.id && x.job_status === 'expired'));
    assert.equal(
      (await db.get('SELECT payload FROM imports WHERE id=$1', a.id)).payload,
      null,
    );
  },
);

void test(
  '汇总损坏可重建；确认、作废与维护写保护',
  { timeout: 40000 },
  async (t) => {
    const f = await fixture(t),
      db = connectDatabase(f.pg.url);
    t.after(() => db.close());
    const p = await f.preview(await workbook(validRows));
    await f.commit(p.data.id);
    const before = (await f.request('/dashboard?pathogen=IAV')).data;
    await db.query(
      'UPDATE import_metrics SET tested=tested+10 WHERE import_id=$1',
      [p.data.id],
    );
    assert.notEqual(
      (await f.request('/dashboard?pathogen=IAV')).data.metrics.tested,
      before.metrics.tested,
    );
    await promisify(execFile)(
      process.execPath,
      ['scripts/postgres/rebuild.mjs'],
      { env: { ...process.env, DATABASE_URL: f.pg.url } },
    );
    const after = (await f.request('/dashboard?pathogen=IAV')).data;
    delete before.updatedAt;
    delete after.updatedAt;
    assert.deepEqual(after, before);
    await db.query('UPDATE dataset_state SET maintenance=true WHERE id=1');
    assert.equal(
      (await f.post('/imports/withdraw', { id: p.data.id })).status,
      503,
    );
    assert.equal((await f.previewRaw(await workbook(validRows))).status, 503);
    assert.equal((await f.request('/dashboard')).status, 200);
    await db.query('UPDATE dataset_state SET maintenance=false WHERE id=1');
    await Promise.all([
      f.post('/imports/withdraw', { id: p.data.id }),
      f.post('/imports/withdraw', { id: p.data.id }),
    ]);
    assert.equal((await f.request('/dashboard')).data.metrics.tested, 0);
  },
);

void test(
  '失去租约的旧解析执行者不得删掉接管任务需要的原文件',
  { timeout: 40000 },
  async (t) => {
    const f = await fixture(t),
      db = connectDatabase(f.pg.url);
    t.after(() => db.close());
    const bytes = await workbook([
      validRows[0],
      ...Array.from({ length: 29999 }, () => ['', '', 'N', '-', '']),
    ]);
    await f.stopWorker();
    const accepted = await f.previewRaw(bytes);
    f.startWorker();
    const id = accepted.data.id;
    let claimed = false;
    for (let i = 0; i < 200; i++) {
      const row = await db.get('SELECT status FROM jobs WHERE id=$1', id);
      if (row.status === 'running') {
        claimed = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.equal(claimed, true);
    // 模拟租约失效及重排；真实旧解析线程随后仍返回，不能删除原文件。
    await db.query(
      "UPDATE jobs SET status='queued',lease_token=NULL,lease_until=NULL WHERE id=$1",
      [id],
    );
    const result = await f.waitJob(id);
    assert.equal(result.data.status, 'ready', JSON.stringify(result.data));
    assert.equal(result.data.summary.tested, 1);
  },
);
