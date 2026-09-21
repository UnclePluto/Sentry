import test from 'node:test';
import assert from 'node:assert/strict';
import { connectDatabase } from '../server/database.mjs';
import { fixture } from './helpers/submission.mjs';
import { dualWorkbook } from './helpers/workbook-v2.mjs';
import { parseWorkbook } from '../server/parser.mjs';
import { validateSamplePayload } from '../server/sample-import.mjs';
import { rebuildContribution } from '../server/store.mjs';

const openFacts = (fixtureResult) => connectDatabase(fixtureResult.pg.url);

void test(
  '发布同时生成检测范围、样本、检出明细和零阳性指标',
  { timeout: 40000 },
  async (t) => {
    const resources = {};
    t.after(() => resources.db?.close());
    const f = await fixture(t);
    const db = openFacts(f);
    resources.db = db;
    const preview = await f.preview(
      await dualWorkbook(
        [
          ['B', 'S1', 'N', '阴性', ''],
          ['B', 'S2', 'IAV', 25, ''],
          ['B', 'S2', 'RSV', 30, ''],
        ],
        [
          ['IAV', '甲型流感病毒'],
          ['RSV', '呼吸道合胞病毒'],
          ['ADV', '腺病毒'],
        ],
      ),
    );
    assert.equal(preview.data.status, 'ready', JSON.stringify(preview.data));
    assert.equal(preview.data.formatVersion, 2);
    assert.deepEqual(preview.data.sheets, ['Sheet1', 'Sheet2']);
    await f.stop();
    await f.start();
    const restored = await f.request('/jobs/' + preview.data.id);
    assert.equal(restored.data.formatVersion, 2);
    assert.deepEqual(restored.data.sheets, ['Sheet1', 'Sheet2']);
    f.startWorker();

    const published = await f.commit(preview.data.id);
    assert.equal(
      published.data.status,
      'succeeded',
      JSON.stringify(published.data),
    );
    assert.equal((await db.get('SELECT count(*) n FROM samples')).n, 2);
    assert.equal(
      (await db.get('SELECT count(*) n FROM sample_detections')).n,
      2,
    );
    assert.equal((await db.get('SELECT count(*) n FROM results')).n, 0);
    assert.equal(
      (await db.get('SELECT count(*) n FROM import_pathogens')).n,
      3,
    );
    assert.deepEqual(
      await db.get(
        "SELECT tested,positive FROM import_metrics WHERE import_id=$1 AND pathogen_code='ADV'",
        preview.data.id,
      ),
      { tested: 2, positive: 0 },
    );
    const groups = await db.all(
      'SELECT positive_codes,sample_count FROM import_detection_groups WHERE import_id=$1 ORDER BY group_no',
      preview.data.id,
    );
    assert.equal(
      groups.reduce((sum, row) => sum + row.sample_count, 0),
      2,
    );
    assert.equal(
      groups.find((row) => row.positive_codes.length === 0)?.sample_count,
      1,
    );
    await db.transaction((tx) => rebuildContribution(tx, preview.data.id));
    assert.deepEqual(
      await db.all(
        'SELECT positive_codes,sample_count FROM import_detection_groups WHERE import_id=$1 ORDER BY group_no',
        preview.data.id,
      ),
      groups,
    );

    const repeated = await f.commit(preview.data.id);
    assert.equal(repeated.data.alreadyCommitted, true);
    assert.equal((await db.get('SELECT count(*) n FROM samples')).n, 2);
    assert.equal(
      (await f.post('/imports/withdraw', { id: preview.data.id })).status,
      200,
    );
    assert.equal(
      (
        await db.get(
          'SELECT count(*) n FROM samples WHERE import_id=$1',
          preview.data.id,
        )
      ).n,
      2,
    );
  },
);

void test('发布校验直接拒绝全阴性样本携带阳性明细', async () => {
  const payload = await parseWorkbook(
    await dualWorkbook([['B', 'S1', 'IAV', 25, '']], [['IAV', '甲型流感病毒']]),
  );
  payload.samples[0].resultKind = 'all_negative';
  assert.throws(() => validateSamplePayload(payload), /结论.*不一致/);
});

void test(
  '全阴性文件仍为范围内每种病原体生成零阳性指标',
  { timeout: 40000 },
  async (t) => {
    const resources = {};
    t.after(() => resources.db?.close());
    const f = await fixture(t);
    const db = openFacts(f);
    resources.db = db;
    const preview = await f.preview(
      await dualWorkbook(
        [['B', 'S1', 'N', '阴性', '']],
        [
          ['IAV', '甲型流感病毒'],
          ['RSV', '呼吸道合胞病毒'],
        ],
      ),
    );
    assert.equal((await f.commit(preview.data.id)).data.status, 'succeeded');
    assert.deepEqual(
      await db.all(
        'SELECT pathogen_code,tested,positive FROM import_metrics WHERE import_id=$1 ORDER BY pathogen_code',
        preview.data.id,
      ),
      [
        { pathogen_code: '', tested: 1, positive: 0 },
        { pathogen_code: 'IAV', tested: 1, positive: 0 },
        { pathogen_code: 'RSV', tested: 1, positive: 0 },
      ],
    );
  },
);

