import test from 'node:test';
import assert from 'node:assert/strict';
import { migrate, verifySchema } from '../server/database.mjs';
import { databaseFixture } from './helpers/database.mjs';

const legacyChecksum =
  'e280af173242b3c7931123eadb77c3bca2559d997926a9705cf1d1c1b9be0192';

async function addImport(db, id) {
  await db.query(
    `INSERT INTO imports(
      id,file_name,sha256,province_code,province,city_code,city,
      submitted_name,report_date,created_at,status,format_version
    ) VALUES($1,$2,'hash','420000','湖北省','420100','武汉市',
      '测试提交','2026-09-01',now(),'published',2)`,
    [id, id + '.xlsx'],
  );
}

test('新库按顺序应用版本 1 和版本 2', async (t) => {
  const db = await databaseFixture(t);
  assert.deepEqual(
    (
      await db.all('SELECT version FROM schema_migrations ORDER BY version')
    ).map((row) => row.version),
    [1, 2],
  );
  await verifySchema(db);
});

test('升级保留旧同名样本与版本 1 校验和', async (t) => {
  const db = await databaseFixture(t, { version: 1 });
  await db.exec(
    `INSERT INTO imports(
      id,file_name,sha256,province_code,province,city_code,city,
      submitted_name,report_date,created_at,status
    ) VALUES('old','old.xlsx','h','420000','湖北省','420100','武汉市',
      '旧提交','2026-09-01',now(),'published')`,
  );
  await db.exec(
    "INSERT INTO samples(import_id,batch,sample_code) VALUES('old','B1','S'),('old','B2','S')",
  );
  await migrate(db);
  await migrate(db);
  await verifySchema(db);
  assert.deepEqual(
    (
      await db.all('SELECT version FROM schema_migrations ORDER BY version')
    ).map((row) => row.version),
    [1, 2],
  );
  assert.equal((await db.get('SELECT count(*) n FROM samples')).n, 2);
  assert.equal(
    (
      await db.get(
        'SELECT checksum FROM schema_migrations WHERE version=1',
      )
    ).checksum,
    legacyChecksum,
  );
  assert.equal(
    (
      await db.get("SELECT format_version FROM imports WHERE id='old'")
    ).format_version,
    1,
  );
});

test('格式 2 数据库约束隔离样本、检测范围和阳性明细', async (t) => {
  const db = await databaseFixture(t);
  await addImport(db, 'one');
  await addImport(db, 'two');
  await db.exec(
    "INSERT INTO pathogens(code,name) VALUES('IAV','甲流'),('RSV','合胞病毒')",
  );
  await db.exec(
    `INSERT INTO import_pathogens(import_id,pathogen_code,source_row)
     VALUES('one','IAV',2),('two','IAV',2)`,
  );
  await db.exec(
    `INSERT INTO samples(import_id,batch,sample_code,format_version,result_kind,source_row)
     VALUES('one','B','S',2,'has_positive',2),
           ('two','B','S',2,'has_positive',2)`,
  );
  const first = await db.get(
    "SELECT id FROM samples WHERE import_id='one' AND sample_code='S'",
  );
  const second = await db.get(
    "SELECT id FROM samples WHERE import_id='two' AND sample_code='S'",
  );

  await assert.rejects(
    db.query(
      `INSERT INTO samples(import_id,batch,sample_code,format_version,result_kind,source_row)
       VALUES('one','B2','S',2,'all_negative',3)`,
    ),
    { code: '23505' },
  );
  await assert.rejects(
    db.query(
      `INSERT INTO samples(import_id,batch,sample_code,format_version,result_kind,source_row)
       VALUES('one','B','EMPTY',2,NULL,NULL)`,
    ),
    { code: '23514' },
  );

  await db.query(
    `INSERT INTO sample_detections(
      import_id,sample_id,pathogen_code,raw_value,raw_name,source_row
    ) VALUES('one',$1,'IAV','25','甲流',2)`,
    [first.id],
  );
  await assert.rejects(
    db.query(
      `INSERT INTO sample_detections(
        import_id,sample_id,pathogen_code,raw_value,raw_name,source_row
      ) VALUES('one',$1,'IAV','25','甲流',3)`,
      [first.id],
    ),
    { code: '23505' },
  );
  await assert.rejects(
    db.query(
      `INSERT INTO sample_detections(
        import_id,sample_id,pathogen_code,raw_value,raw_name,source_row
      ) VALUES('one',$1,'IAV','25','甲流',3)`,
      [second.id],
    ),
    { code: '23503' },
  );
  await assert.rejects(
    db.query(
      `INSERT INTO sample_detections(
        import_id,sample_id,pathogen_code,raw_value,raw_name,source_row
      ) VALUES('one',$1,'RSV','25','合胞病毒',3)`,
      [first.id],
    ),
    { code: '23503' },
  );
});
