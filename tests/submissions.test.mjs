import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir } from 'node:fs/promises';
import { fixture, workbook, validRows } from './helpers/submission.mjs';

void test(
  '双工作表按样本汇总并确认：不保留 Excel 或暴露检测明细',
  { timeout: 40000 },
  async (t) => {
    const f = await fixture(t);
    const p = await f.preview(
      await workbook([
        ...validRows,
        ['B', 'C', 'N', '阴性', ''],
        ['B', 'D', 'IAV', '-', ''],
      ]),
    );
    assert.equal(p.status, 200, JSON.stringify(p.data));
    assert.equal(p.data.sheet, 'Sheet1');
    assert.deepEqual(p.data.sheets, ['Sheet1', 'Sheet2']);
    assert.equal(p.data.formatVersion, 2);
    assert.equal(p.data.summary.rows, 5);
    assert.equal(p.data.summary.samples, 4);
    assert.equal(p.data.summary.positive, 2);
    assert.equal(p.data.summary.negative, 2);
    assert.equal(p.data.summary.rate, 0.5);
    assert.equal(p.data.summary.excluded, 0);
    assert.equal(p.data.records, undefined);
    assert.equal((await f.request('/dashboard')).data.metrics.tested, 0);
    const before = p.data.summary;
    await f.stop();
    await f.start();
    const restored = (await f.request('/jobs/' + p.data.id)).data;
    assert.deepEqual(restored.sheets, ['Sheet1', 'Sheet2']);
    assert.deepEqual(restored.summary, before);
    assert.equal(restored.formatVersion, 2);
    f.startWorker();
    assert.equal((await f.commit(p.data.id)).status, 200);
    const dash = (await f.request('/dashboard')).data;
    assert.equal(dash.metrics.tested, 4);
    assert.equal(dash.metrics.positive, 2);
    assert.equal(dash.ranking.find((r) => r.code === 'RSV').positive, 1);
    const history = (await f.request('/imports')).data.items[0];
    assert.equal(history.formatVersion, 2);
    assert.equal(history.summary.negative, 2);
    assert.equal((await f.request('/records')).status, 404);
    assert.equal(
      (await f.request('/imports/download?id=' + p.data.id)).status,
      404,
    );
    const files = await readdir(f.dir, { recursive: true });
    assert.ok(!files.some((x) => x.endsWith('.xlsx')));
  },
);

void test(
  '双工作表中的重复、N 冲突和非法结果整份阻止',
  { timeout: 40000 },
  async (t) => {
    const f = await fixture(t);
    for (const [rows, pattern] of [
      [[...validRows, validRows[0]], /第 2、5 行.*重复/],
      [[...validRows, ['B', 'A', 'N', '阴性', '']], /N 与阳性结果冲突/],
      [[['B', 'S', 'IAV', '阴性', '']], /阳性结果/],
      [[['B', 'S', 'IAV', '待复核', '']], /阳性结果/],
      [[['', 'S', 'IAV', 20, '']], /不能为空/],
      [[['B', 'S', 'N', 26, '']], /N 与 CT/],
    ]) {
      const r = await f.preview(await workbook(rows));
      assert.equal(r.data.status, 'failed');
      assert.match(r.data.error, pattern);
    }
    const missing = await f.preview(await workbook(validRows, '结果'));
    assert.equal(missing.data.status, 'failed');
    assert.match(missing.data.error, /Sheet1/);
    assert.equal((await f.request('/dashboard')).data.metrics.tested, 0);
    assert.ok(
      !(await readdir(f.dir, { recursive: true })).some((x) =>
        x.endsWith('.xlsx'),
      ),
    );
  },
);

void test(
  '行政区直接提交，上传批次独立累计且重复确认幂等',
  { timeout: 40000 },
  async (t) => {
    const f = await fixture(t);
    const bytes = await workbook(validRows);
    const a = await f.preview(bytes, { institutionId: '', county_code: '' });
    assert.equal(a.status, 200, JSON.stringify(a.data));
    assert.equal((await f.commit(a.data.id)).status, 200);
    assert.equal((await f.commit(a.data.id)).status, 200);
    assert.equal((await f.request('/dashboard')).data.metrics.tested, 2);
    const b = await f.preview(bytes, { institutionId: '', date: '2026-08-01' });
    assert.equal(b.status, 200, JSON.stringify(b.data));
    assert.notEqual(a.data.id, b.data.id);
    await f.commit(b.data.id);
    const d = (await f.request('/dashboard')).data;
    assert.equal(d.metrics.tested, 4);
    assert.equal(d.metrics.positive, 2);
    assert.equal(
      (await f.request('/dashboard?from=2026-09-01')).data.metrics.tested,
      2,
    );
    const invalid = await f.preview(bytes, { province_code: '440000' });
    assert.equal(invalid.status, 400);
    await f.stop();
    await f.start();
    assert.equal((await f.request('/dashboard')).data.metrics.tested, 4);
  },
);

