import ExcelJS from 'exceljs';
import { testDatabase } from './postgres.mjs';
import { spawn, execFile } from 'node:child_process';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
import { mkdir } from 'node:fs/promises';

const district = {
  province_code: '420000',
  city_code: '420100',
  county_code: '420106',
};
export async function workbook(rows, name = 'Sheet1') {
  const book = new ExcelJS.Workbook();
  const s = book.addWorksheet(name);
  s.addRow(['batch', 'sam', 'PathogenWithReads', 'CT value', '中文']);
  rows.forEach((r) => s.addRow(r));
  const other = book.addWorksheet('Sheet3');
  other.addRow(['batch', 'sam', 'PathogenWithReads', 'CT value']);
  other.addRow(['WRONG', 'WRONG', 'WRONG', '非法']);
  return Buffer.from(await book.xlsx.writeBuffer());
}
export const validRows = [
  ['B', 'A', 'IAV', 25, '甲型流感'],
  ['B', 'A', 'RSV', 30, '合胞病毒'],
  ['B', 'B', 'IAV', '阴性', '甲型流感'],
];
export async function fixture(t, { legacy = false, demo = false } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'sentry-submissions-'));
  const pg = await testDatabase();
  let worker;
  let child,
    cookie = '';
  let port;
  if (legacy) {
    const old = new DatabaseSync(join(dir, 'sentry.sqlite'));
    old.exec(
      await readFile(
        new URL('../fixtures/legacy-schema.sql', import.meta.url),
        'utf8',
      ),
    );
    old
      .prepare(
        'INSERT INTO institutions(id,name,province_code,province,city_code,city,county_code,county,longitude,latitude) VALUES(?,?,?,?,?,?,?,?,?,?)',
      )
      .run(
        'old-place',
        '历史点位',
        '420000',
        '湖北省',
        '420100',
        '武汉市',
        '420106',
        '武昌区',
        114.3,
        30.5,
      );
    const records = [
      {
        batch: 'B',
        sample: 'A',
        code: 'IAV',
        name: '甲流',
        status: 'positive',
        ct: 25,
        raw: '25',
        sourceRow: 2,
      },
      {
        batch: 'B',
        sample: 'B',
        code: 'N',
        name: '',
        status: 'negative',
        ct: null,
        raw: '阴性',
        sourceRow: 3,
      },
    ];
    const payload = {
      sheet: 'Sheet1',
      records,
      names: { IAV: '甲流', N: '未指定' },
      warnings: [],
      summary: {
        rows: 2,
        samples: 2,
        tested: 2,
        positive: 1,
        untested: 0,
        rate: 0.5,
      },
    };
    old
      .prepare('INSERT INTO imports VALUES(?,?,?,?,?,?,?,?,?,?,?)')
      .run(
        'legacy',
        '旧文件.xlsx',
        'hash',
        'old-place',
        '2023-09-01',
        '2023-09-02T00:00:00.000Z',
        'published',
        'Sheet1',
        '[]',
        JSON.stringify(payload),
        0,
      );
    old
      .prepare('INSERT INTO samples VALUES(?,?,?,?)')
      .run(1, 'legacy', 'B', 'A');
    old
      .prepare('INSERT INTO samples VALUES(?,?,?,?)')
      .run(2, 'legacy', 'B', 'B');
    old.prepare('INSERT INTO pathogens VALUES(?,?)').run('IAV', '甲流');
    old.prepare('INSERT INTO pathogens VALUES(?,?)').run('N', '未指定');
    old
      .prepare('INSERT INTO results VALUES(?,?,?,?,?,?,?,?)')
      .run(1, 1, 'IAV', 'positive', 25, '25', '甲流', 2);
    old
      .prepare('INSERT INTO results VALUES(?,?,?,?,?,?,?,?)')
      .run(2, 2, 'N', 'negative', null, '阴性', '', 3);
    old.close();
    await mkdir(join(dir, 'uploads'));
    await promisify(execFile)(
      process.execPath,
      [
        'scripts/postgres/import-sqlite.mjs',
        '--source',
        join(dir, 'sentry.sqlite'),
        '--snapshot-dir',
        join(dir, 'snapshots'),
      ],
      { env: { ...process.env, DATABASE_URL: pg.url } },
    );
    await promisify(execFile)(
      process.execPath,
      ['scripts/postgres/maintenance.mjs', 'off'],
      { env: { ...process.env, DATABASE_URL: pg.url } },
    );
  }

  async function start() {
    child = spawn(process.execPath, ['server/index.mjs'], {
      env: {
        ...process.env,
        DATABASE_URL: pg.url,
        SENTRY_AUTO_MIGRATE: '1',
        API_PORT: '0',
        SENTRY_DATA_DIR: dir,
        SENTRY_NO_DEMO: demo ? '0' : '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let err = '';
    child.stderr.on('data', (d) => (err += d));
    await new Promise((resolve, reject) => {
      child.stdout.once('data', (data) => {
        port = Number(String(data).match(/:(\d+)/)?.[1]);
        resolve();
      });
      child.once('error', reject);
      child.once('exit', () => reject(new Error(err)));
    });
  }
  function startWorker() {
    worker = spawn(process.execPath, ['server/worker.mjs'], {
      env: { ...process.env, DATABASE_URL: pg.url, SENTRY_DATA_DIR: dir },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    worker.stderr.on('data', () => {});
  }
  async function stopWorker() {
    if (worker && worker.exitCode === null && worker.signalCode === null)
      await new Promise((r) => {
        worker.once('exit', r);
        worker.kill('SIGTERM');
      });
  }
  async function stop() {
    await stopWorker();
    if (child && child.exitCode === null && child.signalCode === null)
      await new Promise((r) => {
        child.once('exit', r);
        child.kill('SIGTERM');
      });
  }
  t.after(async () => {
    await stop();
    await rm(dir, { recursive: true, force: true });
    await pg.close();
  });
  const request = async (path, options = {}) => {
    const res = await fetch(`http://127.0.0.1:${port}/api` + path, {
      ...options,
      headers: { cookie, ...options.headers },
    });
    const data = await res.json();
    return {
      status: res.status,
      data,
      cookie: res.headers.get('set-cookie')?.split(';')[0],
    };
  };
  const post = (path, data) =>
    request(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
  await start();
  startWorker();
  const credentials = JSON.parse(
    await readFile(join(dir, 'initial-admin.json'), 'utf8'),
  );
  cookie = (await post('/auth/login', credentials)).cookie;
  const previewRaw = (bytes, extra = {}) =>
    request(
      '/imports/preview?' +
        new URLSearchParams({
          ...district,
          date: '2026-09-01',
          filename: '验收.xlsx',
          ...extra,
        }),
      { method: 'POST', body: bytes },
    );
  async function waitJob(
    id,
    terminal = ['ready', 'failed', 'cancelled', 'expired', 'succeeded'],
  ) {
    const until = Date.now() + 35000;
    while (Date.now() < until) {
      const r = await request('/jobs/' + id);
      if (r.status !== 200 || terminal.includes(r.data.status)) return r;
      await new Promise((r) => setTimeout(r, 80));
    }
    throw Error('任务等待超时');
  }
  async function preview(bytes, extra = {}) {
    const r = await previewRaw(bytes, extra);
    return r.status === 202 ? waitJob(r.data.id) : r;
  }
  async function commit(id) {
    const r = await post('/imports/commit', { id });
    return r.status === 202
      ? waitJob(id, ['succeeded', 'failed', 'expired'])
      : r;
  }
  return {
    dir,
    pg,
    previewRaw,
    waitJob,
    commit,
    startWorker,
    stopWorker,
    request,
    post,
    preview,
    start,
    stop,
    credentials,
    setCookie: (c) => (cookie = c),
    getCookie: () => cookie,
  };
}
