#!/usr/bin/env python3
"""仅创建并销毁带随机名称的本机演练容器；不接触线上库或 OSS。"""
import subprocess, tempfile, os, json, time, uuid, pathlib, urllib.request
name='sentry-recovery-'+uuid.uuid4().hex[:10]
image=os.environ.get('SENTRY_POSTGRES_TEST_IMAGE','sentry-postgres:rehearsal')
volumes=[name+'-data',name+'-repo',name+'-restore'];containers=[name+'-source',name+'-target',name+'-broken']
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
    logs=docker('logs','--tail','30',container,check=False)
    raise RuntimeError('database_readiness_failed: '+(logs.stdout+logs.stderr)[-3000:])
try:
 with tempfile.TemporaryDirectory(prefix=name) as directory:
    secret=pathlib.Path(directory)/'runtime';secret.write_text('rehearsal-only-password');secret.chmod(0o644)
    clock=pathlib.Path(directory)/'clock';clock.write_text('+00d');clock.chmod(0o644)
    clock_args=[]
    if os.environ.get('SENTRY_TEST_RETENTION')=='1':
        library=next(p for p in docker('run','--rm',image,'dpkg','-L','libfaketime').stdout.splitlines() if p.endswith('/libfaketime.so.1'))
        clock_args=['--user','postgres','-v',str(clock)+':/control-clock:ro','-e','LD_PRELOAD='+library,'-e','FAKETIME_TIMESTAMP_FILE=/control-clock','-e','FAKETIME_NO_CACHE=1','-e','FAKETIME_DONT_FAKE_MONOTONIC=1']
    docker('run','-d',*clock_args,'--name',containers[0],'-e','POSTGRES_PASSWORD=rehearsal-only-password','-e','POSTGRES_DB=sentry','-e','SENTRY_BACKUP_LOCAL_REPO=/rehearsal/repo','-p','127.0.0.1:15433:5432','-v',str(secret)+':/run/secrets/runtime_password:ro','-v',volumes[0]+':/var/lib/postgresql/data','-v',volumes[1]+':/rehearsal',image,'postgres','-c','archive_mode=on','-c','archive_timeout=60','-c','archive_command=sentry-pgbackrest archive-push %p')
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
    docker('run','-d','--name',containers[1],'-p','127.0.0.1:15434:5432','-e','PGDATA=/restore/pgdata','-e','SENTRY_BACKUP_LOCAL_REPO=/rehearsal/repo','-v',volumes[1]+':/rehearsal','-v',volumes[2]+':/restore',image,'postgres','-c','archive_mode=off')
    wait(containers[1])
    assert sql(containers[1],"SELECT status FROM imports WHERE demo=0;")=='published'
    assert sql(containers[1],"SELECT tested||':'||positive FROM import_metrics WHERE pathogen_code='';")=='2:1'
    assert sql(containers[1],"SELECT count(*) FROM admin_users WHERE role='superadmin';")=='1'
    assert sql(containers[1],"SELECT count(*) FROM results;")=='3'
    restored_env={**env,'DATABASE_URL':'postgres://postgres:rehearsal-only-password@127.0.0.1:15434/sentry','API_PORT':'3198'}
    restored_api=subprocess.Popen(['node','server/index.mjs'],env=restored_env,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL);processes.append(restored_api)
    credentials=json.loads(pathlib.Path(directory,'initial-admin.json').read_text())
    login_ok=False
    for _ in range(100):
        try:
            login=urllib.request.Request('http://127.0.0.1:3198/api/auth/login',data=json.dumps(credentials).encode(),headers={'Content-Type':'application/json'})
            with urllib.request.urlopen(login,timeout=2) as response: login_ok=response.status==200
            if login_ok: break
        except Exception: time.sleep(.1)
    assert login_ok, '恢复后原账号应能通过实际登录接口认证'
    # 复制演练仓库并只删除副本 WAL；验证恢复进程明确失败，而不是提供不完整库。
    docker('exec','-u','postgres',containers[0],'python3','-c',"import pathlib,shutil;shutil.copytree('/rehearsal/repo','/rehearsal/broken');[p.unlink() for p in pathlib.Path('/rehearsal/broken/archive').rglob('*.gz')]")
    docker('run','--rm','-u','postgres','-e','SENTRY_BACKUP_LOCAL_REPO=/rehearsal/broken','-v',volumes[1]+':/rehearsal','-v',volumes[2]+':/restore',image,'sentry-pgbackrest','restore','--pg1-path=/restore/broken','--type=time','--target='+target,'--target-action=promote')
    docker('run','-d','--name',containers[2],'-e','PGDATA=/restore/broken','-e','SENTRY_BACKUP_LOCAL_REPO=/rehearsal/broken','-v',volumes[1]+':/rehearsal','-v',volumes[2]+':/restore',image,'postgres','-c','archive_mode=off')
    rejected=False
    for _ in range(60):
        state=json.loads(docker('inspect','--format','{{json .State}}',containers[2]).stdout)
        if state['Status']=='exited': rejected=state['ExitCode']!=0;break
        assert docker('exec',containers[2],'pg_isready','-h','127.0.0.1','-U','postgres',check=False).returncode!=0, '缺失WAL不能被视为就绪'
        time.sleep(.5)
    assert rejected, '缺失WAL必须明确失败'
    # 缺少备份仓库必须明确失败；不能生成可冒充成功的恢复目录。
    failure=docker('run','--rm','-u','postgres','-e','SENTRY_BACKUP_LOCAL_REPO=/rehearsal/missing','-v',volumes[1]+':/rehearsal','-v',volumes[2]+':/restore',image,'sentry-pgbackrest','restore','--pg1-path=/restore/missing','--type=time','--target='+target,'--target-action=promote',check=False)
    assert failure.returncode!=0
    retention_verified=False
    if os.environ.get('SENTRY_TEST_RETENTION')=='1':
        library=next(p for p in docker('exec',containers[0],'dpkg','-L','libfaketime').stdout.splitlines() if p.endswith('/libfaketime.so.1'))
        def future(days,*args):
            with clock.open('r+') as f: f.write(f'{days:+03d}d');f.flush()
            return docker('exec','-u','postgres','-e','LD_PRELOAD='+library,'-e','FAKETIME=+'+str(days)+'d','-e','FAKETIME_DONT_FAKE_MONOTONIC=1',containers[0],'sentry-pgbackrest',*args)
        future(10,'backup','--type=full','--no-expire-auto')
        future(35,'backup','--type=full','--no-expire-auto')
        chain=json.loads(docker('exec','-u','postgres',containers[0],'sentry-pgbackrest','info','--output=json').stdout)[0]['backup']
        print(json.dumps({'event':'controlled_backup_times','backups':[{k:b[k] for k in ['label','timestamp']} for b in chain]}))
        future(35,'expire')
        chain=json.loads(docker('exec','-u','postgres',containers[0],'sentry-pgbackrest','info','--output=json').stdout)[0]['backup']
        assert len(chain)==3, '30天窗口仍依赖窗口前的第一个完整备份，不能提前删除'
        future(45,'expire')
        remaining=json.loads(docker('exec','-u','postgres',containers[0],'sentry-pgbackrest','info','--output=json').stdout)[0]['backup']
        assert len(remaining)==2 and remaining[0]['label']==chain[1]['label'], '应保留覆盖窗口起点的完整备份及其后的备份'
        retention_verified=True
    print(json.dumps({'event':'isolated_pitr_verified','seconds':round(time.monotonic()-started,2),'sourceState':'withdrawn','restoredState':'published','tested':2,'positive':1,'missingRepositoryRejected':True,'missingWalRejected':True,'restoredLoginVerified':login_ok,'repository':'local-only','ossVerified':False,'retentionControlledTimeVerified':retention_verified}))
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
