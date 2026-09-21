import test from 'node:test';
import assert from 'node:assert/strict';
import { databaseFixture } from './helpers/database.mjs';
import { seedDemo } from '../server/demo.mjs';

void test('演示生成新事实且重启幂等', { timeout: 60000 }, async (t) => {
  const db = await databaseFixture(t);
  await seedDemo(db);
  const before = await db.get(
    "SELECT count(*) n FROM imports WHERE demo=1 AND status='published' AND format_version=2",
  );
  assert.ok(before.n > 0);
  assert.equal(
    (await db.get('SELECT count(*) n FROM imports WHERE demo=0')).n,
    0,
  );
  assert.ok(
    (
      await db.get(
        "SELECT count(*) n FROM samples WHERE result_kind='all_negative'",
      )
    ).n > 0,
  );
  assert.ok((await db.get('SELECT count(*) n FROM sample_detections')).n > 0);
  await seedDemo(db);
  assert.deepEqual(
    await db.get(
      "SELECT count(*) n FROM imports WHERE demo=1 AND status='published' AND format_version=2",
    ),
    before,
  );
});

void test(
  '旧演示退出统计但旧真实数据及摘要不变',
  { timeout: 60000 },
  async (t) => {
    const db = await databaseFixture(t);
    const summary = { samples: 7, tested: 6, positive: 2, excluded: 1 };
    for (const [id, demo] of [
      ['old-demo', 1],
      ['old-real', 0],
    ])
      await db.query(
        `INSERT INTO imports(
        id,file_name,sha256,province_code,province,city_code,city,
        submitted_name,report_date,created_at,status,summary,demo
       ) VALUES($1,'旧数据','hash-'||$1,'420000','湖北省','420100','武汉市',
         '历史用户','2026-01-01',now(),'published',$2,$3)`,
        [id, JSON.stringify(summary), demo],
      );
    await seedDemo(db);
    assert.equal(
      (await db.get("SELECT status FROM imports WHERE id='old-demo'")).status,
      'withdrawn',
    );
    const real = await db.get(
      "SELECT status,format_version,summary FROM imports WHERE id='old-real'",
    );
    assert.deepEqual(real, {
      status: 'published',
      format_version: 1,
      summary,
    });
  },
);

void test('演示生成失败时不留下部分批次', { timeout: 60000 }, async (t) => {
  const db = await databaseFixture(t);
  await db.query(`CREATE FUNCTION reject_second_demo() RETURNS trigger
    LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.sha256='demo-420100-5' THEN RAISE EXCEPTION 'injected'; END IF;
      RETURN NEW;
    END $$`);
  await db.query(`CREATE TRIGGER reject_second_demo BEFORE INSERT ON imports
    FOR EACH ROW EXECUTE FUNCTION reject_second_demo()`);
  await assert.rejects(seedDemo(db), /injected/);
  assert.equal(
    (await db.get('SELECT count(*) n FROM imports WHERE demo=1')).n,
    0,
  );
});
