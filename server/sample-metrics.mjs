const invalidFacts = (message) =>
  Object.assign(Error(message), { status: 400, business: true });

export async function rebuildSampleMetrics(tx, importId) {
  const invalid = await tx.get(
    `SELECT
       count(*) FILTER(
         WHERE s.result_kind='all_negative' AND d.sample_id IS NOT NULL
       ) invalid_negative,
       count(*) FILTER(
         WHERE s.result_kind='has_positive' AND d.sample_id IS NULL
       ) invalid_positive
     FROM samples s
     LEFT JOIN sample_detections d ON d.sample_id=s.id
     WHERE s.import_id=$1 AND s.format_version=2`,
    importId,
  );
  if (invalid.invalid_negative || invalid.invalid_positive)
    throw invalidFacts('样本结论与阳性检出明细不一致。');

  await tx.query('DELETE FROM import_metrics WHERE import_id=$1', [importId]);
  await tx.query('DELETE FROM import_detection_groups WHERE import_id=$1', [
    importId,
  ]);
  await tx.query(
    `WITH totals AS (
       SELECT count(*)::bigint tested,
         count(*) FILTER(WHERE result_kind='has_positive')::bigint positive
       FROM samples WHERE import_id=$1 AND format_version=2
     )
     INSERT INTO import_metrics(import_id,pathogen_code,tested,positive)
     SELECT $1,'',tested,positive FROM totals
     UNION ALL
     SELECT $1,ip.pathogen_code,t.tested,count(DISTINCT d.sample_id)::bigint
     FROM import_pathogens ip
     CROSS JOIN totals t
     LEFT JOIN sample_detections d
       ON d.import_id=ip.import_id AND d.pathogen_code=ip.pathogen_code
     WHERE ip.import_id=$1
     GROUP BY ip.pathogen_code,t.tested`,
    [importId],
  );
  await tx.query(
    `WITH sample_codes AS (
       SELECT s.id,coalesce(
         array_agg(d.pathogen_code ORDER BY d.pathogen_code COLLATE "C")
           FILTER(WHERE d.pathogen_code IS NOT NULL),
         '{}'::text[]
       ) codes
       FROM samples s
       LEFT JOIN sample_detections d ON d.sample_id=s.id
       WHERE s.import_id=$1 AND s.format_version=2
       GROUP BY s.id
     ), grouped AS (
       SELECT codes,count(*)::bigint n FROM sample_codes GROUP BY codes
     )
     INSERT INTO import_detection_groups(import_id,group_no,positive_codes,sample_count)
     SELECT $1,row_number() OVER(ORDER BY codes)::integer,codes,n FROM grouped`,
    [importId],
  );

  const overall = await tx.get(
    "SELECT tested,positive FROM import_metrics WHERE import_id=$1 AND pathogen_code=''",
    importId,
  );
  const grouped = await tx.all(
    'SELECT positive_codes,sample_count FROM import_detection_groups WHERE import_id=$1',
    importId,
  );
  const groupTotal = grouped.reduce((sum, row) => sum + row.sample_count, 0);
  const groupPositive = grouped.reduce(
    (sum, row) => sum + (row.positive_codes.length ? row.sample_count : 0),
    0,
  );
  if (
    !overall ||
    groupTotal !== overall.tested ||
    groupPositive !== overall.positive
  )
    throw invalidFacts('样本组合汇总与总体指标不一致。');
  for (const metric of await tx.all(
    "SELECT pathogen_code,positive FROM import_metrics WHERE import_id=$1 AND pathogen_code<>''",
    importId,
  )) {
    const fromGroups = grouped.reduce(
      (sum, row) =>
        sum +
        (row.positive_codes.includes(metric.pathogen_code)
          ? row.sample_count
          : 0),
      0,
    );
    if (fromGroups !== metric.positive)
      throw invalidFacts(`病原体 ${metric.pathogen_code} 的组合汇总不一致。`);
  }
}
