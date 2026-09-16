export async function api<T = unknown>(
  path: string,
  options?: RequestInit,
): Promise<T> {
  const response = await fetch(
    (typeof window !== 'undefined' &&
    window.location.pathname.startsWith('/admin/')
      ? '/admin/api'
      : '/api') + path,
    options,
  );
  if (
    response.status === 401 &&
    typeof window !== 'undefined' &&
    ['/upload', '/accounts', '/admin/upload', '/admin/accounts'].includes(
      window.location.pathname,
    )
  )
    window.location.replace('/admin/login');
  const data: unknown = await response.json();
  if (!response.ok)
    throw new Error(
      typeof data === 'object' && data !== null && 'error' in data
        ? String(data.error)
        : '请求失败，请重试。',
    );
  return data as T;
}
export const post = <T = unknown>(path: string, data: unknown) =>
  api<T>(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
export const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : '请求失败，请重试。';
export const percent = (value: number | null | undefined) =>
  value == null ? '—' : (value * 100).toFixed(1) + '%';
export const number = (value: number | undefined) =>
  (value ?? 0).toLocaleString('zh-CN');
