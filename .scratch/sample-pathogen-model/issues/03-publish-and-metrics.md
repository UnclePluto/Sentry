# 03：原子发布、版本化任务与可重建汇总

Status: complete

依据：[规格](../spec.md) 第 3–4、7 节及[计划契约](../plan.md)。依赖：01、02。

**文件：**新增 `server/sample-import.mjs`、`server/sample-metrics.mjs`、`tests/sample-publish.test.mjs`；修改 `server/store.mjs`、`server/jobs.mjs`、`server/worker.mjs`、`tests/write-races.test.mjs` 中与新 payload 直接相关的故障注入。

**输入接口：**票 02 的 PayloadV2、票 01 的数据库版本 2。**输出接口：**`writeSampleImport(tx, importId, payload)`、`rebuildSampleMetrics(tx, importId)`；现有 `stage`、`publishInTransaction`、`rebuildContribution`、`rebuildAll` 导出名保留。后两者按 imports.format_version 分派，版本 1 继续用旧 results 重建。

- [x] 写原子发布的失败测试，以真实临时 PostgreSQL 和 HTTP 任务验证两条样本、多项检出，以及全阴性文件都可提交。

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './helpers/submission.mjs';
import { dualWorkbook } from './helpers/workbook-v2.mjs';
import { connectDatabase } from '../server/database.mjs';
test('发布同时生成范围、样本、检出和零阳性指标', {timeout:40000}, async t => {
  const f = await fixture(t);
  const db = connectDatabase(f.pg.url);
  t.after(() => db.close());
  const preview = await f.preview(await dualWorkbook([
    ['B','S1','N','阴性',''],['B','S2','IAV',25,''],['B','S2','RSV',30,''],
  ],['IAV','RSV','ADV']));
  assert.equal(preview.data.status,'ready');
  assert.equal(preview.data.formatVersion,2);
  const published = await f.commit(preview.data.id);
  assert.equal(published.data.status,'succeeded');
  assert.equal((await db.get('SELECT count(*) n FROM samples')).n,2);
  assert.equal((await db.get('SELECT count(*) n FROM sample_detections')).n,2);
  assert.equal((await db.get('SELECT count(*) n FROM results')).n,0);
  const zero = await db.get("SELECT tested,positive FROM import_metrics WHERE import_id=$1 AND pathogen_code='ADV'",preview.data.id);
  assert.deepEqual(zero,{tested:2,positive:0});
  const groups = await db.all('SELECT positive_codes,sample_count FROM import_detection_groups WHERE import_id=$1 ORDER BY group_no',preview.data.id);
  assert.equal(groups.reduce((n,r)=>n+r.sample_count,0),2);
  assert.equal(groups.filter(r=>r.positive_codes.length===0)[0].sample_count,1);
  await f.commit(preview.data.id);
  assert.equal((await db.get('SELECT count(*) n FROM samples')).n,2);
});
```

- [x] 运行 `node --test tests/sample-publish.test.mjs`，确认失败定位到新版发布、预览字段或汇总缺失。
- [x] `stage` 为新接收的任务显式写 format_version=2；不改变表默认 1。worker 持久化 payload 时再次校验 formatVersion；getJob 返回 formatVersion 和 sheets，发布后也能通过 imports.format_version 重建 sheet 名称。history 的 SELECT 加 format_version，并在 API 映射为 formatVersion。
- [x] `commitJob` 和 `publishInTransaction` 对缺少 formatVersion:2 的待发布 payload 返回中文不可重试业务错误，要求重新上传；不自动转换旧 records。已发布批次的重复确认先保持原有幂等返回。租约、job→import 的锁顺序、写入门、清理与有效期行为保持不变。
- [x] 校验 payload 的样本身份、N/阳性一致性、代码属于 panel、唯一检测项及汇总真实性，不能信任可能被篡改的暂存 summary。字典先批量插入缺失代码，再对 Sheet2 明确提供 rawName 的项检查实际字典名；不覆盖历史名称，冲突整笔回滚。rawName 为空时允许使用库内名称，避免将无名称输入误作改名请求。
- [x] `writeSampleImport` 先写范围再写样本、最后写明细，全部使用当前 tx。数据映射采用 jsonb_to_recordset 批量写入；示例为 sample/detection 写入语句，值始终通过参数传递：

```sql
INSERT INTO samples(import_id,batch,sample_code,format_version,result_kind,source_row)
SELECT $1,x.batch,x.sample,2,x."resultKind",x."sourceRow"
FROM jsonb_to_recordset($2::jsonb)
AS x(batch text,sample text,"resultKind" text,"sourceRow" integer);

