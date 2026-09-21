# 04：方案 A 大盘查询与多选接口

Status: planned

依据：[规格](../spec.md) 第 5–6 节及[计划公共接口](../plan.md)。依赖：03。

**文件：**新增 `server/dashboard.mjs`、`server/legacy-dashboard.mjs`、`tests/dashboard-v2.test.mjs`；修改 `server/store.mjs`、`server/index.mjs`、`lib/models.ts`。

**接口：**`readDashboard(tx, {demo=false,from='',to='',region='',pathogens=[]})` 返回 DashboardData；store 的 dashboard 包装只读一致性事务。`readLegacyDashboard(tx, filters)` 保持旧单选结果，仅供票 07 的旧迁移比对；不允许 HTTP 通过参数切回旧口径。新 API 通过 getAll('pathogen') 获得集合。

- [ ] 写真实接口失败测试，使用三个检测范围验证方案 A；同时验证选中顺序、重复参数、零阳性、单选与无交集。

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './helpers/submission.mjs';
import { dualWorkbook } from './helpers/workbook-v2.mjs';
test('多个不同检测范围按交集纳入且样本去重', {timeout:60000}, async t => {
  const f = await fixture(t);
  async function submit(rows,codes) {
    const p = await f.preview(await dualWorkbook(rows,codes));
    assert.equal(p.data.status,'ready');
    assert.equal((await f.commit(p.data.id)).data.status,'succeeded');
  }
  await submit([['B','S1','N','',''],['B','S2','IAV',25,''],['B','S2','RSV',30,''],['B','S3','ADV',20,'']],['IAV','RSV','ADV']);
  await submit([['B','S4','N','',''],['B','S5','IAV',25,'']],['IAV']);
  await submit([['B','S6','ADV',20,'']],['ADV']);
  for (const [query,positive,samples,excluded] of [
    ['',4,6,0],['?pathogen=IAV',2,5,1],
    ['?pathogen=IAV&pathogen=RSV',2,5,1],
    ['?pathogen=RSV&pathogen=IAV&pathogen=IAV',2,5,1],
    ['?pathogen=RSV',1,3,3],['?pathogen=IAV&pathogen=ADV',4,6,0],
  ]) {
    const r = await f.request('/dashboard'+query);
    assert.equal(r.status,200);
    assert.equal(r.data.metrics.positive,positive);
    assert.equal(r.data.metrics.samples,samples);
    assert.equal(r.data.metrics.excludedNoSelectedTest,excluded);
    assert.equal(r.data.metrics.notDetected,samples-positive);
  }
  const chosen = (await f.request('/dashboard?pathogen=IAV&pathogen=RSV')).data;
  assert.deepEqual(chosen.selectedPathogens,['IAV','RSV']);
  assert.equal(chosen.ranking.find(r=>r.code==='RSV').tested,3);
});
```

- [ ] 运行 `node --test tests/dashboard-v2.test.mjs`，观察重复参数被旧 API 覆盖或结果不符合方案 A。
- [ ] 将原 dashboard 查询完整提取到 legacy-dashboard，保持旧结果 shape；新 dashboard 模块独立实现 format_version=2 路径。日期/地区筛选沿用现有规则，包括直辖市与市内排除仅到市的提交，不能用字符串 SQL 注入用户字段。病原体集合规范化后校验每项长度及是否存在于有效字典；未知代码返回 400。

```js
const pathogens = [...new Set(url.searchParams.getAll('pathogen').map(v=>v.trim()).filter(Boolean))].sort();
const filters = {
  demo: url.searchParams.get('demo') === '1',
  from: url.searchParams.get('from') || '',
  to: url.searchParams.get('to') || '',
  region: url.searchParams.get('region') || '',
  pathogens,
};
```

- [ ] 建立 base 上传集合后用 EXISTS 构建 eligible。以下 SQL 核心用于非空多选，示例参数 $1 是已完成日期/地区筛选的上传 id 数组，$2 为病原体数组；实现中可以直接合并 base CTE，避免把大量上传 id 传回 Node。

```sql
WITH eligible AS (
  SELECT i.id FROM imports i
  WHERE i.id=ANY($1::text[]) AND i.status='published' AND i.format_version=2
    AND EXISTS (SELECT 1 FROM import_pathogens p
                WHERE p.import_id=i.id AND p.pathogen_code=ANY($2::text[]))
), per_import AS (
  SELECT e.id,m.tested,
         coalesce(sum(g.sample_count) FILTER(WHERE g.positive_codes && $2::text[]),0)::bigint positive
  FROM eligible e
  JOIN import_metrics m ON m.import_id=e.id AND m.pathogen_code=''
  JOIN import_detection_groups g ON g.import_id=e.id
  GROUP BY e.id,m.tested
)
SELECT coalesce(sum(tested),0)::bigint samples,
       coalesce(sum(positive),0)::bigint positive FROM per_import;
```

每个上传先得到一行 per_import 后才按全国、省市区县、月份聚合，不能将 m.tested 在每条组合上重复相加。空选择走总体指标，单选走该病毒指标；三条路径必须返回相同类型与零分母语义。excludedNoSelectedTest 等于 base 总样本数减 eligible 总样本数，空选择固定为 0。
- [ ] 排行、热力图从 eligible 上传的单病原体指标读取；每个病毒 tested 仅包含测过它的上传。pathogenOptions 从 base 范围的 import_pathogens 独立查询，不依赖 positive>0 或当前选择。返回所有实际检测项的零值；热力图返回 tested=0 的无覆盖与 tested>0/positive=0 的零阳性区别，前端使用 null 和 0 区分。
- [ ] metrics.regions 按当前展示层级对 eligible 有样本区域去重；不按阳性数计数。保留 trend 月度指标和全局 extent，新增 selectedPathogens、pathogenOptions、notDetected、excludedNoSelectedTest 和 heatmap.tested。病原体选择项类型统一 `{code:string,name:string}`。
- [ ] 加入全阴性用例：上传只含 N、panel=['IAV','RSV']；断言选项有两种、各 tested>0/positive=0、率为 0、月份存在。再选已存在于字典但此地区未检测的代码，断言 samples=0/rate=null；不存在代码返回 400，不能错误地回退为全部。
- [ ] 加入省/市/区县、直辖市、市级无 county、不同月份、日期空范围、作废与演示隔离用例；用固定小集合穷举 3 个病毒的 8 种选择，将接口分子分母与 JavaScript 明细集合计算对比，不做大规模造数。
- [ ] 运行 `node --test tests/dashboard-v2.test.mjs tests/sample-publish.test.mjs`。既有 SQLite 迁移比较函数改用 legacyDashboard 的适配由票 07 完成并回归。
- [ ] 实施时仅提交本票文件，中文说明“按方案 A 支持多病原体样本去重统计”。
