import { createServer } from 'node:http';
import { readFile, writeFile, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { Worker } from 'node:worker_threads';
import { openStore, stage, publish, dashboard } from './store.mjs';
import { seedDemo } from './demo.mjs';
import { createAuth } from './auth.mjs';
const dataDir = resolve(process.env.SENTRY_DATA_DIR || 'data');
const db = openStore(dataDir);
// 升级与备份核对完成后，只清理已有结构化提交所对应的旧原附件。
for (const { id } of db.prepare('SELECT id FROM imports').all()) {
  if (!/^[a-zA-Z0-9-]+$/.test(id)) continue;
  await unlink(join(dataDir, 'uploads', `${id}.xlsx`)).catch((e) => {
    if (e.code !== 'ENOENT') throw e;
  });
}
const auth = await createAuth(db, dataDir);
if (process.env.SENTRY_NO_DEMO !== '1') seedDemo(db);
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
function parse(bytes) {
  return new Promise((resolve, reject) => {
    const w = new Worker(new URL('./parse-worker.mjs', import.meta.url), {
      workerData: bytes,
      resourceLimits: { maxOldGenerationSizeMb: 192 },
    });
    const timeout = setTimeout(() => {
      w.terminate();
      reject(new Error('文件解析超时，请减少工作表内容后重试。'));
    }, 25000);
    w.once('message', (result) => {
      clearTimeout(timeout);
      w.terminate();
      if (result.error) reject(new Error(result.error));
      else resolve(result.data);
    });
    w.once('error', () => {
      clearTimeout(timeout);
      reject(new Error('文件过大或格式异常，无法解析。'));
    });
  });
}
const allowedCodes = new Set(['100000']);
async function geo(code) {
  if (!/^\d{6}$/.test(code)) throw new Error('行政区代码无效。');
  const path = join('public/maps', `${code}.json`);
  let data;
  try {
    data = JSON.parse(await readFile(path, 'utf8'));
  } catch {
    for (const parent of new Set([
      code.slice(0, 4) + '00',
      code.slice(0, 2) + '0000',
      '100000',
    ])) {
      if (parent === code) continue;
      try {
        const parentData = JSON.parse(
          await readFile(join('public/maps', `${parent}.json`), 'utf8'),
        );
        const feature = parentData.features.find(
          (f) => String(f.properties.adcode) === code,
        );
        if (feature) {
          return { type: 'FeatureCollection', features: [feature] };
        }
      } catch {}
    }
    if (!allowedCodes.has(code)) throw new Error('请从上一级地图选择区域。');
    try {
      const response = await fetch(
        `https://geo.datav.aliyun.com/areas_v3/bound/${code}_full.json`,
        { signal: AbortSignal.timeout(12000) },
      );
      if (!response.ok) throw new Error();
      data = await response.json();
      if (data.type !== 'FeatureCollection') throw new Error();
      await writeFile(path, JSON.stringify(data));
    } catch {
      throw new Error(
        '该区域的离线边界尚未下载，请联网后重试，或运行 npm run maps。',
      );
    }
  }
  for (const f of data.features)
    if (f.properties.adcode) allowedCodes.add(String(f.properties.adcode));
  return data;
}
async function resolveLocation(x) {
  const find = (data, code, level) =>
    data.features.find(
      (f) =>
        String(f.properties.adcode) === code && f.properties.level === level,
    )?.properties;
  const province = find(await geo('100000'), x.province_code, 'province');
  if (!province) throw new Error('请选择有效的省份。');
  const cities = await geo(x.province_code);
  const direct = ['110000', '120000', '310000', '500000'].includes(
    x.province_code,
  );
  const city =
    direct && x.city_code === x.province_code
      ? province
      : find(cities, x.city_code, 'city');
  if (!city) throw new Error('请选择该省下有效的城市。');
  let county;
  if (x.county_code) {
    county = find(await geo(x.city_code), x.county_code, 'district');
    if (!county) throw new Error('请选择该市下有效的区县。');
  }
  return {
    province_code: x.province_code,
    province: province.name,
    city_code: x.city_code,
    city: city.name,
    county_code: x.county_code || '',
    county: county?.name || '',
  };
}
await geo('100000');
const server = createServer(async (req, res) => {
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
    if (req.method === 'GET' && p === '/api/health')
      return json(res, { ok: true, database: 'sqlite' });
    if (req.method === 'GET' && p === '/api/dashboard') {
      const filters = Object.fromEntries(url.searchParams);
      if (
        (filters.from && !dateValid(filters.from)) ||
        (filters.to && !dateValid(filters.to))
      )
        throw new Error('日期无效。');
      return json(
        res,
        dashboard(db, { ...filters, demo: filters.demo === '1' }),
      );
    }
    if (req.method === 'GET' && p === '/api/geo')
      return json(res, await geo(url.searchParams.get('code') || '100000'));
    const user = auth.current(req);
    if (!user) return json(res, { error: '请先登录管理员账号。' }, 401);
    const owned = (id) => {
      if (typeof id !== 'string') throw new Error('上传批次号无效。');
      const row = db
        .prepare('SELECT * FROM imports WHERE id=? AND demo=0')
        .get(id);
      if (!row || (user.role !== 'superadmin' && row.submitted_by !== user.id))
        throw Object.assign(new Error('提交不存在或无权操作。'), {
          status: 404,
        });
      return row;
    };
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
      const payload = await parse(bytes);
      const id = randomUUID();
      stage(db, { id, fileName, hash, location, date, payload, user });
      return json(
        res,
        {
          id,
          sheet: payload.sheet,
          warnings: payload.warnings,
          summary: payload.summary,
          location,
          date,
        },
        201,
      );
    }
    if (req.method === 'POST' && p === '/api/imports/commit') {
      const x = JSON.parse(await body(req, 1000));
      owned(x.id);
      return json(res, publish(db, x.id));
    }
    if (req.method === 'POST' && p === '/api/imports/withdraw') {
      const x = JSON.parse(await body(req, 1000));
      const row = owned(x.id);
      if (row.status === 'staged') throw new Error('尚未提交的数据不能作废。');
      if (row.status === 'published')
        db.prepare(
          "UPDATE imports SET status='withdrawn',withdrawn_at=?,withdrawn_by=?,withdrawn_name=? WHERE id=? AND status='published'",
        ).run(
          new Date().toISOString(),
          user.id,
          `${user.display_name}（${user.username}）`,
          x.id,
        );
      return json(res, { ok: true });
    }
    if (req.method === 'GET' && p === '/api/imports') {
      const rows = db
        .prepare(
          `SELECT id,file_name,province,city,county,report_date,created_at,status,submitted_name,submitted_username,summary,withdrawn_at,withdrawn_name FROM imports WHERE demo=0 AND status!='staged' ${user.role === 'superadmin' ? '' : 'AND submitted_by=?'} ORDER BY created_at DESC,id DESC`,
        )
        .all(...(user.role === 'superadmin' ? [] : [user.id]));
      return json(
        res,
        rows.map((row) => ({ ...row, summary: JSON.parse(row.summary) })),
      );
    }
    return json(res, { error: '接口不存在' }, 404);
  } catch (error) {
    const message = error.message?.includes('UNIQUE constraint')
      ? '该机构或记录已存在。'
      : error.message || '处理失败，请重试。';
    json(res, { error: message }, error.status || 400);
  }
});
server.listen(port, '127.0.0.1', () =>
  console.log(`SENTRY 数据服务 http://127.0.0.1:${server.address().port}`),
);
for (const signal of ['SIGINT', 'SIGTERM'])
  process.on(signal, () =>
    server.close(() => {
      db.close();
      process.exit(0);
    }),
  );
