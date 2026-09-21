# 05：上传页面、历史版本与演示/测试数据升级

Status: planned

依据：[规格](../spec.md) 第 4、6、7 节及[计划契约](../plan.md)。依赖：03、04。

**文件：**修改 `app/upload/page.tsx`、`lib/models.ts`、`server/demo.mjs`、`tests/helpers/submission.mjs`、`tests/submissions.test.mjs`、`tests/jobs.test.mjs`、`tests/recovery.test.mjs`、`tests/http.test.mjs`；新增 `tests/demo-v2.test.mjs`。如 auth/write-races 仅复用公共有效夹具，保持其安全性断言不变。

**接口：**Preview 添加 `formatVersion: 1 | 2`、`sheets: string[]`；ImportHistory 添加 formatVersion。新摘要使用计划中的字段，旧摘要类型保留历史字段且不伪造新的 testedPathogens/negative。`seedDemo(db)` 导出签名不变，生成 formatVersion:2。

- [ ] 添加预览/重启/历史失败断言：发布前 getJob 返回两张表和新版摘要；服务重启后相同；发布后历史包含 formatVersion=2；旧 formatVersion=1 历史仍保存原摘要。测试直接复用票 03 的提交用例，并增加：

```js
const before = (await f.request('/jobs/'+preview.data.id)).data;
await f.stop();
await f.start();
const after = (await f.request('/jobs/'+preview.data.id)).data;
assert.deepEqual(after.sheets,['Sheet1','Sheet2']);
assert.deepEqual(after.summary,before.summary);
assert.equal(after.formatVersion,2);
f.startWorker();
await f.commit(preview.data.id);
const history = (await f.request('/imports')).data.items;
assert.equal(history[0].formatVersion,2);
assert.equal(history[0].summary.negative,1);
```

- [ ] 先运行对应新增用例，确认缺少字段或演示仍为旧格式时失败。
- [ ] 修改上传成功提示、规则说明、预览和历史卡片。新格式不再展示“剔除 N/横线”；旧历史用“旧口径”标识保留旧计数标签，不假装其为重新计算的样本数。预览展示列采用：

```tsx
const previewMetrics = [
  ['样本数', preview.summary.samples],
  ['阳性样本数', preview.summary.positive],
  ['阴性样本数', preview.summary.negative],
  ['检测病原体种数', preview.summary.testedPathogens],
  ['检出病原体种数', preview.summary.detectedPathogens],
];
```

阳性率继续使用 percent；新格式缺少必需摘要不能回退成 0 掩盖错误，使用类型分支确保版本 2 有完整结构。上传说明明确 Sheet1/Sheet2 角色、单文件 sam 唯一、重复上传独立累计与整批作废。
- [ ] 演示直接生成规范 PayloadV2：固定检测 panel、每个样本一条 sample、只写阳性 detection，零检出样本标 all_negative；使用 summarizeSamples 生成摘要。保留原有地区、月份与可重复随机种子，移除旧式阴性展开及 excluded 对照逻辑。
- [ ] seedDemo 使用事务和既有写入协调：若有完整的已发布格式 2 演示数据则不重复生成；仅有格式 1 演示时，整批标作废并生成新数据，旧事实保留；不改变任何 demo=0 行。不能继续用“存在任意 demo 上传就返回”阻止升级，也不能每次启动都重新插入。新增演示测试如下：

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { databaseFixture } from './helpers/database.mjs';
import { seedDemo } from '../server/demo.mjs';
test('演示生成新事实且重启幂等', {timeout:60000}, async t => {
  const db = await databaseFixture(t);
  await seedDemo(db);
  const before = await db.get("SELECT count(*) n FROM imports WHERE demo=1 AND status='published' AND format_version=2");
  assert.ok(before.n>0);
  assert.equal((await db.get("SELECT count(*) n FROM imports WHERE demo=0")).n,0);
  assert.ok((await db.get("SELECT count(*) n FROM samples WHERE result_kind='all_negative'")).n>0);
  await seedDemo(db);
  assert.deepEqual(await db.get("SELECT count(*) n FROM imports WHERE demo=1 AND status='published' AND format_version=2"),before);
});
```

另建一条旧 demo 与一条旧真实上传后执行，验证仅旧 demo 退出已发布，真实行及摘要不变。生成失败的事务不得留下部分演示上传。
- [ ] 公共有效 workbook 改为默认明确 panel=['IAV','RSV'] 的双 Sheet 文件；检测范围不得从结果自动推断，否则阴性样本与范围缺失用例没有意义。validRows 改为下列固定数据，保持既有权限/作废用例的“2 样本、1 阳性”基线：

```js
export const validRows = [
  ['B','A','IAV',25,''],
  ['B','A','RSV',30,''],
  ['B','B','N','阴性',''],
];
```

workbook 的原第二参数工作表名称保留，内部调用 dualWorkbook；需要其他 panel 的测试显式调用 dualWorkbook。fixture 的 legacy SQLite 构建块保持旧数据结构，不改写历史测试源。
- [ ] 将 submissions 中“只读 Sheet1、剔除 N/横线”的旧行为断言改成新规则，并保留重复项、权限和地区覆盖。jobs 的 30,000 行边界改用不同 sam 的合法 N 样本，summary.samples=30000/excluded=0；recovery 中为放大文件加入的旧空标识 N 行也改为合法不同 sam，更新真实样本计数，租约接管与清理断言不变。
- [ ] 真实样表测试不再使用旧固定 294/199/84 计数。只有同时设置 SENTRY_FIXTURE_FILE 和 SENTRY_FIXTURE_EXPECTATIONS 时运行，后者是经人工核对的 JSON，至少包括 samples、positive、negative、testedPathogens、detectedPathogens；缺少一项环境变量时报配置错误，两项都缺少则明确跳过。断言从 sidecar 读取，不从被测解析器自动生成预期值。

```js
const expected = JSON.parse(await readFile(process.env.SENTRY_FIXTURE_EXPECTATIONS,'utf8'));
for (const key of ['samples','positive','negative','testedPathogens','detectedPathogens']) {
  assert.ok(Number.isSafeInteger(expected[key]) && expected[key]>=0);
  assert.equal(a.data.summary[key],expected[key]);
}
```

- [ ] 运行 `node --test tests/submissions.test.mjs tests/jobs.test.mjs tests/recovery.test.mjs tests/write-races.test.mjs tests/demo-v2.test.mjs`、`npm run typecheck`。新增解析/发布测试一并回归；旧 SQLite 核对工具在票 07 完成前若失败，应明确记录为待适配，不忽略其他失败。
- [ ] 在实际管理页面验收上传、预览、刷新恢复、历史和作废；不为文案变更编写字符串快照测试。
- [ ] 实施时选择性提交本票文件，中文说明“更新双工作表上传页面与样本演示数据”。
