# 02：双 Sheet 解析与样本聚合

Status: planned

依据：[规格](../spec.md) 第 4 节及[计划公共契约](../plan.md)。依赖：无。

**文件：**修改 `server/parser.mjs`；新增 `tests/helpers/workbook-v2.mjs`、`tests/parser-v2.test.mjs`。本票不改旧迁移 fixture，以免历史样表被悄悄改成新口径。

**接口：**`parseWorkbook(bytes): Promise<PayloadV2>`；`summarizeSamples(samples, detections, panel, rows): PayloadV2['summary']`；旧 `summarize(records)` 暂保留供旧调用方直至票 05 移除。`dualWorkbook(rows, codes, {sheet1='Sheet1',sheet2='Sheet2'}={})` 只生成明确声明检测范围的测试文件。

- [ ] 新建双 Sheet 夹具并写失败用例。

```js
import ExcelJS from 'exceljs';
export async function dualWorkbook(rows, codes, {sheet1='Sheet1',sheet2='Sheet2'}={}) {
  const book = new ExcelJS.Workbook();
  const result = book.addWorksheet(sheet1);
  result.addRow(['batch','sam','PathogenWithReads','CT value','中文']);
  rows.forEach(row => result.addRow(row));
  const panel = book.addWorksheet(sheet2);
  panel.addRow(['PathogenWithReads','中文']);
  codes.forEach(code => panel.addRow([code, '']));
  return Buffer.from(await book.xlsx.writeBuffer());
}
```

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseWorkbook } from '../server/parser.mjs';
import { dualWorkbook } from './helpers/workbook-v2.mjs';
test('N 保留为样本，多种检出只计一个阳性样本', async () => {
  const payload = await parseWorkbook(await dualWorkbook([
    ['B','001','N','阴性',''],
    ['B','002','IAV',25,''],
    ['B','002','RSV','-',''],
  ], ['IAV','RSV','ADV']));
  assert.equal(payload.formatVersion,2);
  assert.deepEqual(payload.sheets,['Sheet1','Sheet2']);
  assert.equal(payload.samples[0].sample,'001');
  assert.equal(payload.samples.length,2);
  assert.equal(payload.detections.length,2);
  assert.equal(payload.detections[1].ct,null);
  assert.equal(payload.summary.positive,1);
  assert.equal(payload.summary.negative,1);
  assert.equal(payload.summary.testedPathogens,3);
  assert.equal(payload.summary.detectedPathogens,2);
  assert.equal(payload.summary.rate,0.5);
});
test('只有 N 的文件可形成待确认数据', async () => {
  const payload = await parseWorkbook(await dualWorkbook([['B','S','N','','']],['IAV']));
  assert.equal(payload.summary.samples,1);
  assert.equal(payload.summary.rate,0);
  assert.equal(payload.detections.length,0);
});
```

- [ ] 运行 `node --test tests/parser-v2.test.mjs`，确认新语义测试失败。
- [ ] 先校验 Sheet2 再处理 Sheet1。复用现有 ZIP、文本/富文本/公式结果读取、前十行查表头机制；Sheet1 必需 batch/sam/病原体，CT 可选；Sheet2 必需病原体代码。样本聚合使用规范化文本 sam，不包含 batch，写入前检查 batch 一致。关键合并逻辑如下，错误信息必须带实际表名和行号：

```js
const existing = bySample.get(sample);
if (existing && existing.batch !== batch) throw Error(`Sheet1 第 ${sourceRow} 行：同一 sam 的 batch 不一致。`);
const resultKind = code === 'N' ? 'all_negative' : 'has_positive';
if (existing && existing.resultKind !== resultKind) throw Error(`Sheet1 第 ${sourceRow} 行：N 与阳性结果冲突。`);
const key = JSON.stringify([sample, code]);
if (seen.has(key)) throw Error(`Sheet1 第 ${seen.get(key)}、${sourceRow} 行：样本与病原体重复。`);
seen.set(key, sourceRow);
if (!existing) bySample.set(sample, {sample,batch,resultKind,sourceRow});
```

- [ ] 校验具体代码必须位于 panel；代码为 N 时只形成 sample。具体代码行的 CT 空/横线置 null、有限数字保存，`阴性` 或异常文本报错；N 的 CT 只接受空/横线/阴性。去首尾空白后代码仍大小写敏感；Sheet2 重复代码、N、空面板、标识超长均拒绝。保留 KNOWN_NAMES 作为名称回退但新 payload.names 不包含 N。
- [ ] 名称来源优先 Sheet2 显式名称、既有 KNOWN_NAMES、代码；Sheet1 的冲突名称只形成警告。数据库中已有名称冲突由票 03 发布前校验，因为解析器不接数据库。CT 和名称的原始文本随 detection 保留，panel.rawName 保存 Sheet2 原输入。
- [ ] 汇总直接从 samples、detections、panel 生成，rows 取 Sheet1 非空数据行数；positive 为 `has_positive` 数量、negative=samples−positive、tested=samples、rate 零分母 null，detectedPathogens 从 detection.code 去重，excluded=0。
- [ ] 增加表驱动失败用例，至少包含以下实际输入及断言：

```js
for (const [rows,codes,message] of [
  [[['B','S','N','',''],['B','S','IAV',25,'']],['IAV'],/冲突/],
  [[['B','S','IAV',25,''],['B','S','IAV',25,'']],['IAV'],/重复/],
  [[['B','S','N','',''],['B2','S','N','','']],['IAV'],/batch/],
  [[['B','S','RSV',25,'']],['IAV'],/Sheet2|检测范围/],
  [[['B','S','IAV','阴性','']],['IAV'],/CT|冲突/],
  [[['B','S','N',25,'']],['IAV'],/CT|冲突/],
  [[['B','S','N','','']],['IAV','IAV'],/Sheet2.*重复/],
  [[['B','S','N','','']],['N'],/Sheet2.*N/],
  [[['B','S','N','','']],[],/Sheet2/],
]) {
  await assert.rejects(parseWorkbook(await dualWorkbook(rows,codes)),message);
}
```

- [ ] 添加资源与编号边界：30,000 个不同 sam 的 N 行通过、30,001 行失败；1,000 个不同 panel 代码通过、1,001 个失败；文本 `001` 与数值 `1` 分别保留为 `001` 和 `1`；文本 `1` 与数值 `1` 同病毒判重复；缺表、缺列、中文别名、完全空行、公式无结果与异常公式结果均产生可解释结果，不能无限循环或把空结果当阴性。
- [ ] 运行 `node --test tests/parser-v2.test.mjs`；在实施记录中说明这些是边界功能测试，不是容量压测。
- [ ] 实施时仅提交本票文件，中文说明“支持双工作表与样本级检测结果解析”。
