import { authorizeWrite, lockWrites } from './write-gate.mjs';
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { connectDatabase, migrate, verifySchema } from './database.mjs';
import { writeSampleImport } from './sample-import.mjs';
import { rebuildSampleMetrics } from './sample-metrics.mjs';
import { readDashboard } from './dashboard.mjs';
import {
  checkSampleModelReadiness,
  sampleModelNotReady,
} from './sample-model-readiness.mjs';
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
  const formatVersion = payload?.formatVersion ?? (demo ? 1 : 2);
  await db.query(
    `INSERT INTO imports(id,file_name,sha256,province_code,province,city_code,city,county_code,county,submitted_by,submitted_name,submitted_username,report_date,created_at,status,source_sheet,warnings,payload,summary,demo,expires_at,format_version)
 VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,now(),'staged',$14,$15,$16,$17,$18,CASE WHEN $16::jsonb IS NULL THEN NULL ELSE now()+interval '7 days' END,$19)`,
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
      formatVersion,
    ],
  );
  return id;
}
export async function rebuildContribution(tx, id) {
  const row = await tx.get(
    'SELECT format_version FROM imports WHERE id=$1',
    id,
  );
  if (row?.format_version === 2) return rebuildSampleMetrics(tx, id);
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
  if (row.format_version === 2) {
    await writeSampleImport(tx, id, row.payload);
    await rebuildSampleMetrics(tx, id);
    await tx.query(
      "UPDATE imports SET status='published',created_at=now(),payload=NULL,expires_at=NULL WHERE id=$1",
      [id],
    );
    await tx.query(
      'UPDATE dataset_state SET revision=revision+1,updated_at=now() WHERE id=1',
    );
    return { added: row.summary.samples, alreadyCommitted: false };
  }
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
export const dashboard = (db, filters = {}) =>
  db.transaction(
    async (tx) => {
      if (!filters.demo) {
        const readiness = await checkSampleModelReadiness(tx);
        if (!readiness.ready) throw sampleModelNotReady();
      }
      return readDashboard(tx, filters);
    },
    { readOnly: true },
  );
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
