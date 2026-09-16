import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { geo, resolveLocation } from './geography.mjs';
import {
  enqueue,
  getJob,
  commitJob,
  cancelJob,
  retryJob,
  history,
} from './jobs.mjs';
import { openStore, withdraw, dashboard } from './store.mjs';
import { seedDemo } from './demo.mjs';
import { createAuth } from './auth.mjs';
const dataDir = resolve(process.env.SENTRY_DATA_DIR || 'data');
const db = await openStore(dataDir);
const auth = await createAuth(db, dataDir);
if (process.env.SENTRY_NO_DEMO !== '1') await seedDemo(db);
const port = Number(process.env.API_PORT || 3001);
const json = (res, value, status = 200) => {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(JSON.stringify(value));
};
async function body(req, max = 8 * 1024 * 1024) {
  let size = 0;
  const parts = [];
  for await (const c of req) {
    size += c.length;
    if (size > max) throw new Error('文件不能超过 8 MB。');
    parts.push(c);
  }
  return Buffer.concat(parts);
}
const dateValid = (v) =>
  /^\d{4}-\d{2}-\d{2}$/.test(v) &&
  !isNaN(Date.parse(v)) &&
  new Date(v).toISOString().slice(0, 10) === v;
await geo('100000');
const server = createServer(async (req, res) => {
  const requestId = randomUUID(),
    started = Date.now();
  res.setHeader('X-Request-Id', requestId);
  res.on('finish', () =>
    console.log(
      JSON.stringify({
        event: 'request',
        id: requestId,
        method: req.method,
        path: String(req.url).split('?')[0],
        status: res.statusCode,
        durationMs: Date.now() - started,
      }),
    ),
  );

  try {
    const url = new URL(req.url, 'http://localhost');
    const p = url.pathname;
    if (!p.startsWith('/api/')) return json(res, { error: '接口不存在' }, 404);
    // Cookie 会话的写操作只接受明确的管理端来源。
    const origin = req.headers.origin;
    const trustedOrigins = (
      process.env.SENTRY_TRUSTED_ORIGINS ||
      'http://127.0.0.1:3002,http://localhost:3002'
    ).split(',');
    if (
      !['GET', 'HEAD'].includes(req.method) &&
      ((origin && !trustedOrigins.includes(origin)) ||
        req.headers['sec-fetch-site'] === 'cross-site')
    )
      return json(res, { error: '来源不受信任' }, 403);
    if (await auth.handle(req, res, url, body, json)) return;
    if (req.method === 'GET' && p === '/api/health') {
      await db.query('SELECT 1');
      return json(res, { ok: true, database: 'postgresql' });
    }
    if (req.method === 'GET' && p === '/api/dashboard') {
      const filters = Object.fromEntries(url.searchParams);
      if (
        (filters.from && !dateValid(filters.from)) ||
        (filters.to && !dateValid(filters.to))
      )
        throw new Error('日期无效。');
      return json(
        res,
        await dashboard(db, { ...filters, demo: filters.demo === '1' }),
      );
    }
    if (req.method === 'GET' && p === '/api/geo')
      return json(res, await geo(url.searchParams.get('code') || '100000'));
    const user = await auth.current(req);
    if (!user) return json(res, { error: '请先登录管理员账号。' }, 401);
    if (req.method === 'POST' && p === '/api/imports/preview') {
      const location = await resolveLocation(
        Object.fromEntries(url.searchParams),
      );
      const date = url.searchParams.get('date'),
        fileName = (url.searchParams.get('filename') || '').slice(0, 200);
      if (!dateValid(date)) throw new Error('请选择有效的报告日期。');
      if (!fileName.toLowerCase().endsWith('.xlsx'))
        throw new Error('请上传 .xlsx 格式的 Excel。');
      const bytes = await body(req);
      const hash = createHash('sha256').update(bytes).digest('hex');
      return json(
        res,
        await enqueue(
          db,
          dataDir,
          { fileName, hash, location, date, user },
          bytes,
        ),
        202,
      );
    }
    if (req.method === 'GET' && p === '/api/jobs')
      return json(
        res,
        await history(db, user, {
          ...Object.fromEntries(url.searchParams),
          tasks: true,
        }),
      );
    const jobMatch = p.match(/^\/api\/jobs\/([a-f0-9-]+)$/);
    if (req.method === 'GET' && jobMatch)
      return json(res, await getJob(db, jobMatch[1], user));
    if (
      req.method === 'POST' &&
      [
        '/api/imports/commit',
        '/api/imports/withdraw',
        '/api/jobs/cancel',
        '/api/jobs/retry',
      ].includes(p)
    ) {
      const x = JSON.parse(await body(req, 1000));
      if (p === '/api/imports/commit')
        return json(res, await commitJob(db, x.id, user), 202);
      if (p === '/api/imports/withdraw')
        return json(res, await withdraw(db, x.id, user));
      if (p === '/api/jobs/cancel')
        return json(res, await cancelJob(db, dataDir, x.id, user));
      return json(res, await retryJob(db, x.id, user), 202);
    }
    if (req.method === 'GET' && p === '/api/imports')
      return json(
        res,
        await history(db, user, Object.fromEntries(url.searchParams)),
      );
    return json(res, { error: '接口不存在' }, 404);
  } catch (error) {
    const internal =
      Boolean(error.code) ||
      (!error.status &&
        !/请选择|请上传|无效|文件不能|不支持|该区域|上一级/.test(
          error.message,
        ));
    const status =
      error.status || (error.code === '23505' ? 409 : internal ? 500 : 400);
    console.error(
      JSON.stringify({
        event: 'request_failed',
        id: requestId,
        code: error.code || 'request_error',
        status,
      }),
    );
    json(
      res,
      {
        error: status >= 500 ? '服务暂时不可用，请稍后重试。' : error.message,
        requestId,
      },
      status,
    );
  }
});
server.listen(port, '127.0.0.1', () =>
  console.log(`SENTRY 数据服务 http://127.0.0.1:${server.address().port}`),
);
for (const signal of ['SIGINT', 'SIGTERM'])
  process.on(signal, () =>
    server.close(async () => {
      await db.close();
      process.exit(0);
    }),
  );
