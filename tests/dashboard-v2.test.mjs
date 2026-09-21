import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './helpers/submission.mjs';
import { dualWorkbook } from './helpers/workbook-v2.mjs';
import { connectDatabase } from '../server/database.mjs';

const panel = {
  IAV: ['IAV', '甲型流感病毒'],
  RSV: ['RSV', '呼吸道合胞病毒'],
  ADV: ['ADV', '腺病毒'],
};

async function submit(f, rows, codes, extra = {}) {
  const preview = await f.preview(
    await dualWorkbook(
      rows,
      codes.map((code) => panel[code]),
    ),
    extra,
  );
  assert.equal(preview.data.status, 'ready', JSON.stringify(preview.data));
  const committed = await f.commit(preview.data.id);
  assert.equal(
    committed.data.status,
    'succeeded',
    JSON.stringify(committed.data),
  );
  return preview.data.id;
}

void test(
  '多个不同检测范围按交集纳入且多选阳性样本去重',
  { timeout: 60000 },
  async (t) => {
    const f = await fixture(t);
    await submit(
      f,
      [
        ['B', 'S1', 'N', '', ''],
        ['B', 'S2', 'IAV', 25, ''],
        ['B', 'S2', 'RSV', 30, ''],
        ['B', 'S3', 'ADV', 20, ''],
      ],
      ['IAV', 'RSV', 'ADV'],
    );
    await submit(
      f,
      [
        ['B', 'S4', 'N', '', ''],
        ['B', 'S5', 'IAV', 25, ''],
      ],
      ['IAV'],
    );
    await submit(f, [['B', 'S6', 'ADV', 20, '']], ['ADV']);

    for (const [query, positive, samples, excluded] of [
      ['', 4, 6, 0],
      ['?pathogen=IAV', 2, 5, 1],
      ['?pathogen=IAV&pathogen=RSV', 2, 5, 1],
      ['?pathogen=RSV&pathogen=IAV&pathogen=IAV', 2, 5, 1],
      ['?pathogen=RSV', 1, 3, 3],
      ['?pathogen=ADV', 2, 4, 2],
      ['?pathogen=IAV&pathogen=ADV', 4, 6, 0],
      ['?pathogen=RSV&pathogen=ADV', 3, 4, 2],
      ['?pathogen=IAV&pathogen=RSV&pathogen=ADV', 4, 6, 0],
    ]) {
      const response = await f.request('/dashboard' + query);
      assert.equal(response.status, 200, JSON.stringify(response.data));
      assert.equal(response.data.metrics.positive, positive, query);
      assert.equal(response.data.metrics.samples, samples, query);
      assert.equal(
        response.data.metrics.excludedNoSelectedTest,
        excluded,
        query,
      );
      assert.equal(
        response.data.metrics.notDetected,
        samples - positive,
        query,
      );
    }

    const chosen = (
      await f.request('/dashboard?pathogen=RSV&pathogen=IAV&pathogen=IAV')
    ).data;
    assert.deepEqual(chosen.selectedPathogens, ['IAV', 'RSV']);
    assert.deepEqual(
      chosen.pathogenOptions.map((option) => option.code),
      ['ADV', 'IAV', 'RSV'],
    );
    assert.deepEqual(
      chosen.ranking.find((row) => row.code === 'RSV'),
      {
        code: 'RSV',
        name: '呼吸道合胞病毒',
        tested: 3,
        positive: 1,
        rate: 1 / 3,
      },
    );
    assert.equal(chosen.metrics.regions, 1);
    assert.equal(chosen.regions.province[0].code, '420000');
  },
);

