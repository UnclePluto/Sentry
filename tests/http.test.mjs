import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fixture } from './helpers/submission.mjs';
const source = process.env.SENTRY_FIXTURE_FILE;
const expectations = process.env.SENTRY_FIXTURE_EXPECTATIONS;
void test(
  '真实样表：双工作表 → 样本汇总 → 独立累计 → 整批作废',
  { skip: !source && !expectations, timeout: 40000 },
  async (t) => {
    assert.ok(source && expectations, '真实样表与人工核对预期文件必须同时配置');
    const f = await fixture(t),
      bytes = await readFile(source),
      expected = JSON.parse(await readFile(expectations, 'utf8'));
    const a = await f.preview(bytes);
    assert.equal(a.status, 200, JSON.stringify(a.data));
    for (const key of [
      'samples',
      'positive',
      'negative',
      'testedPathogens',
      'detectedPathogens',
    ]) {
      assert.ok(Number.isSafeInteger(expected[key]) && expected[key] >= 0);
      assert.equal(a.data.summary[key], expected[key]);
    }
    await f.commit(a.data.id);
    const b = await f.preview(bytes);
    assert.equal(b.status, 200);
    await f.commit(b.data.id);
    assert.equal(
      (await f.request('/dashboard')).data.metrics.tested,
      expected.samples * 2,
    );
    await f.post('/imports/withdraw', { id: a.data.id });
    assert.equal(
      (await f.request('/dashboard')).data.metrics.tested,
      expected.samples,
    );
    await f.stop();
    await f.start();
    assert.equal(
      (await f.request('/dashboard')).data.metrics.tested,
      expected.samples,
    );
  },
);
