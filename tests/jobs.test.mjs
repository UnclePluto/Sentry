import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir } from 'node:fs/promises';
import { fixture, workbook, validRows } from './helpers/submission.mjs';

void test(
  '排队任务跨服务重启保留、取消、重复确认原子发布、历史分页',
  { timeout: 40000 },
  async (t) => {
    const f = await fixture(t);
    await f.stopWorker();
    const queued = await f.previewRaw(await workbook(validRows));
    assert.equal(queued.status, 202);
    assert.equal(
      (await f.request('/jobs/' + queued.data.id)).data.status,
      'queued',
    );
    assert.equal((await f.request('/dashboard')).data.metrics.tested, 0);
    await f.stop();
    await f.start();
    assert.equal(
      (await f.request('/jobs/' + queued.data.id)).data.status,
      'queued',
    );
    f.startWorker();
    const ready = await f.waitJob(queued.data.id);
    assert.equal(ready.data.status, 'ready');
    assert.equal((await readdir(f.dir + '/uploads')).length, 0);
    const responses = await Promise.all(
      Array.from({ length: 3 }, () =>
        f.post('/imports/commit', { id: ready.data.id }),
      ),
    );
    assert.ok(responses.every((r) => r.status === 202));
    assert.equal(
      (await f.waitJob(ready.data.id, ['succeeded', 'failed'])).data.status,
      'succeeded',
    );
    assert.equal((await f.request('/dashboard')).data.metrics.tested, 2);
    const h = (await f.request('/imports?page=1&pageSize=1')).data;
    assert.equal(h.total, 1);
    assert.equal(h.items.length, 1);
    assert.equal(
      (await f.request('/imports?page=2&pageSize=1')).data.items.length,
      0,
    );
    await f.stopWorker();
    const cancelled = await f.previewRaw(await workbook(validRows));
    assert.equal(
      (await f.post('/jobs/cancel', { id: cancelled.data.id })).status,
      200,
    );
    assert.equal(
      (await f.request('/jobs/' + cancelled.data.id)).data.status,
      'cancelled',
    );
    assert.equal((await readdir(f.dir + '/uploads')).length, 0);
    assert.equal(
      (await f.post('/imports/commit', { id: cancelled.data.id })).status,
      400,
    );
  },
);

void test(
  '三万非空行边界含对照：30000 接受，30001 异步业务失败',
  { timeout: 60000 },
  async (t) => {
    const f = await fixture(t);
    const rows = [
      validRows[0],
      ...Array.from({ length: 29999 }, () => ['', '', 'N', '-', '']),
    ];
    const accepted = await f.preview(await workbook(rows));
    assert.equal(accepted.data.status, 'ready', JSON.stringify(accepted.data));
    assert.equal(accepted.data.summary.excluded, 29999);
    const rejected = await f.preview(
      await workbook([...rows, ['', '', 'N', '-', '']]),
    );
    assert.equal(rejected.data.status, 'failed');
    assert.match(rejected.data.error, /30,000/);
    assert.equal((await f.request('/dashboard')).data.metrics.tested, 0);
  },
);

void test(
  '上传中断或原文件无法写盘时不登记受理任务',
  { timeout: 40000 },
  async (t) => {
    const f = await fixture(t);
    const http = await import('node:http');
    const request = http.request(
      f.baseUrl() +
        '/imports/preview?province_code=420000&city_code=420100&date=2026-09-01&filename=interrupted.xlsx',
      {
        method: 'POST',
        headers: { 'Content-Length': '100000', cookie: f.getCookie() },
      },
    );
    request.on('error', () => {});
    request.write(Buffer.alloc(100));
    await new Promise((r) => setTimeout(r, 80));
    request.destroy();
    await new Promise((r) => setTimeout(r, 80));
    assert.equal((await f.request('/jobs')).data.total, 0);
    const { mkdir, chmod } = await import('node:fs/promises');
    await mkdir(f.dir + '/uploads', { recursive: true });
    await chmod(f.dir + '/uploads', 0o500);
    try {
      assert.equal((await f.previewRaw(await workbook(validRows))).status, 500);
      assert.equal((await f.request('/jobs')).data.total, 0);
      assert.equal((await readdir(f.dir + '/uploads')).length, 0);
    } finally {
      await chmod(f.dir + '/uploads', 0o700);
    }
  },
);
