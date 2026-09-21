const stats = (row = {}) => {
  const tested = Number(row.tested || 0),
    positive = Number(row.positive || 0);
  return {
    samples: tested,
    tested,
    positive,
    untested: 0,
    rate: tested ? positive / tested : null,
  };
};

export async function readLegacyDashboard(
  tx,
  { demo = false, from = '', to = '', region = '', pathogen = '' } = {},
) {
  const params = [demo ? 1 : 0];
  let filter = "i.demo=$1 AND i.status='published'";
  const add = (sql, value) => {
    params.push(value);
    filter += ' AND ' + sql.replace('?', '$' + params.length);
  };
  if (from) add('i.report_date>=?', from);
  if (to) add('i.report_date<=?', to);
  if (region && region !== '100000') {
    const column = region.endsWith('0000')
      ? 'province_code'
      : region.endsWith('00')
        ? 'city_code'
        : 'county_code';
    add('i.' + column + '=?', region);
    if (
      !region.endsWith('0000') ||
      ['110000', '120000', '310000', '500000'].includes(region)
    )
      filter += " AND i.county_code<>''";
  }
  const pathIndex = params.length + 1;
  const grouped = await tx.all(
    `WITH selected AS (SELECT i.*,m.tested,m.positive,to_char(i.report_date,'YYYY-MM') AS month FROM imports i JOIN import_metrics m ON m.import_id=i.id WHERE ${filter} AND m.pathogen_code=$${pathIndex})
     SELECT province_code,province,city_code,city,county_code,county,month,grouping(province_code) gp,grouping(city_code) gc,grouping(county_code) gd,grouping(month) gm,coalesce(sum(tested),0)::bigint tested,coalesce(sum(positive),0)::bigint positive,count(*) submissions
     FROM selected GROUP BY GROUPING SETS((),(province_code,province),(city_code,city),(county_code,county),(month))`,
    ...params,
    pathogen,
  );
  const total =
    grouped.find((row) => row.gp && row.gc && row.gd && row.gm) || {};
  const rankingRows = await tx.all(
    `SELECT m.pathogen_code code,p.name,sum(m.tested)::bigint tested,sum(m.positive)::bigint positive FROM imports i JOIN import_metrics m ON m.import_id=i.id JOIN pathogens p ON p.code=m.pathogen_code WHERE ${filter} GROUP BY m.pathogen_code,p.name ORDER BY sum(m.positive) DESC,m.pathogen_code`,
    ...params,
  );
  const ranking = rankingRows.map((row) => ({
    ...row,
    rate: row.tested ? row.positive / row.tested : null,
  }));
  const heatmap = await tx.all(
    `SELECT m.pathogen_code code,to_char(i.report_date,'YYYY-MM') AS month,sum(m.positive)::bigint count FROM imports i JOIN import_metrics m ON m.import_id=i.id WHERE ${filter} AND m.pathogen_code<>'' GROUP BY m.pathogen_code,month HAVING sum(m.positive)>0 ORDER BY month,code`,
    ...params,
  );
  const extent = await tx.get(
    "SELECT min(i.report_date) earliest,max(i.report_date) latest,coalesce(sum(m.tested),0)::bigint count FROM imports i JOIN import_metrics m ON m.import_id=i.id AND m.pathogen_code='' WHERE i.demo=$1 AND i.status='published'",
    demo ? 1 : 0,
  );
  const state = await tx.get('SELECT updated_at FROM dataset_state WHERE id=1');
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
  return {
    metrics: {
      ...stats(total),
      submissions: Number(total.submissions || 0),
      pathogens: ranking.filter((row) => row.positive > 0).length,
    },
    extent,
    ranking,
    heatmap,
    trend: grouped
      .filter((row) => !row.gm)
      .map((row) => ({ month: row.month, ...stats(row) }))
      .sort((a, b) => a.month.localeCompare(b.month)),
    regions,
    cooccurrence: [],
    missingPanel: 0,
    updatedAt: state.updated_at,
  };
}
