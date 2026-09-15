// 固定本机数据服务，浏览器不能指定代理目标。
async function forward(request: Request) {
  const url = new URL(request.url);
  const target = new URL(url.pathname + url.search, 'http://127.0.0.1:3001');
  const headers = new Headers(request.headers);
  headers.delete('host');
  headers.delete('connection');
  try {
    const response = await fetch(target, {
      method: request.method,
      headers,
      body: request.method === 'GET' ? undefined : await request.arrayBuffer(),
      redirect: 'error',
    });
    // fetch 返回只读响应头，框架还需写入安全与缓存头，因此创建可修改的响应。
    return new Response(response.body, {
      status: response.status,
      headers: new Headers(response.headers),
    });
  } catch {
    return Response.json(
      { error: '本机数据服务尚未启动，请运行 npm run dev:all。' },
      { status: 503 },
    );
  }
}
export const GET = forward;
export const POST = forward;
