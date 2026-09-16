#!/usr/bin/env python3
"""仅创建并销毁带随机名称的本机演练容器；不接触线上库或 OSS。"""
import subprocess, tempfile, os, json, time, uuid, pathlib, urllib.request
name='sentry-recovery-'+uuid.uuid4().hex[:10]
image=os.environ.get('SENTRY_POSTGRES_TEST_IMAGE','sentry-postgres:rehearsal')
volumes=[name+'-data',name+'-repo',name+'-restore'];containers=[name+'-source',name+'-target']
started=time.monotonic();processes=[]
def run(args,stdin=None,check=True,env=None):
    return subprocess.run(args,input=stdin,text=True,capture_output=True,check=check,env=env)
def docker(*args,**kwargs): return run(['docker',*args],**kwargs)
def sql(container,query): return docker('exec','-i',container,'psql','-U','postgres','-d','sentry','-At','-v','ON_ERROR_STOP=1',stdin=query).stdout.strip()
def wait(container):
    until=time.monotonic()+60
    while time.monotonic()<until:
        if docker('exec',container,'pg_isready','-h','127.0.0.1','-U','postgres',check=False).returncode==0:return
        time.sleep(.5)
    raise RuntimeError('database_readiness_failed')
try:
 with tempfile.TemporaryDirectory(prefix=name) as directory:
    secret=pathlib.Path(directory)/'runtime';secret.write_text('rehearsal-only-password');secret.chmod(0o644)
    docker('run','-d','--name',containers[0],'-e','POSTGRES_PASSWORD=rehearsal-only-password','-e','POSTGRES_DB=sentry','-e','SENTRY_BACKUP_LOCAL_REPO=/rehearsal/repo','-p','127.0.0.1:15433:5432','-v',str(secret)+':/run/secrets/runtime_password:ro','-v',volumes[0]+':/var/lib/postgresql/data','-v',volumes[1]+':/rehearsal',image,'postgres','-c','archive_mode=on','-c','archive_timeout=60','-c','archive_command=sentry-pgbackrest archive-push %p')
    wait(containers[0]);docker('exec','-u','root',containers[0],'chown','-R','postgres:postgres','/rehearsal')
    env={**os.environ,'DATABASE_URL':'postgres://postgres:rehearsal-only-password@127.0.0.1:15433/sentry','SENTRY_DATA_DIR':directory,'SENTRY_AUTO_MIGRATE':'1','SENTRY_NO_DEMO':'1','API_PORT':'3199'}
    api=subprocess.Popen(['node','server/index.mjs'],env=env,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL);processes.append(api)
    until=time.monotonic()+30
    while not pathlib.Path(directory,'initial-admin.json').exists():
        if time.monotonic()>until:raise RuntimeError('api_start_failed')
        time.sleep(.1)
    worker=subprocess.Popen(['node','server/worker.mjs'],env=env,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL);processes.append(worker)
    # Node 请求实际业务 API，凭据仅通过私有文件读入。
    js=r'''
import {readFile} from 'node:fs/promises';
import {workbook,validRows} from './tests/helpers/submission.mjs';
const base='http://127.0.0.1:3199/api';let cookie='';
const req=async(path,body)=>{const r=await fetch(base+path,{method:body?'POST':'GET',headers:{cookie,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});if(r.headers.get('set-cookie'))cookie=r.headers.get('set-cookie').split(';')[0];const data=await r.json();if(!r.ok)throw Error(JSON.stringify(data));return data;};
const credentials=JSON.parse(await readFile(process.env.SENTRY_DATA_DIR+'/initial-admin.json','utf8'));await req('/auth/login',credentials);
const r=await fetch(base+'/imports/preview?province_code=420000&city_code=420100&county_code=420106&date=2026-09-01&filename=test.xlsx',{method:'POST',headers:{cookie},body:await workbook(validRows)});const {id}=await r.json();
const wait=async(status)=>{for(let i=0;i<100;i++){const j=await req('/jobs/'+id);if(j.status===status)return;if(j.status==='failed')throw Error(j.error);await new Promise(r=>setTimeout(r,100));}throw Error('job_timeout');};
await wait('ready');await req('/imports/commit',{id});await wait('succeeded');console.log(JSON.stringify({id,cookie}));
'''
    result=run(['node','--input-type=module'],stdin=js,env=env)
    business=json.loads(result.stdout.strip().splitlines()[-1])
    docker('exec','-u','postgres',containers[0],'sentry-pgbackrest','stanza-create')
    docker('exec','-u','postgres',containers[0],'sentry-pgbackrest','backup','--type=full')
    info=json.loads(docker('exec','-u','postgres',containers[0],'sentry-pgbackrest','info','--output=json').stdout)
    stop=max(b['timestamp']['stop'] for b in info[0]['backup'])
    while time.time()<=stop+1: time.sleep(.1)
    target=sql(containers[0],'SELECT clock_timestamp();')
    time.sleep(.05)
    request=urllib.request.Request('http://127.0.0.1:3199/api/imports/withdraw',data=json.dumps({'id':business['id']}).encode(),headers={'Content-Type':'application/json','Cookie':business['cookie']})
    with urllib.request.urlopen(request) as response: assert response.status==200
    assert sql(containers[0],"SELECT status FROM imports WHERE demo=0;")=='withdrawn'
    sql(containers[0],'SELECT pg_switch_wal();')
    docker('exec','-u','postgres',containers[0],'sentry-pgbackrest','check')
    docker('run','--rm','-u','root','-v',volumes[2]+':/restore',image,'chown','postgres:postgres','/restore')
    restored=docker('run','--rm','-u','postgres','-e','SENTRY_BACKUP_LOCAL_REPO=/rehearsal/repo','-v',volumes[1]+':/rehearsal','-v',volumes[2]+':/restore',image,'sentry-pgbackrest','restore','--pg1-path=/restore/pgdata','--type=time','--target='+target,'--target-action=promote')
    docker('run','-d','--name',containers[1],'-e','PGDATA=/restore/pgdata','-e','SENTRY_BACKUP_LOCAL_REPO=/rehearsal/repo','-v',volumes[1]+':/rehearsal','-v',volumes[2]+':/restore',image,'postgres','-c','archive_mode=off')
    wait(containers[1])
    assert sql(containers[1],"SELECT status FROM imports WHERE demo=0;")=='published'
    assert sql(containers[1],"SELECT tested||':'||positive FROM import_metrics WHERE pathogen_code='';")=='2:1'
    assert sql(containers[1],"SELECT count(*) FROM admin_users WHERE role='superadmin';")=='1'
    assert sql(containers[1],"SELECT count(*) FROM results;")=='3'
    # 缺少备份仓库必须明确失败；不能生成可冒充成功的恢复目录。
    failure=docker('run','--rm','-u','postgres','-e','SENTRY_BACKUP_LOCAL_REPO=/rehearsal/missing','-v',volumes[1]+':/rehearsal','-v',volumes[2]+':/restore',image,'sentry-pgbackrest','restore','--pg1-path=/restore/missing','--type=time','--target='+target,'--target-action=promote',check=False)
    assert failure.returncode!=0
    print(json.dumps({'event':'isolated_pitr_verified','seconds':round(time.monotonic()-started,2),'sourceState':'withdrawn','restoredState':'published','tested':2,'positive':1,'missingRepositoryRejected':True,'repository':'local-only','ossVerified':False}))
except subprocess.CalledProcessError as e:
    # 命令输入及 env 可能包含临时凭据，不回显；输出仅用于本地受控调试。
    print(json.dumps({'event':'rehearsal_failed','returncode':e.returncode,'detail':(e.stderr or e.stdout or '')[-1800:]}));raise SystemExit(1)
finally:
    for p in processes:
        p.terminate()
        try:p.wait(timeout=10)
        except subprocess.TimeoutExpired:p.kill();p.wait()
    for c in containers:docker('rm','-f',c,check=False)
    for v in volumes:docker('volume','rm',v,check=False)
