import ExcelJS from 'exceljs';
import { checkArchive } from './xlsx-limits.mjs';
export const KNOWN_NAMES = {
  N: '未指定病原体',
  Ecoli: '大肠埃希菌',
  Spn: '肺炎链球菌',
  Hinf: '流感嗜血杆菌',
  RSV: '呼吸道合胞病毒',
  IAV: '甲型流感病毒',
  IBV: '乙型流感病毒',
  HRV: '人鼻病毒',
  ADV: '腺病毒',
  MP: '肺炎支原体',
};
const text = (value) => {
  if (value == null) return '';
  if (typeof value === 'object') {
    if ('formula' in value) return text(value.result);
    if ('richText' in value)
      return value.richText
        .map((t) => t.text)
        .join('')
        .trim();
    if ('text' in value) return text(value.text);
    return '';
  }
  return String(value).trim();
};
const aliases = {
  batch: ['batch', '批次', '批次编号'],
  sample: ['sam', 'sample', '样本编号'],
  pathogen: ['pathogenwithreads', 'pathogen', '病原体代码'],
  ct: ['ct value', 'ct', 'ct值'],
  name: ['中文', '病原体名称'],
};
function findHeader(sheet, required) {
  for (let n = 1; n <= Math.min(10, sheet.rowCount); n++) {
    const values = sheet.getRow(n).values.map((value) =>
      text(value).toLowerCase(),
    );
    const found = Object.fromEntries(
      Object.entries(aliases).map(([key, names]) => [
        key,
        values.findIndex((value) => names.includes(value)),
      ]),
    );
    if (required.every((key) => found[key] > 0))
      return { cols: found, header: n };
  }
}

const numeric = (value) =>
  value &&
  /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(value) &&
  Number.isFinite(Number(value));

