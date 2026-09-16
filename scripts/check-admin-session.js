// 用 playwright-cli run-code 加载；提前用超管登录后台。
async () => {
  await page.getByRole('link', { name: '管理员账号', exact: true }).waitFor();
  await page.getByText('超级管理员', { exact: true }).first().waitFor();
  await page.getByRole('link', { name: '管理员账号', exact: true }).click();
  await page.waitForURL('**/admin/accounts');
  await page.getByRole('link', { name: '数据管理', exact: true }).click();
  await page.waitForURL('**/admin/upload');
  await page.getByRole('button', { name: '退出登录', exact: true }).click();
  await page.waitForURL('**/admin/login');
}
