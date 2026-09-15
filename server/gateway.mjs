import http from 'node:http';
import { pathToFileURL } from 'node:url';

const readEndpoints = new Set(['/api/dashboard', '/api/geo', '/api/health']);
const assets =
  /^(?:\/_next\/|\/assets\/|\/maps\/|\/@vite\/|\/@id\/|\/@fs\/|\/node_modules\/|\/app\/|\/components\/|\/lib\/|\/@react-refresh$|\/favicon\.svg$)/;
const hopHeaders = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

function cleanHeaders(headers) {
  const omitted = new Set([
    ...hopHeaders,
    ...(headers.connection || '').split(',').map((s) => s.trim().toLowerCase()),
  ]);
  return Object.fromEntries(
    Object.entries(headers).filter(([key]) => !omitted.has(key.toLowerCase())),
  );
}

/** 展示与管理使用独立入口；共用内部渲染服务和数据库。 */
export function createGateway({
  mode,
  rendererOrigin = 'http://127.0.0.1:3010',
  apiOrigin = 'http://127.0.0.1:3001',
  development = false,
}) {
  const server = http.createServer(async (req, res) => {
    let path;
    try {
      path =
        decodeURIComponent(
          new URL(req.url, 'http://localhost').pathname,
        ).replace(/\/$/, '') || '/';
    } catch {
      res.writeHead(400).end();
      return;
    }
    const isApi = path === '/api' || path.startsWith('/api/');
    if (mode === 'dashboard' && !['GET', 'HEAD'].includes(req.method)) {
      res.writeHead(405, { Allow: 'GET, HEAD' }).end();
      return;
    }
    if (mode === 'dashboard' && isApi && !readEndpoints.has(path)) {
      res.writeHead(404).end();
      return;
    }
    if (mode === 'admin' && path === '/') {
      res.writeHead(302, { Location: '/upload' }).end();
      return;
    }
    const validPage =
      mode === 'dashboard'
        ? path === '/'
        : ['/upload', '/accounts', '/login'].includes(path);
    const validAsset =
      assets.test(path) &&
      (development ||
        /^\/(?:_next\/|assets\/|maps\/|favicon\.svg$)/.test(path));
    if (!isApi && !validPage && !validAsset) {
      res
        .writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
        .end('此入口没有该页面');
      return;
    }
    if (mode === 'admin' && ['/upload', '/accounts'].includes(path)) {
      try {
        const session = await fetch(apiOrigin + '/api/auth/me', {
          headers: { cookie: req.headers.cookie || '' },
          signal: AbortSignal.timeout(4000),
        });
        if (session.status === 401) {
          res
            .writeHead(302, { Location: '/login', 'Cache-Control': 'no-store' })
            .end();
          return;
        }
        if (!session.ok) {
          res.writeHead(503).end('登录服务暂时不可用');
          return;
        }
        const user = await session.json();
        if (path === '/accounts' && user.role !== 'superadmin') {
          res
            .writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' })
            .end('仅超级管理员可管理账号');
          return;
        }
      } catch {
        res.writeHead(503).end('登录服务暂时不可用');
        return;
      }
    }
    const target = new URL(isApi ? apiOrigin : rendererOrigin);
    const upstream = http.request(
      {
        hostname: target.hostname,
        port: target.port,
        method: req.method,
        path: req.url,
        headers: { ...cleanHeaders(req.headers), host: target.host },
      },
      (response) => {
        res.writeHead(
          response.statusCode || 502,
          cleanHeaders(response.headers),
        );
        response.pipe(res);
      },
    );
    upstream.on('error', () => {
      if (!res.headersSent) res.writeHead(502);
      res.end('本地服务正在启动，请稍后刷新');
    });
    req.on('aborted', () => upstream.destroy());
    res.on('close', () => upstream.destroy());
    req.pipe(upstream);
  });
  // 本机开发期间转发 Vite 热更新连接，生产入口不开放 WebSocket。
  server.on('upgrade', (req, socket, head) => {
    if (
      !development ||
      !String(req.headers['sec-websocket-protocol'] || '')
        .split(',')
        .map((s) => s.trim())
        .includes('vite-hmr')
    ) {
      socket.destroy();
      return;
    }
    const target = new URL(rendererOrigin);
    const upstream = http.request({
      hostname: target.hostname,
      port: target.port,
      path: req.url,
      headers: { ...req.headers, host: target.host },
    });
    upstream.on('upgrade', (response, remote, remoteHead) => {
      socket.write(
        `HTTP/1.1 101 Switching Protocols\r\n${Object.entries(response.headers)
          .map(([k, v]) => `${k}: ${v}`)
          .join('\r\n')}\r\n\r\n`,
      );
      if (head.length) remote.write(head);
      if (remoteHead.length) socket.write(remoteHead);
      socket.on('error', () => remote.destroy());
      remote.on('error', () => socket.destroy());
      socket.on('close', () => remote.destroy());
      remote.on('close', () => socket.destroy());
      socket.pipe(remote).pipe(socket);
    });
    upstream.on('response', () => socket.destroy());
    upstream.on('error', () => socket.destroy());
    upstream.end();
  });
  return server;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const development = !process.argv.includes('--production');
  const host = process.env.SENTRY_GATEWAY_HOST || '127.0.0.1';
  for (const [mode, port] of [
    ['dashboard', 3000],
    ['admin', 3002],
  ]) {
    const server = createGateway({ mode, development });
    server.on('error', (error) => {
      console.error(error.message);
      process.exit(1);
    });
    server.listen(port, host, () =>
      console.log(
        `${mode === 'dashboard' ? '监测大屏' : '数据管理'}：http://${host}:${port}`,
      ),
    );
  }
}