export async function parseWorkbook(bytes) {
  checkArchive(bytes);
  const book = new ExcelJS.Workbook();
  try {
    await book.xlsx.load(bytes);
  } catch {
    throw new Error('无法读取 Excel，请上传有效的 .xlsx 文件。');
  }
  const sheet = book.getWorksheet('Sheet1');
  const panelSheet = book.getWorksheet('Sheet2');
  if (!sheet)
    throw new Error('缺少 Sheet1 工作表，请将样本结果放在 Sheet1。');
  if (!panelSheet)
    throw new Error('缺少 Sheet2 工作表，请将本次检测范围放在 Sheet2。');

  const panelHeader = findHeader(panelSheet, ['pathogen']);
  if (!panelHeader)
    throw new Error('Sheet2 需要 PathogenWithReads 病原体代码列。');
  const panel = [],
    names = {},
    panelCodes = new Map(),
    errors = [],
    warnings = [],
    warningKeys = new Set();
  let panelRows = 0;
  for (
    let n = panelHeader.header + 1;
    n <= panelSheet.rowCount;
    n++
  ) {
    const row = panelSheet.getRow(n);
    const get = (key) =>
      panelHeader.cols[key] > 0
        ? text(row.getCell(panelHeader.cols[key]).value)
        : '';
    const code = get('pathogen'),
      rawName = get('name');
    if (![code, rawName].some(Boolean)) continue;
    if (++panelRows > 1000)
      throw new Error('Sheet2 数据不能超过 1,000 个非空行（不含表头）。');
    if (!code) {
      errors.push(`Sheet2 第 ${n} 行：病原体代码不能为空。`);
      continue;
    }
    if ([code, rawName].some((value) => value.length > 200)) {
      errors.push(`Sheet2 第 ${n} 行：代码或名称不能超过 200 个字符。`);
      continue;
    }
    if (code === 'N') {
      errors.push(`Sheet2 第 ${n} 行：N 不是病原体，不能放入检测范围。`);
      continue;
    }
    if (panelCodes.has(code)) {
      errors.push(
        `Sheet2 第 ${panelCodes.get(code)}、${n} 行：病原体 ${code} 重复。`,
      );
      continue;
    }
    panelCodes.set(code, n);
    const name = rawName || KNOWN_NAMES[code] || code;
    names[code] = name;
    panel.push({ code, name, rawName, sourceRow: n });
  }
  if (!panel.length && !errors.length)
    errors.push('Sheet2 没有检测病原体，不能提交。');

  const resultHeader = findHeader(sheet, ['batch', 'sample', 'pathogen']);
  if (!resultHeader)
    throw new Error('Sheet1 需要 batch、sam、PathogenWithReads 列。');
  const samplesByCode = new Map(),
    detections = [],
    seen = new Map();
  let nonempty = 0;
  for (let n = resultHeader.header + 1; n <= sheet.rowCount; n++) {
    const row = sheet.getRow(n);
    const get = (key) =>
      resultHeader.cols[key] > 0
        ? text(row.getCell(resultHeader.cols[key]).value)
        : '';
    const batch = get('batch'),
      sample = get('sample'),
      code = get('pathogen'),
      raw = get('ct'),
      rawName = get('name');
    if (![batch, sample, code, raw, rawName].some(Boolean)) continue;
    if (++nonempty > 30000)
      throw new Error(
        'Sheet1 数据不能超过 30,000 个非空行（不含表头）。',
      );
    if (!batch || !sample || !code) {
      errors.push(`Sheet1 第 ${n} 行：batch、sam 和病原体不能为空。`);
      continue;
    }
    if ([batch, sample, code, rawName].some((value) => value.length > 200)) {
      errors.push(`Sheet1 第 ${n} 行：标识或名称不能超过 200 个字符。`);
      continue;
    }
    const existing = samplesByCode.get(sample);
    if (existing && existing.batch !== batch) {
      errors.push(`Sheet1 第 ${n} 行：同一 sam 的 batch 不一致。`);
      continue;
    }
    const resultKind = code === 'N' ? 'all_negative' : 'has_positive';
    if (existing && existing.resultKind !== resultKind) {
      errors.push(`Sheet1 第 ${n} 行：N 与阳性结果冲突。`);
      continue;
    }
    const key = JSON.stringify([sample, code]);
    if (seen.has(key)) {
      errors.push(
        `Sheet1 第 ${seen.get(key)}、${n} 行：样本 ${sample} 与病原体 ${code} 重复。`,
      );
      continue;
    }
    seen.set(key, n);
    if (!existing)
      samplesByCode.set(sample, {
        sample,
        batch,
        resultKind,
        sourceRow: n,
      });

    if (code === 'N') {
      if (!['', '-', '—', '阴性'].includes(raw))
        errors.push(`Sheet1 第 ${n} 行：N 与 CT 值“${raw.slice(0, 40)}”冲突。`);
      continue;
    }
    if (!panelCodes.has(code)) {
      errors.push(`Sheet1 第 ${n} 行：病原体 ${code} 不在 Sheet2 检测范围中。`);
      continue;
    }
    let ct = null;
    if (!['', '-', '—'].includes(raw)) {
      if (!numeric(raw)) {
        errors.push(
          `Sheet1 第 ${n} 行：阳性结果与 CT 值“${raw.slice(0, 40)}”冲突。`,
        );
        continue;
      }
      ct = Number(raw);
    }
    const name = names[code];
    if (rawName && rawName !== name) {
      const warningKey = `${code}\0${rawName}`;
      if (!warningKeys.has(warningKey)) {
        warningKeys.add(warningKey);
        warnings.push(
          `Sheet1 第 ${n} 行：病原体 ${code} 的名称“${rawName}”与 Sheet2 的“${name}”不同，展示名称以 Sheet2 为准。`,
        );
      }
    }
    detections.push({
      sample,
      code,
      ct,
      raw,
      name: rawName,
      sourceRow: n,
    });
  }
  if (errors.length) throw new Error(errors.slice(0, 12).join('\n'));
  const samples = [...samplesByCode.values()];
  if (!samples.length) throw new Error('Sheet1 没有样本数据，不能提交。');
  return {
    formatVersion: 2,
    sheet: 'Sheet1',
    sheets: ['Sheet1', 'Sheet2'],
    panel,
    samples,
    detections,
    names,
    warnings,
    summary: summarizeSamples(samples, detections, panel, nonempty),
  };
}
export function summarizeSamples(samples, detections, panel, rows) {
  const positive = samples.filter(
    (sample) => sample.resultKind === 'has_positive',
  ).length;
  const detectedPathogens = new Set(
    detections.map((detection) => detection.code),
  ).size;
  return {
    rows,
    samples: samples.length,
    tested: samples.length,
    positive,
    negative: samples.length - positive,
    untested: 0,
    rate: samples.length ? positive / samples.length : null,
    batches: new Set(samples.map((sample) => sample.batch)).size,
    excluded: 0,
    testedPathogens: panel.length,
    detectedPathogens,
    pathogens: detectedPathogens,
  };
}
export function summarize(records) {
  const groups = Map.groupBy(records, (r) =>
    JSON.stringify([r.batch, r.sample]),
  );
  const positive = [...groups.values()].filter((rs) =>
    rs.some((r) => r.status === 'positive'),
  ).length;
  const tested = [...groups.values()].filter((rs) =>
    rs.some((r) => r.status !== 'untested'),
  ).length;
  return {
    rows: records.length,
    samples: groups.size,
    positive,
    tested,
    untested: groups.size - tested,
    batches: new Set(records.map((r) => r.batch)).size,
    pathogens: new Set(records.filter((r) => r.code !== 'N').map((r) => r.code))
      .size,
    rate: tested ? positive / tested : null,
  };
}