void test(
  '不同上传中的相同 sam 分别形成独立样本',
  { timeout: 40000 },
  async (t) => {
    const resources = {};
    t.after(() => resources.db?.close());
    const f = await fixture(t);
    const db = openFacts(f);
    resources.db = db;
    const files = [
      await dualWorkbook(
        [['B1', 'SAME', 'N', '阴性', '']],
        [['IAV', '甲型流感病毒']],
      ),
      await dualWorkbook(
        [['B2', 'SAME', 'IAV', 25, '']],
        [['IAV', '甲型流感病毒']],
      ),
    ];
    const ids = [];
    for (const bytes of files) {
      const preview = await f.preview(bytes);
      assert.equal((await f.commit(preview.data.id)).data.status, 'succeeded');
      ids.push(preview.data.id);
    }
    assert.equal(
      (
        await db.get(
          "SELECT count(*) n FROM samples WHERE sample_code='SAME' AND import_id=ANY($1::text[])",
          ids,
        )
      ).n,
      2,
    );
  },
);

void test(
  '暂存 payload 被篡改时整笔发布回滚且任务不可重试',
  { timeout: 40000 },
  async (t) => {
    const resources = {};
    t.after(() => resources.db?.close());
    const f = await fixture(t);
    const db = openFacts(f);
    resources.db = db;
    const preview = await f.preview(
      await dualWorkbook(
        [['B', 'S1', 'IAV', 25, '']],
        [['IAV', '甲型流感病毒']],
      ),
    );
    await f.stopWorker();
    await db.query(
      "UPDATE imports SET payload=jsonb_set(payload,'{detections}',(payload->'detections')||jsonb_build_array(payload->'detections'->0)) WHERE id=$1",
      [preview.data.id],
    );
    const queued = await f.post('/imports/commit', { id: preview.data.id });
    assert.equal(queued.status, 202);
    f.startWorker();
    const failed = await f.waitJob(preview.data.id, ['failed']);
    assert.equal(failed.data.status, 'failed');
    assert.equal(failed.data.retryable, false);
    assert.match(failed.data.error, /重复|篡改|不一致/);
    for (const table of [
      'import_pathogens',
      'samples',
      'sample_detections',
      'import_metrics',
      'import_detection_groups',
    ]) {
      assert.equal(
        (
          await db.get(
            `SELECT count(*) n FROM ${table} WHERE import_id=$1`,
            preview.data.id,
          )
        ).n,
        0,
      );
    }
  },
);

void test(
  'Sheet2 显式名称与既有字典冲突时整笔回滚',
  { timeout: 40000 },
  async (t) => {
    const resources = {};
    t.after(() => resources.db?.close());
    const f = await fixture(t);
    const db = openFacts(f);
    resources.db = db;
    const preview = await f.preview(
      await dualWorkbook(
        [['B', 'S1', 'IAV', 25, '']],
        [['IAV', '文件中的甲流名称']],
      ),
    );
    await f.stopWorker();
    await db.query(
      "INSERT INTO pathogens(code,name) VALUES('IAV','既有标准名称')",
    );
    assert.equal(
      (await f.post('/imports/commit', { id: preview.data.id })).status,
      202,
    );
    f.startWorker();
    const failed = await f.waitJob(preview.data.id, ['failed']);
    assert.equal(failed.data.status, 'failed');
    assert.equal(failed.data.retryable, false);
    assert.match(failed.data.error, /名称.*不一致/);
    assert.equal(
      (
        await db.get(
          'SELECT count(*) n FROM samples WHERE import_id=$1',
          preview.data.id,
        )
      ).n,
      0,
    );
    assert.equal(
      (
        await db.get(
          'SELECT count(*) n FROM import_pathogens WHERE import_id=$1',
          preview.data.id,
        )
      ).n,
      0,
    );
  },
);

void test(
  '旧格式 ready 预览被拒绝且不伪装成版本二',
  { timeout: 40000 },
  async (t) => {
    const resources = {};
    t.after(() => resources.db?.close());
    const f = await fixture(t);
    const db = openFacts(f);
    resources.db = db;
    const preview = await f.preview(
      await dualWorkbook(
        [['B', 'S1', 'N', '阴性', '']],
        [['IAV', '甲型流感病毒']],
      ),
    );
    await f.stopWorker();
    const legacy = {
      sheet: 'Sheet1',
      records: [],
      names: {},
      warnings: [],
      summary: preview.data.summary,
    };
    await db.query(
      'UPDATE imports SET format_version=1,payload=$2 WHERE id=$1',
      [preview.data.id, JSON.stringify(legacy)],
    );
    const response = await f.post('/imports/commit', { id: preview.data.id });
    assert.equal(response.status, 400);
    assert.match(response.data.error, /旧格式|双工作表/);
    const stored = await db.get(
      'SELECT format_version,payload FROM imports WHERE id=$1',
      preview.data.id,
    );
    assert.equal(stored.format_version, 1);
    assert.equal(stored.payload.formatVersion, undefined);
  },
);
