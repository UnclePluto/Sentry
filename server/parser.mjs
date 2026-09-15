import ExcelJS from 'exceljs';
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
export async function parseWorkbook(bytes) {
  const book = new ExcelJS.Workbook();
  try {
    await book.xlsx.load(bytes);
  } catch {
    throw new Error('无法读取 Excel，请上传有效的 .xlsx 文件。');
  }
  const sheet = book.getWorksheet('Sheet1');
  if (!sheet) throw new Error('缺少 Sheet1 工作表，请将检测结果放在 Sheet1。');
  if (sheet.rowCount > 50000) throw new Error('Sheet1 不能超过 50,000 行。');
  let cols, header;
  for (let n = 1; n <= Math.min(10, sheet.rowCount); n++) {
    const values = sheet.getRow(n).values.map((v) => text(v).toLowerCase());
    const found = Object.fromEntries(
      Object.entries(aliases).map(([key, names]) => [
        key,
        values.findIndex((v) => names.includes(v)),
      ]),
    );
    if (['batch', 'sample', 'pathogen', 'ct'].every((k) => found[k] > 0)) {
      cols = found;
      header = n;
      break;
    }
  }
  if (!cols)
    throw new Error('Sheet1 需要 batch、sam、PathogenWithReads、CT value 列。');
  const records = [],
    errors = [],
    names = { ...KNOWN_NAMES },
    warnings = [],
    seen = new Map();
  let excluded = 0;
  for (let n = header + 1; n <= sheet.rowCount; n++) {
    const row = sheet.getRow(n);
    const get = (key) =>
      cols[key] > 0 ? text(row.getCell(cols[key]).value) : '';
    const batch = get('batch'),
      sample = get('sample'),
      code = get('pathogen'),
      raw = get('ct'),
      name = get('name');
    if (![batch, sample, code, raw, name].some(Boolean)) continue;
    if (code === 'N' || raw === '-' || raw === '—') {
      excluded++;
      continue;
    }
    if (!batch || !sample || !code) {
      errors.push(`Sheet1 第 ${n} 行：检测批次、试剂标识和病原体不能为空。`);
      continue;
    }
    if ([batch, sample, code, name].some((v) => v.length > 200)) {
      errors.push(`Sheet1 第 ${n} 行：标识或名称不能超过 200 个字符。`);
      continue;
    }
    let status,
      ct = null;
    if (raw === '阴性') status = 'negative';
    else if (
      raw &&
      /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(raw) &&
      Number.isFinite(Number(raw))
    ) {
      status = 'positive';
      ct = Number(raw);
    } else {
      errors.push(
        `Sheet1 第 ${n} 行 CT 值“${raw.slice(0, 40)}”无法识别，请填数值或阴性。`,
      );
      continue;
    }
    const key = JSON.stringify([batch, sample, code]);
    if (seen.has(key))
      errors.push(
        `Sheet1 第 ${seen.get(key)}、${n} 行重复：${batch} / ${sample} / ${code}，请修改后重新上传。`,
      );
    else seen.set(key, n);
    if (!Object.hasOwn(names, code)) names[code] = name || code;
    records.push({ batch, sample, code, raw, name, status, ct, sourceRow: n });
  }
  if (errors.length) throw new Error(errors.slice(0, 12).join('\n'));
  if (!records.length) throw new Error('Sheet1 没有有效检测数据，不能提交。');
  if (excluded)
    warnings.push(`已剔除 ${excluded} 行对照数据（CT 为横线或病原体为 N）。`);
  return {
    sheet: 'Sheet1',
    records,
    names,
    warnings,
    summary: { ...summarize(records), excluded },
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
