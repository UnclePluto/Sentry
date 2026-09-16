import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { summarize } from '../../server/parser.mjs';
export function openStore(dir) {
  mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(join(dir, 'sentry.sqlite'));
  db.exec(
    'PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;',
  );
  const schema = readFileSync(new URL('./sqlite-schema.sql', import.meta.url), 'utf8');
  const existing = db.prepare('PRAGMA table_info(imports)').all();
  if (
    existing.length &&
    db.prepare('PRAGMA user_version').get().user_version < 2
  ) {
    const backupDir = join(dir, 'backups');
    mkdirSync(backupDir, { recursive: true, mode: 0o700 });
    const backupFile = join(
      backupDir,
      `before-v2-${Date.now()}-${randomUUID()}.sqlite`,
    );
    db.prepare('VACUUM INTO ?').run(backupFile);
    chmodSync(backupFile, 0o600);
    const check = new DatabaseSync(backupFile, { readOnly: true });
    try {
      if (
        check.prepare('PRAGMA integrity_check').get().integrity_check !== 'ok'
      )
        throw new Error('升级前备份校验失败，已停止迁移。');
    } finally {
      check.close();
    }
  }

  if (
    db
      .prepare('PRAGMA table_info(imports)')
      .all()
      .some((c) => c.name === 'institution_id')
  ) {
    const legacy = db
      .prepare(
        'SELECT i.*,t.province_code,t.province,t.city_code,t.city,t.county_code,t.county FROM imports i JOIN institutions t ON t.id=i.institution_id',
      )
      .all();
    db.exec('PRAGMA foreign_keys=OFF; BEGIN IMMEDIATE;');
    try {
      db.exec('DROP VIEW IF EXISTS current_samples;');
      const definition = schema.match(
        /CREATE TABLE IF NOT EXISTS imports \([\s\S]*?\n\);/,
      )[0];
      db.exec(definition.replace('IF NOT EXISTS imports', 'imports_next'));
      const insert = db.prepare(
        `INSERT INTO imports_next(id,file_name,sha256,province_code,province,city_code,city,county_code,county,submitted_name,report_date,created_at,status,source_sheet,warnings,payload,summary,withdrawn_at,withdrawn_name,demo) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      );
      for (const row of legacy) {
        const payload = JSON.parse(row.payload);
        insert.run(
          row.id,
          row.file_name,
          row.sha256,
          row.province_code,
          row.province,
          row.city_code,
          row.city,
          row.county_code,
          row.county,
          row.demo ? '系统演示' : '历史提交（归属未知）',
          row.report_date,
          row.created_at,
          row.demo ? row.status : 'withdrawn',
          row.source_sheet,
          row.warnings,
          row.payload,
          JSON.stringify(payload.summary || {}),
          row.demo ? null : new Date().toISOString(),
          row.demo ? null : '系统迁移：旧记录未保存提交人',
          row.demo,
        );
      }
      db.exec(
        'DROP TABLE imports; ALTER TABLE imports_next RENAME TO imports; COMMIT;',
      );
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    } finally {
      db.exec('PRAGMA foreign_keys=ON;');
    }
  }
  db.exec(schema);
  if (db.prepare('PRAGMA user_version').get().user_version < 2) {
    db.exec('BEGIN IMMEDIATE');
    try {
      for (const row of db.prepare('SELECT * FROM imports').all()) {
        const payload = JSON.parse(row.payload);
        const original = payload.records;
        payload.records = original.filter(
          (r) =>
            r.code !== 'N' &&
            r.raw !== '-' &&
            r.raw !== '—' &&
            r.status !== 'untested',
        );
        payload.summary = {
          ...summarize(payload.records),
          excluded:
            (payload.summary?.excluded || 0) +
            original.length -
            payload.records.length,
        };
        const cityCode = ['110000', '120000', '310000', '500000'].includes(
          row.province_code,
        )
          ? row.province_code
          : row.city_code;
        db.prepare(
          'UPDATE imports SET payload=?,summary=?,city_code=? WHERE id=?',
        ).run(
          JSON.stringify(payload),
          JSON.stringify(payload.summary),
          cityCode,
          row.id,
        );
      }
      db.exec(
        "DELETE FROM results WHERE pathogen_code='N' OR status='untested' OR raw_value IN ('-','—'); DELETE FROM samples WHERE NOT EXISTS (SELECT 1 FROM results r WHERE r.sample_id=samples.id); UPDATE imports SET county_code='',county='' WHERE demo=1 AND CAST(substr(report_date,6,2) AS INTEGER)%3=1; DROP TABLE IF EXISTS institutions; PRAGMA user_version=2;",
      );
      if (db.prepare('PRAGMA foreign_key_check').all().length)
        throw new Error('迁移完整性检查失败。');
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }
  return db;
}
export function publish(db, id) {
  const row = db.prepare('SELECT * FROM imports WHERE id=?').get(id);
  if (row?.status === 'published')
    return { added: JSON.parse(row.summary).samples, alreadyCommitted: true };
  if (!row || row.status !== 'staged')
    throw new Error('该预览不存在或已作废，请重新解析。');
  const payload = JSON.parse(row.payload);
  db.exec('BEGIN IMMEDIATE');
  try {
    const insertSample = db.prepare(
      'INSERT INTO samples(import_id,batch,sample_code) VALUES(?,?,?)',
    );
    const insertResult = db.prepare(
      'INSERT INTO results(sample_id,pathogen_code,status,ct,raw_value,raw_name,source_row) VALUES(?,?,?,?,?,?,?)',
    );
    for (const [code, name] of Object.entries(payload.names))
      db.prepare(
        'INSERT INTO pathogens(code,name) VALUES(?,?) ON CONFLICT(code) DO NOTHING',
      ).run(code, name);
    for (const records of Map.groupBy(payload.records, (r) =>
      JSON.stringify([r.batch, r.sample]),
    ).values()) {
      const r = records[0];
      const sample = insertSample.run(id, r.batch, r.sample).lastInsertRowid;
      for (const result of records)
        insertResult.run(
          sample,
          result.code,
          result.status,
          result.ct,
          result.raw,
          result.name,
          result.sourceRow,
        );
    }
    db.prepare(
      "UPDATE imports SET status='published',created_at=? WHERE id=?",
    ).run(new Date().toISOString(), id);
    db.exec('COMMIT');
    return { added: payload.summary.samples, alreadyCommitted: false };
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}
export function stage(
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
  const area = location;
  db.prepare(
    `INSERT INTO imports(id,file_name,sha256,province_code,province,city_code,city,county_code,county,submitted_by,submitted_name,submitted_username,report_date,created_at,status,source_sheet,warnings,payload,summary,demo) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    id,
    fileName,
    hash,
    area.province_code,
    area.province,
    area.city_code,
    area.city,
    area.county_code || '',
    area.county || '',
    user?.id || null,
    user?.display_name ||
      user?.displayName ||
      (demo ? '系统演示' : '历史提交（归属未知）'),
    user?.username || '',
    date,
    new Date().toISOString(),
    'staged',
    payload.sheet,
    JSON.stringify(payload.warnings),
    JSON.stringify(payload),
    JSON.stringify(payload.summary),
    demo,
  );
  return id;
}
export function dashboard(
  db,
  { demo = false, from = '', to = '', region = '', pathogen = '' } = {},
) {
  let sql = `SELECT c.*,r.pathogen_code,r.status,r.ct,p.name pathogen_name FROM current_samples c JOIN results r ON r.sample_id=c.id JOIN pathogens p ON p.code=r.pathogen_code WHERE c.demo=? AND r.pathogen_code!='N' AND r.status!='untested'`;
  const params = [demo ? 1 : 0];
  if (from) {
    sql += ' AND c.report_date>=?';
    params.push(from);
  }
  if (to) {
    sql += ' AND c.report_date<=?';
    params.push(to);
  }
  if (region && region !== '100000') {
    sql += ' AND (c.province_code=? OR c.city_code=? OR c.county_code=?)';
    params.push(region, region, region);
    if (
      !region.endsWith('0000') ||
      ['110000', '120000', '310000', '500000'].includes(region)
    )
      sql += " AND c.county_code!=''";
  }
  const rows = db.prepare(sql).all(...params);
  const allGroups = Map.groupBy(rows, (r) => r.id);
  const groups = new Map(
    [...allGroups]
      .map(([id, rs]) => [
        id,
        pathogen ? rs.filter((r) => r.pathogen_code === pathogen) : rs,
      ])
      .filter(([, rs]) => rs.length),
  );
  const sampleList = [...groups.values()].map((rs) => ({
    ...rs[0],
    positive: rs.some((r) => r.status === 'positive'),
    tested: rs.some((r) => r.status !== 'untested'),
  }));
  const stats = (list) => {
    const tested = list.filter((s) => s.tested).length;
    const positive = list.filter((s) => s.positive).length;
    return {
      samples: list.length,
      tested,
      positive,
      untested: list.length - tested,
      rate: tested ? positive / tested : null,
    };
  };
  const metrics = stats(sampleList);
  const missingPanel = [...allGroups.values()].filter((rs) =>
    rs.some((r) => r.pathogen_code === 'N' && r.status === 'negative'),
  ).length;
  const ranking = [
    ...Map.groupBy(
      rows.filter((r) => r.pathogen_code !== 'N'),
      (r) => r.pathogen_code,
    ),
  ]
    .map(([code, rs]) => {
      const positive = rs.filter((r) => r.status === 'positive').length,
        tested = rs.filter((r) => r.status !== 'untested').length;
      return {
        code,
        name: rs[0].pathogen_name,
        positive,
        tested,
        rate: missingPanel || !tested ? null : positive / tested,
      };
    })
    .sort((a, b) => b.positive - a.positive);
  const aggregate = (key) =>
    [...Map.groupBy(sampleList, (r) => r[key])]
      .filter(([code]) => code)
      .map(([code, rs]) => ({
        code,
        ...stats(rs),
        ...(pathogen && missingPanel ? { rate: null } : {}),
        name: rs[0][key.replace('_code', '')],
      }));
  const trend = [...Map.groupBy(sampleList, (r) => r.report_date.slice(0, 7))]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([month, rs]) => ({
      month,
      ...stats(rs),
      ...(pathogen && missingPanel ? { rate: null } : {}),
    }));
  const co = new Map();
  for (const rs of allGroups.values()) {
    const codes = [
      ...new Set(
        rs.filter((r) => r.status === 'positive').map((r) => r.pathogen_code),
      ),
    ].sort((a, b) => a.localeCompare(b));
    if (pathogen && !codes.includes(pathogen)) continue;
    for (let i = 0; i < codes.length; i++)
      for (let j = i + 1; j < codes.length; j++) {
        const key = codes[i] + '|' + codes[j];
        co.set(key, (co.get(key) || 0) + 1);
      }
  }
  const heatmap = [
    ...Map.groupBy(
      rows.filter((r) => r.status === 'positive' && r.pathogen_code !== 'N'),
      (r) => r.pathogen_code + '|' + r.report_date.slice(0, 7),
    ),
  ].map(([key, rs]) => {
    const [code, month] = key.split('|');
    return { code, month, count: rs.length };
  });
  const extent = db
    .prepare(
      'SELECT MIN(report_date) earliest,MAX(report_date) latest,COUNT(*) count FROM current_samples WHERE demo=?',
    )
    .get(demo ? 1 : 0);
  return {
    metrics: {
      ...metrics,
      rate: pathogen && missingPanel ? null : metrics.rate,
      submissions: new Set(sampleList.map((r) => r.import_id)).size,
      pathogens: ranking.filter((r) => r.positive).length,
    },
    extent,
    ranking,
    trend,
    heatmap,
    cooccurrence: [...co]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6)
      .map(([pair, count]) => ({
        pair: pair
          .split('|')
          .map((code) => ranking.find((r) => r.code === code)?.name || code),
        count,
      })),
    regions: {
      province: aggregate('province_code'),
      city: aggregate('city_code'),
      county: aggregate('county_code'),
    },
    missingPanel,
    updatedAt: db
      .prepare(
        "SELECT MAX(created_at) value FROM imports WHERE demo=? AND status='published'",
      )
      .get(demo ? 1 : 0).value,
  };
}
