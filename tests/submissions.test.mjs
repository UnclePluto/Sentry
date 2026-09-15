import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir } from 'node:fs/promises';
import { fixture, workbook, validRows } from './helpers/submission.mjs';

test(
  'Sheet1 剔除对照后汇总并确认：不保留 Excel 或暴露检测明细',
  { timeout: 40000 },
  async (t) => {
    const f = await fixture(t);
    const p = await f.preview(
      await workbook([
        ...validRows,
        ['B', 'C', 'N', '阴性', ''],
        ['B', 'D', 'IAV', '-', ''],
        ['B', 'D', 'IAV', '-', ''],
        ['B', 'E', 'N', 26, ''],
      ]),
    );
    assert.equal(p.status, 201, JSON.stringify(p.data));
    assert.equal(p.data.sheet, 'Sheet1');
    assert.equal(p.data.summary.rows, 3);
    assert.equal(p.data.summary.samples, 2);
    assert.equal(p.data.summary.positive, 1);
    assert.equal(p.data.summary.rate, 0.5);
    assert.equal(p.data.summary.excluded, 4);
    assert.equal(p.data.records, undefined);
    assert.equal((await f.request('/dashboard')).data.metrics.tested, 0);
    assert.equal(
      (await f.post('/imports/commit', { id: p.data.id })).status,
      200,
    );
    const dash = (await f.request('/dashboard')).data;
    assert.equal(dash.metrics.tested, 2);
    assert.equal(dash.metrics.positive, 1);
    assert.equal(dash.ranking.find((r) => r.code === 'RSV').positive, 1);
    assert.equal((await f.request('/records')).status, 404);
    assert.equal(
      (await f.request('/imports/download?id=' + p.data.id)).status,
      404,
    );
    const files = await readdir(f.dir, { recursive: true });
    assert.ok(!files.some((x) => x.endsWith('.xlsx')));
  },
);

test(
  '有效行错误整份阻止，对照先剔除；仅检查 Sheet1',
  { timeout: 40000 },
  async (t) => {
    const f = await fixture(t);
    for (const [rows, pattern] of [
      [[...validRows, validRows[0]], /第 2、5 行重复/],
      [[...validRows, ['B', 'A', 'IAV', '阴性', '']], /重复/],
      [[['B', 'S', 'IAV', '', '']], /无法识别/],
      [[['B', 'S', 'IAV', '待复核', '']], /无法识别/],
      [[['', 'S', 'IAV', 20, '']], /不能为空/],
      [[['B', 'S', 'N', '阴性', '']], /没有有效/],
    ]) {
      const r = await f.preview(await workbook(rows));
      assert.equal(r.status, 400);
      assert.match(r.data.error, pattern);
    }
    const missing = await f.preview(await workbook(validRows, '结果'));
    assert.equal(missing.status, 400);
    assert.match(missing.data.error, /Sheet1/);
    assert.equal((await f.request('/dashboard')).data.metrics.tested, 0);
    assert.ok(
      !(await readdir(f.dir, { recursive: true })).some((x) =>
        x.endsWith('.xlsx'),
      ),
    );
  },
);

