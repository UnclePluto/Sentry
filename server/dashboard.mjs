const municipalities = ['110000', '120000', '310000', '500000'];
const invalid = (message) => Object.assign(Error(message), { status: 400 });

const stats = (row = {}) => {
  const tested = Number(row.tested || 0),
    positive = Number(row.positive || 0);
  return {
    samples: tested,
    tested,
    positive,
    notDetected: tested - positive,
    untested: 0,
    rate: tested ? positive / tested : null,
  };
};

function baseFilter({ demo, from, to, region }) {
  const values = [demo ? 1 : 0];
  let sql = "i.demo=$1 AND i.status='published' AND i.format_version=2";
  const add = (condition, value) => {
    values.push(value);
    sql += ' AND ' + condition.replace('?', '$' + values.length);
  };
  if (from) add('i.report_date>=?', from);
  if (to) add('i.report_date<=?', to);
  if (region && region !== '100000') {
    if (!/^\d{6}$/.test(region)) throw invalid('区域代码无效。');
    const column = region.endsWith('0000')
      ? 'province_code'
      : region.endsWith('00')
        ? 'city_code'
        : 'county_code';
    add(`i.${column}=?`, region);
    if (!region.endsWith('0000') || municipalities.includes(region))
      sql += " AND i.county_code<>''";
  }
  return { sql, values };
}

function selectionCtes(filter, selectedIndex) {
  return `WITH base AS (
    SELECT i.*,m.tested overall_tested,m.positive overall_positive,
      to_char(i.report_date,'YYYY-MM') AS month
    FROM imports i
    JOIN import_metrics m ON m.import_id=i.id AND m.pathogen_code=''
    WHERE ${filter}
  ), eligible AS (
    SELECT b.* FROM base b
    WHERE cardinality($${selectedIndex}::text[])=0 OR EXISTS (
      SELECT 1 FROM import_pathogens ip
      WHERE ip.import_id=b.id
        AND ip.pathogen_code=ANY($${selectedIndex}::text[])
    )
  ), per_import AS (
    SELECT e.*,
      e.overall_tested tested,
      CASE WHEN cardinality($${selectedIndex}::text[])=0
        THEN e.overall_positive
        ELSE coalesce((
          SELECT sum(g.sample_count)::bigint
          FROM import_detection_groups g
          WHERE g.import_id=e.id
            AND g.positive_codes && $${selectedIndex}::text[]
        ),0)::bigint
      END positive
    FROM eligible e
  )`;
}

function monthRange(earliest, latest) {
  if (!earliest || !latest) return [];
  const months = [];
  const cursor = new Date(earliest.slice(0, 7) + '-01T00:00:00Z');
  const end = new Date(latest.slice(0, 7) + '-01T00:00:00Z');
  while (cursor <= end) {
    months.push(cursor.toISOString().slice(0, 7));
    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }
  return months;
}

