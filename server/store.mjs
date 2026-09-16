import { authorizeWrite, lockWrites } from './write-gate.mjs';
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { connectDatabase, migrate, verifySchema } from './database.mjs';
export async function openStore(dir) {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const db = connectDatabase();
  try {
    if (process.env.SENTRY_AUTO_MIGRATE === '1') await migrate(db);
    else await verifySchema(db);
    return db;
  } catch (e) {
    await db.close();
    throw e;
  }
}
export async function stage(
  db,
  {
    id = randomUUID(),
    fileName,
    hash,
    location,
    date,
    payload,
    user,
    demo = 0,
  },
) {
  await db.query(
    `INSERT INTO imports(id,file_name,sha256,province_code,province,city_code,city,county_code,county,submitted_by,submitted_name,submitted_username,report_date,created_at,status,source_sheet,warnings,payload,summary,demo,expires_at)
 VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,now(),'staged',$14,$15,$16,$17,$18,CASE WHEN $16::jsonb IS NULL THEN NULL ELSE now()+interval '7 days' END)`,
    [
      id,
      fileName,
      hash,
      location.province_code,
      location.province,
      location.city_code,
      location.city,
      location.county_code || '',
      location.county || '',
      user?.id || null,
      user?.display_name || user?.displayName || (demo ? '系统演示' : '未知'),
      user?.username || '',
      date,
      payload?.sheet || 'Sheet1',
      JSON.stringify(payload?.warnings || []),
      payload ? JSON.stringify(payload) : null,
      JSON.stringify(payload?.summary || {}),
      demo,
    ],
  );
  return id;
}
export async function rebuildContribution(tx, id) {
  await tx.query('DELETE FROM import_metrics WHERE import_id=$1', [id]);
  await tx.query(
    `INSERT INTO import_metrics(import_id,pathogen_code,tested,positive)
 SELECT $1,'',count(*),count(*) FILTER(WHERE positive) FROM
 (SELECT s.id,bool_or(r.status='positive') positive FROM samples s JOIN results r ON r.sample_id=s.id WHERE s.import_id=$1 GROUP BY s.id) t
 UNION ALL SELECT $1,r.pathogen_code,count(*),count(*) FILTER(WHERE r.status='positive') FROM samples s JOIN results r ON r.sample_id=s.id WHERE s.import_id=$1 GROUP BY r.pathogen_code`,
    [id],
  );
}
export async function publishInTransaction(tx, id) {
  const row = await tx.get('SELECT * FROM imports WHERE id=$1 FOR UPDATE', id);
  if (row?.status === 'published')
    return { added: row.summary.samples, alreadyCommitted: true };
  if (!row || row.status !== 'staged' || !row.payload)
    throw Object.assign(Error('该预览不存在或已过期，请重新上传。'), {
      status: 400,
    });
  const records = row.payload.records;
  await tx.query(
    `INSERT INTO pathogens(code,name) SELECT key,value FROM jsonb_each_text($1::jsonb) ON CONFLICT(code) DO NOTHING`,
    [JSON.stringify(row.payload.names)],
  );
  // 一次批量写入，不逐行往返数据库。
  const data = JSON.stringify(records);
  await tx.query(
    `INSERT INTO samples(import_id,batch,sample_code) SELECT DISTINCT $1,x.batch,x.sample FROM jsonb_to_recordset($2::jsonb) AS x(batch text,sample text)`,
    [id, data],
  );
  await tx.query(
    `INSERT INTO results(sample_id,pathogen_code,status,ct,raw_value,raw_name,source_row)
 SELECT s.id,x.code,x.status,x.ct,x.raw,x.name,x."sourceRow" FROM jsonb_to_recordset($2::jsonb) AS x(batch text,sample text,code text,status text,ct double precision,raw text,name text,"sourceRow" integer)
 JOIN samples s ON s.import_id=$1 AND s.batch=x.batch AND s.sample_code=x.sample`,
    [id, data],
  );
  await rebuildContribution(tx, id);
  await tx.query(
    "UPDATE imports SET status='published',created_at=now(),payload=NULL,expires_at=NULL WHERE id=$1",
    [id],
  );
  await tx.query(
    'UPDATE dataset_state SET revision=revision+1,updated_at=now() WHERE id=1',
  );
  return { added: row.summary.samples, alreadyCommitted: false };
}
export const publish = (db, id) =>
  db.transaction(async (tx) => {
    await lockWrites(tx);
    return publishInTransaction(tx, id);
  });