INSERT INTO sample_detections(import_id,sample_id,pathogen_code,ct,raw_value,raw_name,source_row)
SELECT $1,s.id,x.code,x.ct,x.raw,x.name,x."sourceRow"
FROM jsonb_to_recordset($2::jsonb)
AS x(sample text,code text,ct double precision,raw text,name text,"sourceRow" integer)
JOIN samples s ON s.import_id=$1 AND s.sample_code=x.sample AND s.format_version=2;
```

- [x] 生成每个样本的规范化实际阳性数组，再按数组聚合。必须 LEFT JOIN 以保留 N 样本，不把无明细的样本丢掉。分组序号只在重建内标识行：

```sql
WITH sample_codes AS (
  SELECT s.id,coalesce(
    array_agg(d.pathogen_code ORDER BY d.pathogen_code COLLATE "C")
      FILTER(WHERE d.pathogen_code IS NOT NULL),'{}'::text[]
  ) AS codes
  FROM samples s LEFT JOIN sample_detections d ON d.sample_id=s.id
  WHERE s.import_id=$1 AND s.format_version=2 GROUP BY s.id
), grouped AS (
  SELECT codes,count(*)::bigint n FROM sample_codes GROUP BY codes
)
INSERT INTO import_detection_groups(import_id,group_no,positive_codes,sample_count)
SELECT $1,(row_number() OVER(ORDER BY codes))::integer,codes,n FROM grouped;
```

- [x] rebuildSampleMetrics 在当前事务删除本上传旧贡献后重建：总体指标从样本算；单病原体从 import_pathogens LEFT JOIN sample_detections 算，tested 都是该上传样本总数。校验 N 无明细、has_positive 至少一条、所有组合数量与总体/各病毒数量一致，再允许发布状态改为 published 与 revision 增加。
- [x] 添加回滚、字典竞争和篡改测试。停 worker 后给暂存 payload.detections 追加重复项；或在预览后向字典插入同代码不同名称；重启 worker 确认必须失败，samples/detections/metrics/groups 均无该上传残留。直接测试 payload.samples 的 all_negative 与非空明细冲突，不能仅依赖解析器阻挡。

```js
await db.query("UPDATE imports SET payload=jsonb_set(payload,'{detections}',(payload->'detections')||jsonb_build_array(payload->'detections'->0)) WHERE id=$1",[preview.data.id]);
for (const table of ['import_pathogens','samples','sample_detections','import_metrics','import_detection_groups']) {
  assert.equal((await db.get(`SELECT count(*) n FROM ${table} WHERE import_id=$1`,preview.data.id)).n,0);
}
```

上面 table 名是测试中固定常量，不接受外部输入；断言放在失败任务终态之后。将既有 write-races 对 records 的故障注入改为 detections，并根据新错误是否属于业务错误准确验证重试策略，不能强行把不可重试冲突重试五次。
- [x] 验证重复确认、不同上传同 sam 独立累计、作废后事实保留、组合重建前后相同、后台重启后预览字段不丢失。旧格式拒绝应有单独用例：创建 format_version=1 的 ready 任务及旧 records payload，确认返回 400，旧 payload 与历史事实不被伪造为格式 2。
- [x] 运行 `node --test tests/sample-schema.test.mjs tests/parser-v2.test.mjs tests/sample-publish.test.mjs`，记录实际结果。完整旧夹具回归在票 05 进行。
- [x] 实施时只提交本票文件，中文说明“原子发布样本事实并生成可重建统计”。