void test(
  '地区层级、市级排除、日期空范围、作废和演示数据保持同一口径',
  { timeout: 60000 },
  async (t) => {
    const resources = {};
    t.after(() => resources.db?.close());
    const f = await fixture(t);
    const db = connectDatabase(f.pg.url);
    resources.db = db;
    const cityOnly = await submit(f, [['B', 'CITY', 'IAV', 25, '']], ['IAV'], {
      county_code: '',
    });
    const county = await submit(f, [['B', 'COUNTY', 'IAV', 25, '']], ['IAV']);
    const beijingCity = await submit(
      f,
      [['B', 'BJ-CITY', 'IAV', 25, '']],
      ['IAV'],
      { province_code: '110000', city_code: '110000', county_code: '' },
    );
    const beijingCounty = await submit(
      f,
      [['B', 'BJ-COUNTY', 'IAV', 25, '']],
      ['IAV'],
      {
        province_code: '110000',
        city_code: '110000',
        county_code: '110101',
      },
    );
    assert.ok(cityOnly && beijingCity);

    const nationwide = (await f.request('/dashboard')).data;
    assert.equal(nationwide.metrics.samples, 4);
    assert.equal(nationwide.metrics.regions, 2);
    const province = (await f.request('/dashboard?region=420000')).data;
    assert.equal(province.metrics.samples, 2);
    assert.equal(province.metrics.regions, 1);
    const city = (await f.request('/dashboard?region=420100')).data;
    assert.equal(city.metrics.samples, 1);
    assert.equal(city.metrics.regions, 1);
    assert.equal(city.regions.county[0].code, '420106');
    const municipality = (await f.request('/dashboard?region=110000')).data;
    assert.equal(municipality.metrics.samples, 1);
    assert.equal(municipality.metrics.regions, 1);
    assert.equal(municipality.regions.county[0].code, '110101');
    const district = (await f.request('/dashboard?region=420106')).data;
    assert.equal(district.metrics.samples, 1);
    assert.equal(district.metrics.regions, 1);

    const emptyRange = (
      await f.request('/dashboard?from=2027-01-01&to=2026-01-01')
    ).data;
    assert.equal(emptyRange.metrics.samples, 0);
    assert.equal(emptyRange.metrics.rate, null);
    assert.equal(emptyRange.metrics.regions, 0);

    await db.query('UPDATE imports SET demo=1 WHERE id=$1', [beijingCounty]);
    assert.equal(
      (await f.request('/dashboard?region=110000')).data.metrics.samples,
      0,
    );
    assert.equal(
      (await f.request('/dashboard?region=110000&demo=1')).data.metrics.samples,
      1,
    );
    assert.equal(
      (await f.post('/imports/withdraw', { id: county })).status,
      200,
    );
    assert.equal(
      (await f.request('/dashboard?region=420100')).data.metrics.samples,
      0,
    );
  },
);

void test(
  '全阴性检测范围保留零值，已知无覆盖返回空分母，未知代码报错',
  { timeout: 60000 },
  async (t) => {
    const f = await fixture(t);
    await submit(f, [['B', 'N1', 'N', '阴性', '']], ['IAV', 'RSV'], {
      date: '2026-09-01',
    });
    await submit(f, [['B', 'A1', 'ADV', 20, '']], ['ADV'], {
      date: '2026-08-01',
    });

    const september = (
      await f.request('/dashboard?from=2026-09-01&to=2026-09-30')
    ).data;
    assert.equal(september.metrics.samples, 1);
    assert.equal(september.metrics.positive, 0);
    assert.equal(september.metrics.rate, 0);
    assert.deepEqual(
      september.pathogenOptions.map((option) => option.code),
      ['IAV', 'RSV'],
    );
    assert.ok(
      september.ranking.every(
        (row) => row.tested === 1 && row.positive === 0 && row.rate === 0,
      ),
    );
    assert.ok(
      september.heatmap.some(
        (row) =>
          row.code === 'IAV' &&
          row.month === '2026-09' &&
          row.tested === 1 &&
          row.count === 0,
      ),
    );
    assert.ok(september.trend.some((row) => row.month === '2026-09'));

    const uncovered = await f.request(
      '/dashboard?from=2026-09-01&to=2026-09-30&pathogen=ADV',
    );
    assert.equal(uncovered.status, 200);
    assert.equal(uncovered.data.metrics.samples, 0);
    assert.equal(uncovered.data.metrics.positive, 0);
    assert.equal(uncovered.data.metrics.rate, null);
    assert.equal(uncovered.data.metrics.excludedNoSelectedTest, 1);

    const unknown = await f.request('/dashboard?pathogen=NOT_A_PATHOGEN');
    assert.equal(unknown.status, 400);
    assert.match(unknown.data.error, /不存在|未知/);
  },
);
