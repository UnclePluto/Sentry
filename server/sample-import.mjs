const businessError = (message) =>
  Object.assign(Error(message), { status: 400, business: true });

const nonemptyText = (value) =>
  typeof value === 'string' && value.length > 0 && value.length <= 200;
const positiveRow = (value) => Number.isInteger(value) && value > 0;

export function validateSamplePayload(payload) {
  if (
    !payload ||
    payload.formatVersion !== 2 ||
    !Array.isArray(payload.panel) ||
    !Array.isArray(payload.samples) ||
    !Array.isArray(payload.detections) ||
    !payload.summary ||
    typeof payload.summary !== 'object'
  )
    throw businessError('预览数据版本无效，请重新上传双工作表文件。');
  if (!payload.panel.length || !payload.samples.length)
    throw businessError('预览数据不完整，请重新上传。');

  const panelCodes = new Set();
  for (const entry of payload.panel) {
    if (
      !nonemptyText(entry?.code) ||
      entry.code === 'N' ||
      !nonemptyText(entry?.name) ||
      typeof entry.rawName !== 'string' ||
      entry.rawName.length > 200 ||
      !positiveRow(entry.sourceRow)
    )
      throw businessError('检测范围数据不合法，请重新上传。');
    if (panelCodes.has(entry.code))
      throw businessError(`检测范围中的病原体 ${entry.code} 重复。`);
    panelCodes.add(entry.code);
  }

  const samples = new Map();
  for (const sample of payload.samples) {
    if (
      !nonemptyText(sample?.sample) ||
      !nonemptyText(sample?.batch) ||
      !['all_negative', 'has_positive'].includes(sample.resultKind) ||
      !positiveRow(sample.sourceRow)
    )
      throw businessError('样本数据不合法，请重新上传。');
    if (samples.has(sample.sample))
      throw businessError(`样本 ${sample.sample} 重复，预览数据可能已被篡改。`);
    samples.set(sample.sample, sample);
  }

  const detectionKeys = new Set();
  const detectionCounts = new Map();
  for (const detection of payload.detections) {
    if (
      !nonemptyText(detection?.sample) ||
      !nonemptyText(detection?.code) ||
      !samples.has(detection.sample) ||
      !panelCodes.has(detection.code) ||
      !positiveRow(detection.sourceRow) ||
      typeof detection.raw !== 'string' ||
      typeof detection.name !== 'string' ||
      detection.raw.length > 200 ||
      detection.name.length > 200 ||
      (detection.ct !== null &&
        (typeof detection.ct !== 'number' || !Number.isFinite(detection.ct)))
    )
      throw businessError('阳性检出明细不合法，请重新上传。');
    const key = JSON.stringify([detection.sample, detection.code]);
    if (detectionKeys.has(key))
      throw businessError(
        `样本 ${detection.sample} 的病原体 ${detection.code} 检出明细重复，预览数据可能已被篡改。`,
      );
    detectionKeys.add(key);
    detectionCounts.set(
      detection.sample,
      (detectionCounts.get(detection.sample) || 0) + 1,
    );
  }
  for (const sample of samples.values()) {
    const count = detectionCounts.get(sample.sample) || 0;
    if (sample.resultKind === 'all_negative' ? count !== 0 : count === 0)
      throw businessError(`样本 ${sample.sample} 的样本结论与检出明细不一致。`);
  }

  const positive = [...samples.values()].filter(
    (sample) => sample.resultKind === 'has_positive',
  ).length;
  const expected = {
    rows:
      [...samples.values()].filter(
        (sample) => sample.resultKind === 'all_negative',
      ).length + payload.detections.length,
    samples: samples.size,
    tested: samples.size,
    positive,
    negative: samples.size - positive,
    untested: 0,
    rate: samples.size ? positive / samples.size : null,
    batches: new Set([...samples.values()].map((sample) => sample.batch)).size,
    excluded: 0,
    testedPathogens: panelCodes.size,
    detectedPathogens: new Set(
      payload.detections.map((detection) => detection.code),
    ).size,
  };
  expected.pathogens = expected.detectedPathogens;
  for (const [key, value] of Object.entries(expected))
    if (payload.summary[key] !== value)
      throw businessError('预览汇总与样本事实不一致，数据可能已被篡改。');

  return payload;
}

export async function writeSampleImport(tx, importId, payload) {
  validateSamplePayload(payload);
  const panelJson = JSON.stringify(payload.panel);
  await tx.query(
    `INSERT INTO pathogens(code,name)
     SELECT x.code,x.name
     FROM jsonb_to_recordset($1::jsonb) AS x(code text,name text)
     ON CONFLICT(code) DO NOTHING`,
    [panelJson],
  );
  const conflicts = await tx.all(
    `SELECT x.code,p.name existing_name,x.name submitted_name
     FROM jsonb_to_recordset($1::jsonb)
       AS x(code text,name text,"rawName" text)
     JOIN pathogens p ON p.code=x.code
     WHERE x."rawName"<>'' AND p.name<>x.name
     ORDER BY x.code`,
    panelJson,
  );
  if (conflicts.length)
    throw businessError(
      `病原体 ${conflicts[0].code} 的名称与已有字典不一致，请核对 Sheet2。`,
    );

  await tx.query(
    `INSERT INTO import_pathogens(import_id,pathogen_code,raw_name,source_row)
     SELECT $1,x.code,x."rawName",x."sourceRow"
     FROM jsonb_to_recordset($2::jsonb)
       AS x(code text,"rawName" text,"sourceRow" integer)`,
    [importId, panelJson],
  );
  await tx.query(
    `INSERT INTO samples(import_id,batch,sample_code,format_version,result_kind,source_row)
     SELECT $1,x.batch,x.sample,2,x."resultKind",x."sourceRow"
     FROM jsonb_to_recordset($2::jsonb)
       AS x(batch text,sample text,"resultKind" text,"sourceRow" integer)`,
    [importId, JSON.stringify(payload.samples)],
  );
  await tx.query(
    `INSERT INTO sample_detections(import_id,sample_id,pathogen_code,ct,raw_value,raw_name,source_row)
     SELECT $1,s.id,x.code,x.ct,x.raw,x.name,x."sourceRow"
     FROM jsonb_to_recordset($2::jsonb)
       AS x(sample text,code text,ct double precision,raw text,name text,"sourceRow" integer)
     JOIN samples s
       ON s.import_id=$1 AND s.sample_code=x.sample AND s.format_version=2`,
    [importId, JSON.stringify(payload.detections)],
  );
}