export async function withdraw(db, id, user) {
  return db.transaction(async (tx) => {
    await authorizeWrite(tx, user);
    const row = await owned(tx, id, user, true);
    if (row.status === 'withdrawn') return { ok: true };
    if (row.status !== 'published')
      throw Object.assign(Error('尚未提交的数据不能作废。'), { status: 400 });
    await tx.query(
      "UPDATE imports SET status='withdrawn',withdrawn_at=now(),withdrawn_by=$2,withdrawn_name=$3 WHERE id=$1",
      [id, user.id, `${user.display_name}（${user.username}）`],
    );
    await tx.query(
      'UPDATE dataset_state SET revision=revision+1,updated_at=now() WHERE id=1',
    );
    return { ok: true };
  });
}
export async function owned(db, id, user, lock = false) {
  if (typeof id !== 'string')
    throw Object.assign(Error('上传批次号无效。'), { status: 400 });
  const row = await db.get(
    'SELECT * FROM imports WHERE id=$1 AND demo=0' +
      (lock ? ' FOR UPDATE' : ''),
    id,
  );
  if (!row || (user.role !== 'superadmin' && row.submitted_by !== user.id))
    throw Object.assign(Error('提交不存在或无权操作。'), { status: 404 });
  return row;
}
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
export async function dashboard(
  db,
  { demo = false, from = '', to = '', region = '', pathogen = '' } = {},
) {
  return db.transaction(
    async (tx) => {
      const params = [demo ? 1 : 0];
      let filter = "i.demo=$1 AND i.status='published'";
      const add = (sql, v) => {
        params.push(v);
        filter += ' AND ' + sql.replace('?', '$' + params.length);
      };
      if (from) add('i.report_date>=?', from);
      if (to) add('i.report_date<=?', to);
      if (region && region !== '100000') {
        const col = region.endsWith('0000')
          ? 'province_code'
          : region.endsWith('00')
            ? 'city_code'
            : 'county_code';
        add('i.' + col + '=?', region);
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
      const total = grouped.find((x) => x.gp && x.gc && x.gd && x.gm) || {};
      const rankingRows = await tx.all(
        `SELECT m.pathogen_code code,p.name,sum(m.tested)::bigint tested,sum(m.positive)::bigint positive FROM imports i JOIN import_metrics m ON m.import_id=i.id JOIN pathogens p ON p.code=m.pathogen_code WHERE ${filter} GROUP BY m.pathogen_code,p.name ORDER BY sum(m.positive) DESC,m.pathogen_code`,
        ...params,
      );
      const ranking = rankingRows.map((r) => ({
        ...r,
        rate: r.tested ? r.positive / r.tested : null,
      }));
      const heatmap = await tx.all(
        `SELECT m.pathogen_code code,to_char(i.report_date,'YYYY-MM') AS month,sum(m.positive)::bigint count FROM imports i JOIN import_metrics m ON m.import_id=i.id WHERE ${filter} AND m.pathogen_code<>'' GROUP BY m.pathogen_code,month HAVING sum(m.positive)>0 ORDER BY month,code`,
        ...params,
      );
      const extent = await tx.get(
        "SELECT min(i.report_date) earliest,max(i.report_date) latest,coalesce(sum(m.tested),0)::bigint count FROM imports i JOIN import_metrics m ON m.import_id=i.id AND m.pathogen_code='' WHERE i.demo=$1 AND i.status='published'",
        demo ? 1 : 0,
      );
      const state = await tx.get(
        'SELECT updated_at FROM dataset_state WHERE id=1',
      );
      const regions = {};
      for (const [key, group] of [
        ['province', 'gp'],
        ['city', 'gc'],
        ['county', 'gd'],
      ])
        regions[key] = grouped
          .filter((r) => !r[group] && r[key + '_code'])
          .map((r) => ({ code: r[key + '_code'], name: r[key], ...stats(r) }));
      return {
        metrics: {
          ...stats(total),
          submissions: Number(total.submissions || 0),
          pathogens: ranking.filter((r) => r.positive > 0).length,
        },
        extent,
        ranking,
        heatmap,
        trend: grouped
          .filter((r) => !r.gm)
          .map((r) => ({ month: r.month, ...stats(r) }))
          .sort((a, b) => a.month.localeCompare(b.month)),
        regions,
        cooccurrence: [],
        missingPanel: 0,
        updatedAt: state.updated_at,
      };
    },
    { readOnly: true },
  );
}
export async function rebuildAll(db) {
  return db.transaction(async (tx) => {
    await lockWrites(tx, { allowMaintenance: true });
    // 与发布事务固定相同锁顺序：先阻止新的批次写入，再更新汇总与版本。
    await tx.query('LOCK TABLE imports IN SHARE ROW EXCLUSIVE MODE');
    for (const row of await tx.all(
      "SELECT id FROM imports WHERE status IN('published','withdrawn') ORDER BY id",
    ))
      await rebuildContribution(tx, row.id);
    await tx.query(
      'UPDATE dataset_state SET revision=revision+1,updated_at=now() WHERE id=1',
    );
  });
}
