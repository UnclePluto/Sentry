# 01：追加版本 2 表结构与约束

Status: complete

依据：[规格](../spec.md) 第 3、7 节及[计划公共约束](../plan.md)。依赖：无。

**文件：**新增 `server/migrations/002-sample-pathogen-model.sql`、`tests/helpers/database.mjs`、`tests/sample-schema.test.mjs`；修改 `server/database.mjs`；保持 `server/schema.sql` 字节不变。

**接口：**现有 `migrate(db)` 和 `verifySchema(db)` 签名不变；新建与升级后的最新版本均为 2。测试夹具 `databaseFixture(t, { version = 2 } = {})` 返回当前项目数据库包装器。

- [x] 编写数据库夹具：创建独立临时数据库；version=1 时读取旧 schema、计算校验和并登记版本 1，其他情况调用 migrate；清理时先关闭业务连接再删除临时库。

```js
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { testDatabase } from './postgres.mjs';
import { connectDatabase, migrate } from '../../server/database.mjs';
export async function databaseFixture(t, { version = 2 } = {}) {
  const pg = await testDatabase();
  const db = connectDatabase(pg.url);
  t.after(async () => { await db.close(); await pg.close(); });
  if (version === 1) {
    const sql = await readFile(new URL('../../server/schema.sql', import.meta.url), 'utf8');
    await db.transaction(async (tx) => {
      await tx.exec(sql);
      await tx.exec('CREATE TABLE schema_migrations(version integer PRIMARY KEY,checksum text NOT NULL,applied_at timestamptz NOT NULL DEFAULT now())');
      await tx.query('INSERT INTO schema_migrations(version,checksum) VALUES(1,$1)', [createHash('sha256').update(sql).digest('hex')]);
    });
  } else await migrate(db);
  return db;
}
```

- [x] 写失败用例：空库有版本 1、2；升级版本 1 后校验和与旧样本不变；重复运行迁移不重复执行。版本 1 插入同上传下 batch 不同、sam 相同的两条样本，再升级，必须保留两条。

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { databaseFixture } from './helpers/database.mjs';
import { migrate, verifySchema } from '../server/database.mjs';
test('升级保留旧同名样本与版本 1 校验和', async (t) => {
  const db = await databaseFixture(t, {version: 1});
  await db.exec("INSERT INTO imports(id,file_name,sha256,province_code,province,city_code,city,submitted_name,report_date,created_at,status) VALUES('old','old.xlsx','h','420000','湖北省','420100','武汉市','旧提交','2026-09-01',now(),'published')");
  await db.exec("INSERT INTO samples(import_id,batch,sample_code) VALUES('old','B1','S'),('old','B2','S')");
  await migrate(db);
  await migrate(db);
  await verifySchema(db);
  assert.deepEqual((await db.all('SELECT version FROM schema_migrations ORDER BY version')).map(r => r.version), [1,2]);
  assert.equal((await db.get('SELECT count(*) n FROM samples')).n, 2);
  assert.equal((await db.get('SELECT checksum FROM schema_migrations WHERE version=1')).checksum, 'e280af173242b3c7931123eadb77c3bca2559d997926a9705cf1d1c1b9be0192');
  assert.equal((await db.get("SELECT format_version FROM imports WHERE id='old'")).format_version, 1);
});
```

- [x] 运行 `node --test tests/sample-schema.test.mjs`，确认失败来自缺失版本 2 或新字段，不是连接错误。
- [x] 迁移注册改为有序文件列表，在现有 advisory lock 和事务中逐个比较校验和、执行未应用版本；verifySchema 校验全部所需版本及对应校验和，拒绝缺失或不兼容版本。

```js
const migrations = [
  {version: 1, url: new URL('./schema.sql', import.meta.url)},
  {version: 2, url: new URL('./migrations/002-sample-pathogen-model.sql', import.meta.url)},
];
```

- [x] 创建格式字段、部分唯一键与事实表。新增列的默认版本为 1，保证旧迁移导入工具仍标记历史含义；新业务必须显式写入 2。

```sql
ALTER TABLE imports ADD COLUMN format_version smallint NOT NULL DEFAULT 1 CHECK(format_version IN (1,2));
ALTER TABLE imports ADD CONSTRAINT imports_id_format_unique UNIQUE(id,format_version);
ALTER TABLE samples ADD COLUMN format_version smallint NOT NULL DEFAULT 1 CHECK(format_version IN (1,2));
ALTER TABLE samples ADD COLUMN result_kind text;
ALTER TABLE samples ADD COLUMN source_row integer;
ALTER TABLE samples ADD CONSTRAINT samples_id_import_unique UNIQUE(import_id,id);
ALTER TABLE samples ADD CONSTRAINT samples_import_format_fk FOREIGN KEY(import_id,format_version) REFERENCES imports(id,format_version);
ALTER TABLE samples ADD CONSTRAINT samples_v2_result_check CHECK(
  format_version=1 OR
  (result_kind IS NOT NULL AND result_kind IN ('all_negative','has_positive') AND source_row IS NOT NULL AND source_row>0)
);
CREATE UNIQUE INDEX samples_v2_identity ON samples(import_id,sample_code) WHERE format_version=2;
CREATE TABLE import_pathogens (
  import_id text NOT NULL REFERENCES imports(id),
  pathogen_code text NOT NULL REFERENCES pathogens(code) CHECK(pathogen_code<>'N'),
  raw_name text NOT NULL DEFAULT '', source_row integer NOT NULL CHECK(source_row>0),
  PRIMARY KEY(import_id,pathogen_code)
);
CREATE INDEX import_pathogens_code ON import_pathogens(pathogen_code,import_id);
CREATE TABLE sample_detections (
  import_id text NOT NULL, sample_id bigint NOT NULL,
  pathogen_code text NOT NULL, ct double precision,
  raw_value text NOT NULL, raw_name text NOT NULL,
  source_row integer NOT NULL CHECK(source_row>0),
  PRIMARY KEY(sample_id,pathogen_code),
  FOREIGN KEY(import_id,sample_id) REFERENCES samples(import_id,id),
  FOREIGN KEY(import_id,pathogen_code) REFERENCES import_pathogens(import_id,pathogen_code)
);
CREATE INDEX sample_detections_code ON sample_detections(pathogen_code,sample_id);
CREATE TABLE import_detection_groups (
  import_id text NOT NULL REFERENCES imports(id),
  group_no integer NOT NULL CHECK(group_no>0),
  positive_codes text[] NOT NULL CHECK(array_position(positive_codes,NULL) IS NULL),
  sample_count bigint NOT NULL CHECK(sample_count>0),
  PRIMARY KEY(import_id,group_no)
);
```

- [x] 补充并运行约束测试：格式 2 同上传 sam 重复失败；不同上传 sam 相同允许；同样本同病毒重复失败；跨上传拼接 sample/病原体失败；不在检测范围的代码失败；空 result_kind/source_row 在格式 2 中失败。用 `assert.rejects(db.query(...), {code: '23505'})` 验证唯一冲突、`23503` 验证外键、`23514` 验证 CHECK；测试数据先按上述必需列创建两个格式 2 上传，不能依赖后续解析器。
- [x] 再运行 `node --test tests/sample-schema.test.mjs` 和 `git diff --check`，记录结果。尚不运行真实库迁移。
- [x] 实施时只暂存本票四个文件，中文提交说明使用“新增样本检测模型的版本化表结构”。
