import { DatabaseSync, backup } from 'node:sqlite';
import { mkdir, chmod, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { connectDatabase, migrate } from '../../server/database.mjs';
import {
  openStore as upgradeSnapshot,
  dashboard as legacyDashboard,
} from '../legacy/sqlite-store.mjs';
import { rebuildContribution, dashboard } from '../../server/store.mjs';
const args = Object.fromEntries(
  process.argv
    .slice(2)
    .map((v, i, a) => (v.startsWith('--') ? [v.slice(2), a[i + 1]] : null))
    .filter(Boolean),
);
if (!args.source || !args['snapshot-dir'])
  throw Error('必须指定 --source 旧库路径 --snapshot-dir 私有快照目录');
const snapshotDir = resolve(args['snapshot-dir'], 'migration-' + randomUUID());
await mkdir(snapshotDir, { recursive: true, mode: 0o700 });
const original = new DatabaseSync(resolve(args.source), { readOnly: true });
try {
  if (original.prepare('PRAGMA integrity_check').get().integrity_check !== 'ok')
    throw Error('源数据库完整性失败');
  await backup(original, join(snapshotDir, 'source.sqlite'));
} finally {
  original.close();
}
await chmod(join(snapshotDir, 'source.sqlite'), 0o600);
const sourceCopy = new DatabaseSync(join(snapshotDir, 'source.sqlite'), {
  readOnly: true,
});
try {
  await backup(sourceCopy, join(snapshotDir, 'sentry.sqlite'));
} finally {
  sourceCopy.close();
}
await chmod(join(snapshotDir, 'sentry.sqlite'), 0o600);
const source = upgradeSnapshot(snapshotDir),
  db = connectDatabase(
    process.env.MIGRATION_DATABASE_URL || process.env.DATABASE_URL,
  );
const report = {
  event: 'sqlite_migration',
  snapshot: snapshotDir,
  counts: {},
  comparisons: [],
  status: 'running',
};
const tables = [
  'admin_users',
  'admin_sessions',
  'admin_login_attempts',
  'pathogens',
  'imports',
  'samples',
  'results',
];
try {
  await migrate(db);
  await db.transaction(async (tx) => {
    await tx.query('SELECT pg_advisory_xact_lock(78230403)');
    for (const table of tables)
      if ((await tx.get(`SELECT count(*) n FROM ${table}`)).n)
        throw Error('迁移目标必须为空，禁止覆盖现有业务库');
    for (const table of tables) {
      const exists = source
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?")
        .get(table);
      if (!exists) {
        report.counts[table] = 0;
        continue;
      }
      const columns = source
        .prepare(`PRAGMA table_info(${table})`)
        .all()
        .map((r) => r.name)
        .filter((c) => c !== 'institution_id');
      const allowed = (
        await tx.all(
          "SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name=$1",
          table,
        )
      ).map((r) => r.column_name);
      const cols = columns.filter((c) => allowed.includes(c));
      let offset = 0;
      while (true) {
        const rows = source
          .prepare(`SELECT * FROM ${table} ORDER BY rowid LIMIT 500 OFFSET ?`)
          .all(offset);
        if (!rows.length) break;
        for (const row of rows) {
          if (table === 'imports' && row.status !== 'staged')
            row.payload = null;
          await tx.query(
            `INSERT INTO ${table}(${cols.join(',')}) VALUES(${cols.map((_, i) => '$' + (i + 1)).join(',')})`,
            cols.map((c) => row[c]),
          );
        }
        offset += rows.length;
      }
      report.counts[table] = offset;
      if ((await tx.get(`SELECT count(*) n FROM ${table}`)).n !== offset)
        throw Error('数据行数核对失败：' + table);
    }
    for (const table of ['samples', 'results'])
      await tx.query(
        `SELECT setval(pg_get_serial_sequence('${table}','id'),coalesce((SELECT max(id) FROM ${table}),1),EXISTS(SELECT 1 FROM ${table}))`,
      );
    for (const row of await tx.all(
      'SELECT id,status,submitted_by,created_at,payload FROM imports',
    )) {
      if (['published', 'withdrawn'].includes(row.status))
        await rebuildContribution(tx, row.id);
      if (row.status === 'staged') {
        if (
          row.submitted_by &&
          row.payload &&
          Date.now() - new Date(row.created_at).getTime() < 7 * 86400000
        ) {
          await tx.query(
            "UPDATE imports SET expires_at=created_at+interval '7 days' WHERE id=$1",
            [row.id],
          );
          await tx.query(
            "INSERT INTO jobs(id,import_id,owner_id,status) VALUES($1,$1,$2,'ready')",
            [row.id, row.submitted_by],
          );
        } else
          await tx.query(
            "UPDATE imports SET status='expired',payload=NULL WHERE id=$1",
            [row.id],
          );
      }
    }
    await tx.query(
      'UPDATE dataset_state SET revision=revision+1,updated_at=now(),maintenance=true WHERE id=1',
    );
  });
  const filters = [
    {},
    { demo: true },
    ...source
      .prepare(
        "SELECT DISTINCT province_code region FROM imports UNION SELECT DISTINCT city_code FROM imports UNION SELECT DISTINCT county_code FROM imports WHERE county_code<>''",
      )
      .all(),
    ...source
      .prepare(
        "SELECT DISTINCT report_date AS 'from',report_date AS 'to' FROM imports",
      )
      .all(),
    ...source
      .prepare(
        "SELECT DISTINCT pathogen_code pathogen FROM results WHERE pathogen_code<>'N'",
      )
      .all(),
  ];
  const normalize = (value) =>
    Array.isArray(value)
      ? value
          .map(normalize)
          .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
      : value && typeof value === 'object'
        ? Object.fromEntries(
            Object.entries(value)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([k, v]) => [k, normalize(v)]),
          )
        : value;
  for (const filter of filters) {
    const before = legacyDashboard(source, filter),
      after = await dashboard(db, filter);
    for (const key of [
      'metrics',
      'extent',
      'ranking',
      'trend',
      'heatmap',
      'regions',
    ])
      if (
        JSON.stringify(normalize(before[key])) !==
        JSON.stringify(normalize(after[key]))
      )
        throw Error('统计核对失败：' + key + ' ' + JSON.stringify(filter));
    report.comparisons.push(filter);
  }
  report.status = 'verified';
  console.log(
    JSON.stringify({
      event: report.event,
      status: report.status,
      counts: report.counts,
      comparisons: report.comparisons.length,
    }),
  );
} catch (e) {
  report.status = 'failed';
  report.error = e.message;
  throw e;
} finally {
  await writeFile(
    join(snapshotDir, 'report.json'),
    JSON.stringify(report, null, 2),
    { mode: 0o600 },
  );
  source.close();
  await db.close();
}
