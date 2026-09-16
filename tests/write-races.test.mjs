import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { fixture, workbook, validRows } from './helpers/submission.mjs';
import { connectDatabase } from '../server/database.mjs';

void test(
  '慢请求期间停用或重置密码，补完请求体后不能提交',
  { timeout: 40000 },
  async (t) => {
    const f = await fixture(t),
      superCookie = f.getCookie(),
      bytes = await workbook(validRows);
    for (const [index, action] of ['disable', 'reset-password'].entries()) {
      f.setCookie(superCookie);
      const username = 'race' + index;
      const account = await f.post('/admins', {
        username,
        displayName: '测试',
        password: 'Race-Initial-12345',
      });
      const cookie = (
        await f.post('/auth/login', {
          username,
          password: 'Race-Initial-12345',
        })
      ).cookie;
      f.setCookie(cookie);
      const p = await f.preview(bytes),
        body = JSON.stringify({ id: p.data.id });
      let request;
      const response = new Promise((resolve, reject) => {
        request = http.request(
          f.baseUrl() + '/imports/commit',
          {
            method: 'POST',
            headers: {
              cookie,
              'Content-Type': 'application/json',
              'Content-Length': Buffer.byteLength(body),
            },
          },
          (r) => {
            r.resume();
            r.on('end', () => resolve(r.statusCode));
          },
        );
        request.on('error', reject);
        request.write(body.slice(0, 1));
        request.flushHeaders();
      });
      await new Promise((r) => setTimeout(r, 150));
      f.setCookie(superCookie);
      assert.equal(
        (
          await f.post('/admins/' + account.data.id, {
            action,
            password: 'Race-Changed-12345',
          })
        ).status,
        200,
      );
      request.end(body.slice(1));
      assert.equal(await response, 401);
      assert.equal(
        (await f.request('/jobs/' + p.data.id)).data.status,
        'ready',
      );
    }
    assert.equal((await f.request('/dashboard')).data.metrics.tested, 0);
  },
);

void test('不同批次同时作废不发生锁升级死锁', { timeout: 40000 }, async (t) => {
  const f = await fixture(t),
    bytes = await workbook(validRows),
    ids = [];
  for (let i = 0; i < 2; i++) {
    const p = await f.preview(bytes);
    await f.commit(p.data.id);
    ids.push(p.data.id);
  }
  const results = await Promise.all(
    ids.map((id) => f.post('/imports/withdraw', { id })),
  );
  assert.deepEqual(
    results.map((r) => r.status),
    [200, 200],
  );
  assert.equal((await f.request('/dashboard')).data.metrics.tested, 0);
});

void test(
  '第五次入库失败后不再提供无效重试入口，正式数据无部分写入',
  { timeout: 40000 },
  async (t) => {
    const f = await fixture(t),
      db = connectDatabase(f.pg.url);
    t.after(() => db.close());
    const p = await f.preview(await workbook(validRows));
    await f.stopWorker();
    await db.query(
      "UPDATE imports SET payload=jsonb_set(payload,'{records}',(payload->'records')||jsonb_build_array(payload->'records'->0)) WHERE id=$1",
      [p.data.id],
    );
    await db.query(
      "UPDATE jobs SET phase='commit',status='queued',attempts=4 WHERE id=$1",
      [p.data.id],
    );
    f.startWorker();
    const failed = (await f.waitJob(p.data.id, ['failed'])).data;
    assert.equal(failed.attempts, 5);
    assert.equal(failed.retryable, false);
    assert.match(failed.error, /耗尽/);
    assert.equal((await f.post('/jobs/retry', { id: p.data.id })).status, 400);
    assert.equal((await f.request('/dashboard')).data.metrics.tested, 0);
    assert.equal((await db.get('SELECT count(*) n FROM samples')).n, 0);
  },
);
