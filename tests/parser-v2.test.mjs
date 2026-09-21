import test from 'node:test';
import assert from 'node:assert/strict';
import { parseWorkbook } from '../server/parser.mjs';
import { dualWorkbook } from './helpers/workbook-v2.mjs';

test('N 保留为样本，多种检出只计一个阳性样本', async () => {
  const payload = await parseWorkbook(
    await dualWorkbook(
      [
        ['B', '001', 'N', '阴性', ''],
        ['B', '002', 'IAV', 25, '甲型流感病毒'],
        ['B', '002', 'RSV', '-', '呼吸道合胞病毒'],
      ],
      [
        ['IAV', '甲型流感病毒'],
        ['RSV', '呼吸道合胞病毒'],
        ['ADV', '腺病毒'],
      ],
    ),
  );
  assert.equal(payload.formatVersion, 2);
  assert.deepEqual(payload.sheets, ['Sheet1', 'Sheet2']);
  assert.equal(payload.samples[0].sample, '001');
  assert.equal(payload.samples.length, 2);
  assert.equal(payload.detections.length, 2);
  assert.equal(payload.detections[1].ct, null);
  assert.equal(payload.summary.positive, 1);
  assert.equal(payload.summary.negative, 1);
  assert.equal(payload.summary.testedPathogens, 3);
  assert.equal(payload.summary.detectedPathogens, 2);
  assert.equal(payload.summary.rate, 0.5);
});

test('只有 N 的文件可形成待确认数据', async () => {
  const payload = await parseWorkbook(
    await dualWorkbook([['B', 'S', 'N', '', '']], ['IAV']),
  );
  assert.equal(payload.summary.samples, 1);
  assert.equal(payload.summary.rate, 0);
  assert.equal(payload.detections.length, 0);
});

test('双 Sheet 校验拒绝样本冲突和不在检测范围的结果', async () => {
  for (const [rows, codes, message] of [
    [
      [
        ['B', 'S', 'N', '', ''],
        ['B', 'S', 'IAV', 25, ''],
      ],
      ['IAV'],
      /冲突/,
    ],
    [
      [
        ['B', 'S', 'IAV', 25, ''],
        ['B', 'S', 'IAV', 25, ''],
      ],
      ['IAV'],
      /重复/,
    ],
    [
      [
        ['B', 'S', 'N', '', ''],
        ['B2', 'S', 'N', '', ''],
      ],
      ['IAV'],
      /batch/,
    ],
    [[['B', 'S', 'RSV', 25, '']], ['IAV'], /Sheet2|检测范围/],
    [[['B', 'S', 'IAV', '阴性', '']], ['IAV'], /CT|冲突/],
    [[['B', 'S', 'N', 25, '']], ['IAV'], /CT|冲突/],
    [[['B', 'S', 'N', '', '']], ['IAV', 'IAV'], /Sheet2.*重复/],
    [[['B', 'S', 'N', '', '']], ['N'], /Sheet2.*N/],
    [[['B', 'S', 'N', '', '']], [], /Sheet2/],
  ])
    await assert.rejects(
      parseWorkbook(await dualWorkbook(rows, codes)),
      message,
    );
});

test('缺少任一必需工作表或列时给出明确错误', async () => {
  await assert.rejects(
    parseWorkbook(
      await dualWorkbook([['B', 'S', 'N', '', '']], ['IAV'], {
        sheet2: '',
      }),
    ),
    /Sheet2/,
  );
  await assert.rejects(
    parseWorkbook(
      await dualWorkbook([['B', 'S', 'N']], ['IAV'], {
        sheet1Headers: ['batch', 'sam', '其他'],
      }),
    ),
    /Sheet1/,
  );
});

test('文本前导零保留，数值与同文本标识会触发重复', async () => {
  const payload = await parseWorkbook(
    await dualWorkbook([['B', '001', 'N', '', '']], ['IAV']),
  );
  assert.equal(payload.samples[0].sample, '001');
  await assert.rejects(
    parseWorkbook(
      await dualWorkbook(
        [
          ['B', 1, 'IAV', 25, ''],
          ['B', '1', 'IAV', 25, ''],
        ],
        ['IAV'],
      ),
    ),
    /重复/,
  );
});
