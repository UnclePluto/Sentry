// 用 playwright-cli run-code 加载；提前用超管登录隔离后台。
async () => {
  const origin=await page.evaluate(()=>location.origin);
  const username='browser-check-'+Date.now();
  const password='Browser-Session-Probe-12345';
  const response=await page.request.post(origin+'/admin/api/admins',{data:{username,displayName:'浏览器验收',password}});
  if(response.status()!==201)throw Error('测试管理员创建失败');
  const {id}=await response.json();
  const context=await page.context().browser().newContext();
  try{
    const doctor=await context.newPage();await doctor.goto(origin+'/admin/login');
    await doctor.getByRole('textbox',{name:'管理员账号',exact:true}).fill(username);
    await doctor.getByRole('textbox',{name:'密码',exact:true}).fill(password);
    await doctor.getByRole('button',{name:'登录后台',exact:true}).click();await doctor.waitForURL('**/admin/upload');
    const disabled=await page.request.post(origin+'/admin/api/admins/'+id,{data:{action:'disable'}});if(!disabled.ok())throw Error('停用失败');
    await doctor.reload();await doctor.waitForURL('**/admin/login');
    return {disabledSessionRedirected:true};
  }finally{await context.close();await page.request.post(origin+'/admin/api/admins/'+id,{data:{action:'delete'}});}
}