test(
  '行政区直接提交，上传批次独立累计且重复确认幂等',
  { timeout: 40000 },
  async (t) => {
    const f = await fixture(t);
    const bytes = await workbook(validRows);
    const a = await f.preview(bytes, { institutionId: '', county_code: '' });
    assert.equal(a.status, 201, JSON.stringify(a.data));
    assert.equal(
      (await f.post('/imports/commit', { id: a.data.id })).status,
      200,
    );
    assert.equal(
      (await f.post('/imports/commit', { id: a.data.id })).status,
      200,
    );
    assert.equal((await f.request('/dashboard')).data.metrics.tested, 2);
    const b = await f.preview(bytes, { institutionId: '', date: '2026-08-01' });
    assert.equal(b.status, 201, JSON.stringify(b.data));
    assert.notEqual(a.data.id, b.data.id);
    await f.post('/imports/commit', { id: b.data.id });
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

test(
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
    assert.equal(a.status, 201);
    await f.post('/imports/commit', { id: a.data.id });
    f.setCookie(superCookie);
    const b = await f.preview(bytes);
    await f.post('/imports/commit', { id: b.data.id });
    const all = (await f.request('/imports')).data;
    assert.equal(all.length, 2);
    assert.equal(all.find((h) => h.id === a.data.id).submitted_name, '甲医生');
    f.setCookie(alice);
    assert.equal((await f.request('/imports')).data.length, 1);
    assert.equal(
      (await f.post('/imports/withdraw', { id: b.data.id })).status,
      404,
    );
    assert.equal(
      (await f.post('/imports/commit', { id: b.data.id })).status,
      404,
    );
    f.setCookie(superCookie);
    const staged = await f.preview(bytes);
    f.setCookie(alice);
    assert.equal(
      (await f.post('/imports/commit', { id: staged.data.id })).status,
      404,
    );
    const w = await f.post('/imports/withdraw', { id: a.data.id });
    assert.equal(w.status, 200);
    assert.equal(
      (await f.post('/imports/withdraw', { id: a.data.id })).status,
      200,
    );
    const hist = (await f.request('/imports')).data[0];
    assert.equal(hist.status, 'withdrawn');
    assert.equal(hist.summary.tested, 2);
    assert.ok(hist.withdrawn_at);
    assert.equal(hist.withdrawn_name, '甲医生（alice）');
    assert.equal((await f.request('/dashboard')).data.metrics.tested, 2);
    f.setCookie(superCookie);
    await f.post('/admins/' + create.data.id, { action: 'delete' });
    assert.equal(
      (await f.request('/imports')).data.find((h) => h.id === a.data.id)
        .submitted_name,
      '甲医生',
    );
    await f.post('/imports/withdraw', { id: b.data.id });
    assert.equal((await f.request('/dashboard')).data.metrics.tested, 0);
    await f.stop();
    await f.start();
    const history = (await f.request('/imports')).data;
    assert.equal(history.length, 2);
    assert.ok(history.every((h) => h.status === 'withdrawn'));
  },
);

test(
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
      assert.equal(p.status, 201, JSON.stringify(p.data));
      await f.post('/imports/commit', { id: p.data.id });
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

test(
  '旧数据升级：未知归属作废、对照剔除、清理原文件，演示与重启一致',
  { timeout: 40000 },
  async (t) => {
    const f = await fixture(t, { legacy: true, demo: true });
    const backups = await readdir(f.dir + '/backups');
    assert.equal(backups.filter((x) => x.endsWith('.sqlite')).length, 1);
    const history = (await f.request('/imports')).data;
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
    assert.equal((await f.request('/imports')).data.length, 1);
    assert.equal((await f.request('/auth/me')).status, 200);
    assert.deepEqual(await readdir(f.dir + '/backups'), backups);
  },
);

test(
  '富文本标识统一去空白，不能绕过重复校验或对照剔除',
  { timeout: 40000 },
  async (t) => {
    const f = await fixture(t);
    const duplicate = await f.preview(
      await workbook([
        validRows[0],
        [{ richText: [{ text: ' B ' }] }, 'A', 'IAV', 26, ''],
      ]),
    );
    assert.equal(duplicate.status, 400);
    assert.match(duplicate.data.error, /重复/);
    const excluded = await f.preview(
      await workbook([
        ...validRows,
        ['B', 'C', { richText: [{ text: ' N ' }] }, '阴性', ''],
        ['B', 'D', 'IAV', { richText: [{ text: ' — ' }] }, ''],
      ]),
    );
    assert.equal(excluded.status, 201);
    assert.equal(excluded.data.summary.excluded, 2);
    assert.equal(excluded.data.summary.tested, 2);
  },
);
