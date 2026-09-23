import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ExcelJS from 'exceljs';
import { parseWorkbook } from '../server/parser.mjs';

void test('下载模板填写阳性和阴性样本后可直接导入并保留样本编号', async () => {
  const bytes = await readFile(
    new URL(
      '../public/templates/detection-import-template.xlsx',
      import.meta.url,
    ),
  );
  const book = new ExcelJS.Workbook();
  await book.xlsx.load(bytes);
  const results = book.getWorksheet('Sheet1');
  const panel = book.getWorksheet('Sheet2');
  for (const sheet of [results, panel]) {
    assert.ok(sheet);
    sheet.eachRow((row, index) => {
      if (index > 1)
        assert.equal(row.actualCellCount, 0, '模板不能包含示例数据');
    });
  }
  // 按管理员填写模板的方式从第二行录入，使用真实解析器校验字段兼容性。
  results.getRow(2).values = ['B001', '001', 'IAV', 25.5, '甲型流感病毒'];
  results.getRow(3).values = ['B001', '002', 'N', '阴性', ''];
  panel.getRow(2).values = ['IAV', '甲型流感病毒'];
  panel.getRow(3).values = ['RSV', '呼吸道合胞病毒'];
  const parsed = await parseWorkbook(await book.xlsx.writeBuffer());
  assert.deepEqual(
    parsed.samples.map((sample) => sample.sample),
    ['001', '002'],
  );
  assert.equal(parsed.summary.positive, 1);
  assert.equal(parsed.summary.negative, 1);
  assert.equal(parsed.summary.testedPathogens, 2);
  assert.equal(parsed.detections[0].ct, 25.5);
  assert.deepEqual(parsed.warnings, []);
});
