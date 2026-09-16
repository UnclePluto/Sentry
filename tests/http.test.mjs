import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fixture } from './helpers/submission.mjs';
const source = process.env.SENTRY_FIXTURE_FILE;
test(
  '真实样表：Sheet1 → 新口径汇总 → 独立累计 → 整批作废',
  { skip: !source, timeout: 40000 },
  async (t) => {
    const f = await fixture(t),
      bytes = await readFile(source);
    const a = await f.preview(bytes);
    assert.equal(a.status, 200, JSON.stringify(a.data));
    assert.equal(a.data.summary.rows, 294);
    assert.equal(a.data.summary.tested, 199);
    assert.equal(a.data.summary.positive, 199);
    assert.equal(a.data.summary.excluded, 84);
    assert.equal(a.data.summary.rate, 1);
    await f.commit(a.data.id);
    const b = await f.preview(bytes);
    assert.equal(b.status, 200);
    await f.commit(b.data.id);
    assert.equal((await f.request('/dashboard')).data.metrics.tested, 398);
    await f.post('/imports/withdraw', { id: a.data.id });
    assert.equal((await f.request('/dashboard')).data.metrics.tested, 199);
    await f.stop();
    await f.start();
    assert.equal((await f.request('/dashboard')).data.metrics.tested, 199);
  },
);
