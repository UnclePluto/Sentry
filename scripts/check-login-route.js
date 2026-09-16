// 用 playwright-cli run-code 加载；提前打开待测后台登录页。
// 使用无效测试账号，只验证真实表单调用登录接口并显示凭据错误。
async () => {
  await page.getByRole('textbox', { name: '管理员账号', exact: true }).fill('route-probe');
  await page.getByRole('textbox', { name: '密码', exact: true }).fill('route-probe-invalid');
  const pending = page.waitForResponse(r => r.request().method() === 'POST');
  await page.getByRole('button', { name: '登录后台' }).click();
  const response = await pending;
  if (!response.url().endsWith('/admin/api/auth/login')) throw new Error('登录表单请求路径错误：' + response.url());
  if (response.status() !== 401) throw new Error('无效凭据应返回 401');
  const data = await response.json();
  if (data.error.includes('请先登录')) throw new Error('登录接口不应要求已有会话');
}
