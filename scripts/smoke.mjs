import assert from 'node:assert/strict';
const origin = process.env.SENTRY_ORIGIN || 'http://127.0.0.1:3000';
for (const path of [
  '/',
  '/api/health',
  '/api/dashboard?demo=1',
  '/api/dashboard?demo=0',
  '/api/geo?code=420000',
  '/api/geo?code=420100',
  '/api/geo?code=420106',
]) {
  const response = await fetch(origin + path);
  assert.equal(response.status, 200, `${path} 应正常响应`);
  if (path === '/api/health') assert.equal((await response.json()).ok, true);
  if (path.startsWith('/api/dashboard')) {
    const data = await response.json();
    assert.ok(typeof data.metrics.tested === 'number');
  }
  console.log(`${path} 200`);
}
const adminOrigin = process.env.SENTRY_ADMIN_ORIGIN || 'http://127.0.0.1:3002';
assert.equal(
  (await fetch(origin + '/upload')).status,
  404,
  '展示入口不能进入管理页面',
);
assert.equal(
  (await fetch(origin + '/api/records')).status,
  404,
  '展示入口不能读取样本明细',
);
assert.equal(
  (await fetch(origin + '/api/imports/commit', { method: 'POST', body: '{}' }))
    .status,
  405,
  '展示入口不能写入数据',
);
for (const path of ['/', '/login']) {
  assert.equal(
    (await fetch(adminOrigin + path)).status,
    200,
    `管理入口 ${path} 应正常响应`,
  );
  console.log(`管理入口 ${path} 200`);
}
for (const path of ['/upload', '/accounts']) {
  const response = await fetch(adminOrigin + path, { redirect: 'manual' });
  assert.equal(response.status, 302);
  assert.equal(response.headers.get('location'), '/login');
}
for (const path of ['/api/institutions', '/api/imports', '/api/admins'])
  assert.equal((await fetch(adminOrigin + path)).status, 401);
console.log('展示入口隔离、后台登录保护检查通过');
for (const [site, page] of [
  [origin, '/'],
  [adminOrigin, '/login'],
]) {
  const html = await (await fetch(site + page)).text();
  const resources = new Set(
    [
      ...html.matchAll(/(?:src|href)="([^"\s]+\.(?:js|css)(?:\?[^"\s]*)?)"/g),
    ].map((match) => match[1]),
  );
  assert.ok(resources.size > 0, `${page} 应包含前端资源`);
  for (const resource of resources) {
    const response = await fetch(new URL(resource, site));
    assert.equal(response.status, 200, `${resource} 应可加载`);
  }
  console.log(`${site}${page} 前端资源 ${resources.size} 项正常`);
}