void test(
  '本人历史、超管全量与整批作废审计，账号删除不丢历史',
  { timeout: 40000 },
  async (t) => {
    const f = await fixture(t),
      superCookie = f.getCookie(),
      bytes = await workbook(validRows);
    const create = await f.post('/admins', {
      username: 'alice',
      displayName: '甲医生',
      password: 'Testing-Alice-12345',
    });
    assert.equal(create.status, 201);
    const alice = (
      await f.post('/auth/login', {
        username: 'alice',
        password: 'Testing-Alice-12345',
      })
    ).cookie;
    f.setCookie(alice);
    const a = await f.preview(bytes);
    assert.equal(a.status, 200);
    await f.commit(a.data.id);
    f.setCookie(superCookie);
    const b = await f.preview(bytes);
    await f.commit(b.data.id);
    const all = (await f.request('/imports')).data.items;
    assert.equal(all.length, 2);
    assert.equal(all.find((h) => h.id === a.data.id).submitted_name, '甲医生');
    f.setCookie(alice);
    assert.equal((await f.request('/imports')).data.items.length, 1);
    assert.equal(
      (await f.post('/imports/withdraw', { id: b.data.id })).status,
      404,
    );
    assert.equal((await f.commit(b.data.id)).status, 404);
    f.setCookie(superCookie);
    const staged = await f.preview(bytes);
    f.setCookie(alice);
    assert.equal((await f.commit(staged.data.id)).status, 404);
    const w = await f.post('/imports/withdraw', { id: a.data.id });
    assert.equal(w.status, 200);
    assert.equal(
      (await f.post('/imports/withdraw', { id: a.data.id })).status,
      200,
    );
    const hist = (await f.request('/imports')).data.items[0];
    assert.equal(hist.status, 'withdrawn');
    assert.equal(hist.summary.tested, 2);
    assert.ok(hist.withdrawn_at);
    assert.equal(hist.withdrawn_name, '甲医生（alice）');
    assert.equal((await f.request('/dashboard')).data.metrics.tested, 2);
    f.setCookie(superCookie);
    await f.post('/admins/' + create.data.id, { action: 'delete' });
    assert.equal(
      (await f.request('/imports')).data.items.find((h) => h.id === a.data.id)
        .submitted_name,
      '甲医生',
    );
    await f.post('/imports/withdraw', { id: b.data.id });
    assert.equal((await f.request('/dashboard')).data.metrics.tested, 0);
    await f.stop();
    await f.start();
    const history = (await f.request('/imports')).data.items;
    assert.equal(history.length, 2);
    assert.ok(history.every((h) => h.status === 'withdrawn'));
  },
);

void test(
  '全国省级包含市级提交，市内区县视图与图表同步剔除；覆盖直辖市',
  { timeout: 40000 },
  async (t) => {
    const f = await fixture(t),
      bytes = await workbook(validRows);
    for (const location of [
      { county_code: '' },
      {},
      { province_code: '110000', city_code: '110000', county_code: '' },
      { province_code: '110000', city_code: '110000', county_code: '110101' },
    ]) {
      const p = await f.preview(bytes, location);
      assert.equal(p.status, 200, JSON.stringify(p.data));
      await f.commit(p.data.id);
    }
    assert.equal((await f.request('/dashboard')).data.metrics.tested, 8);
    const province = (await f.request('/dashboard?region=420000')).data;
    assert.equal(province.metrics.tested, 4);
    assert.equal(province.regions.city[0].tested, 4);
    for (const region of ['420100', '110000']) {
      const city = (await f.request('/dashboard?region=' + region)).data;
      assert.equal(city.metrics.tested, 2);
      assert.equal(city.regions.county[0].tested, 2);
      assert.equal(city.trend[0].tested, 2);
      assert.equal(city.ranking.find((r) => r.code === 'IAV').positive, 1);
      assert.equal(city.heatmap.find((r) => r.code === 'IAV').count, 1);
    }
    const county = (await f.request('/dashboard?region=420106')).data;
    assert.equal(county.metrics.tested, 2);
    assert.equal(county.regions.county[0].code, '420106');
    assert.equal(
      (await f.request('/dashboard?region=420000')).data.metrics.tested,
      4,
    );
    assert.equal(
      (await f.preview(bytes, { county_code: '440106' })).status,
      400,
    );
  },
);

void test(
  '富文本标识统一去空白，不能绕过重复校验且 N 保留为样本',
  { timeout: 40000 },
  async (t) => {
    const f = await fixture(t);
    const duplicate = await f.preview(
      await workbook([
        validRows[0],
        [{ richText: [{ text: ' B ' }] }, 'A', 'IAV', 26, ''],
      ]),
    );
    assert.equal(duplicate.data.status, 'failed');
    assert.match(duplicate.data.error, /重复/);
    const accepted = await f.preview(
      await workbook([
        ...validRows,
        ['B', 'C', { richText: [{ text: ' N ' }] }, '阴性', ''],
      ]),
    );
    assert.equal(accepted.status, 200);
    assert.equal(accepted.data.summary.samples, 3);
    assert.equal(accepted.data.summary.negative, 2);
    assert.equal(accepted.data.summary.excluded, 0);
  },
);