export async function readDashboard(
  tx,
  { demo = false, from = '', to = '', region = '', pathogens = [] } = {},
) {
  if (!Array.isArray(pathogens)) throw invalid('病原体筛选参数无效。');
  const selectedPathogens = [
    ...new Set(pathogens.map((code) => String(code).trim()).filter(Boolean)),
  ].sort();
  if (selectedPathogens.some((code) => code.length > 200))
    throw invalid('病原体代码不能超过 200 个字符。');
  if (selectedPathogens.length) {
    const known = await tx.all(
      'SELECT code FROM pathogens WHERE code=ANY($1::text[])',
      selectedPathogens,
    );
    const knownCodes = new Set(known.map((row) => row.code));
    const unknown = selectedPathogens.find((code) => !knownCodes.has(code));
    if (unknown) throw invalid(`病原体 ${unknown} 不存在。`);
  }

  const { sql: filter, values: baseValues } = baseFilter({
    demo,
    from,
    to,
    region,
  });
  const values = [...baseValues, selectedPathogens];
  const selectedIndex = values.length;
  const ctes = selectionCtes(filter, selectedIndex);
  const grouped = await tx.all(
    `${ctes}
     SELECT province_code,province,city_code,city,county_code,county,month,
       grouping(province_code) gp,grouping(city_code) gc,
       grouping(county_code) gd,grouping(month) gm,
       coalesce(sum(tested),0)::bigint tested,
       coalesce(sum(positive),0)::bigint positive,
       count(*)::bigint submissions
     FROM per_import
     GROUP BY GROUPING SETS (
       (),
       (province_code,province),
       (city_code,city),
       (county_code,county),
       (month)
     )`,
    ...values,
  );
  const total =
    grouped.find((row) => row.gp && row.gc && row.gd && row.gm) || {};
  const baseTotal = await tx.get(
    `SELECT coalesce(sum(m.tested),0)::bigint tested
     FROM imports i
     JOIN import_metrics m ON m.import_id=i.id AND m.pathogen_code=''
     WHERE ${filter}`,
    ...baseValues,
  );

  const rankingRows = await tx.all(
    `${ctes}
     SELECT m.pathogen_code code,p.name,
       sum(m.tested)::bigint tested,sum(m.positive)::bigint positive
     FROM eligible e
     JOIN import_metrics m ON m.import_id=e.id AND m.pathogen_code<>''
     JOIN pathogens p ON p.code=m.pathogen_code
     GROUP BY m.pathogen_code,p.name
     ORDER BY sum(m.positive) DESC,m.pathogen_code`,
    ...values,
  );
  const ranking = rankingRows.map((row) => ({
    ...row,
    rate: row.tested ? row.positive / row.tested : null,
  }));
  const pathogenOptions = await tx.all(
    `SELECT DISTINCT ip.pathogen_code code,p.name
     FROM imports i
     JOIN import_pathogens ip ON ip.import_id=i.id
     JOIN pathogens p ON p.code=ip.pathogen_code
     WHERE ${filter}
     ORDER BY ip.pathogen_code`,
    ...baseValues,
  );
  const rawHeatmap = await tx.all(
    `${ctes}
     SELECT m.pathogen_code code,e.month,
       sum(m.tested)::bigint tested,sum(m.positive)::bigint count
     FROM eligible e
     JOIN import_metrics m ON m.import_id=e.id AND m.pathogen_code<>''
     GROUP BY m.pathogen_code,e.month
     ORDER BY e.month,m.pathogen_code`,
    ...values,
  );
  const extent = await tx.get(
    `SELECT min(i.report_date) earliest,max(i.report_date) latest,
       coalesce(sum(m.tested),0)::bigint count
     FROM imports i
     JOIN import_metrics m ON m.import_id=i.id AND m.pathogen_code=''
     WHERE i.demo=$1 AND i.status='published' AND i.format_version=2`,
    demo ? 1 : 0,
  );
  const heatmapValues = new Map(
    rawHeatmap.map((row) => [`${row.code}\0${row.month}`, row]),
  );
  const heatmap = [];
  for (const option of pathogenOptions)
    for (const month of monthRange(extent.earliest, extent.latest)) {
      const row = heatmapValues.get(`${option.code}\0${month}`);
      heatmap.push({
        code: option.code,
        month,
        tested: row?.tested || 0,
        count: row?.count || 0,
      });
    }

  const regions = {};
  for (const [key, group] of [
    ['province', 'gp'],
    ['city', 'gc'],
    ['county', 'gd'],
  ])
    regions[key] = grouped
      .filter((row) => !row[group] && row[key + '_code'])
      .map((row) => ({
        code: row[key + '_code'],
        name: row[key],
        ...stats(row),
      }));
  const regionLevel =
    !region || region === '100000'
      ? 'province'
      : region.endsWith('0000') && !municipalities.includes(region)
        ? 'city'
        : 'county';
  const totalStats = stats(total);
  const excludedNoSelectedTest = selectedPathogens.length
    ? Number(baseTotal.tested) - totalStats.samples
    : 0;
  const state = await tx.get('SELECT updated_at FROM dataset_state WHERE id=1');
  return {
    metrics: {
      ...totalStats,
      excludedNoSelectedTest,
      submissions: Number(total.submissions || 0),
      pathogens: ranking.filter((row) => row.positive > 0).length,
      regions: regions[regionLevel].length,
    },
    extent,
    selectedPathogens,
    pathogenOptions,
    ranking,
    heatmap,
    trend: grouped
      .filter((row) => !row.gm)
      .map((row) => ({ month: row.month, ...stats(row) }))
      .sort((a, b) => a.month.localeCompare(b.month)),
    regions,
    cooccurrence: [],
    missingPanel: excludedNoSelectedTest,
    updatedAt: state.updated_at,
  };
}
