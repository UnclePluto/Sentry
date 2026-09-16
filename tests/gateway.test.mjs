import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createGateway } from '../server/gateway.mjs';

test('展示入口只读且没有管理页面，管理入口保留上传请求', async () => {
  const renderer = http.createServer((req, res) => res.end(`page:${req.url}`));
  const backend = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    res.setHeader('Content-Type', 'application/json');
    res.end(
      JSON.stringify({
        method: req.method,
        path: req.url,
        body: Buffer.concat(chunks).toString(),
      }),
    );
  });
  const servers = [renderer, backend];
  const listen = (server) =>
    new Promise((resolve) =>
      server.listen(0, '127.0.0.1', () =>
        resolve(`http://127.0.0.1:${server.address().port}`),
      ),
    );
  try {
    const rendererOrigin = await listen(renderer),
      apiOrigin = await listen(backend);
    const dashboard = createGateway({
      mode: 'dashboard',
      rendererOrigin,
      apiOrigin,
    });
    const admin = createGateway({ mode: 'admin', rendererOrigin, apiOrigin });
    servers.push(dashboard, admin);
    const displayUrl = await listen(dashboard),
      adminUrl = await listen(admin);
    assert.equal(await (await fetch(displayUrl)).text(), 'page:/');
    for (const path of [
      '/upload',
      '/upload/',
      '/%75pload',
      '/api/imports',
      '/api/imports/download?id=x',
      '/api/records',
      '/api/institutions',
    ]) {
      assert.equal((await fetch(displayUrl + path)).status, 404, path);
    }
    assert.equal(
      (
        await fetch(displayUrl + '/api/imports/commit', {
          method: 'POST',
          body: '{}',
        })
      ).status,
      405,
    );
    assert.equal(
      (await fetch(displayUrl + '/api/dashboard', { method: 'POST' })).status,
      405,
    );
    const data = await (
      await fetch(displayUrl + '/api/dashboard?demo=1')
    ).json();
    assert.equal(data.path, '/api/dashboard?demo=1');
    assert.equal(data.method, 'GET');
    assert.equal(
      await (await fetch(displayUrl + '/assets/main.js')).text(),
      'page:/assets/main.js',
    );
    const redirect = await fetch(adminUrl, { redirect: 'manual' });
    assert.equal(redirect.headers.get('location'), '/admin/upload');
    assert.equal(
      await (await fetch(adminUrl + '/upload')).text(),
      'page:/upload',
    );
    assert.equal(
      await (await fetch(adminUrl + '/admin/login')).text(),
      'page:/admin/login',
    );
    assert.equal((await fetch(displayUrl + '/admin/login')).status, 404);
    const prefixedUpload = await (
      await fetch(adminUrl + '/admin/api/imports/preview?filename=x.xlsx', {
        method: 'POST',
        body: 'excel-bytes',
      })
    ).json();
    assert.equal(prefixedUpload.path, '/api/imports/preview?filename=x.xlsx');
    assert.equal(prefixedUpload.body, 'excel-bytes');
    const upload = await (
      await fetch(adminUrl + '/api/imports/preview?filename=test.xlsx', {
        method: 'POST',
        body: 'excel-bytes',
      })
    ).json();
    assert.equal(upload.body, 'excel-bytes');
    assert.equal(upload.method, 'POST');
  } finally {
    for (const server of servers) {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  }
});
