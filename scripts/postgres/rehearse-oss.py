#!/usr/bin/env python3
"""在已绑定 RAM 角色的 ECS 上运行；只操作随机隔离资源和专用 OSS 演练前缀。"""
import json, os, pathlib, subprocess, tempfile, time, uuid

name = 'sentry-oss-' + uuid.uuid4().hex[:10]
pg_image = os.environ['SENTRY_POSTGRES_IMAGE']
app_image = os.environ['SENTRY_IMAGE']
containers = [name + suffix for suffix in ['-source', '-api', '-worker', '-target', '-restored-api']]
volumes = [name + suffix for suffix in ['-data', '-restore', '-app']]
backup_env = ['-e', 'SENTRY_BACKUP_ENV=rehearsal', '-e', 'SENTRY_BACKUP_INSTANCE=' + name]
backup_env += ['-e', 'SENTRY_OSS_BUCKET=' + os.environ['SENTRY_OSS_BUCKET'], '-e', 'SENTRY_OSS_ENDPOINT=' + os.environ['SENTRY_OSS_ENDPOINT']]
started = time.monotonic()

def docker(*args, stdin=None, check=True):
    return subprocess.run(['docker', *args], input=stdin, text=True, capture_output=True, check=check)

def emit(event, **fields):
    print(json.dumps({'event': event, **fields}), flush=True)

def sql(container, query):
    return docker('exec', '-i', container, 'psql', '-U', 'postgres', '-d', 'sentry', '-At', '-v', 'ON_ERROR_STOP=1', stdin=query).stdout.strip()

def wait_pg(container):
    for _ in range(120):
        if docker('exec', container, 'pg_isready', '-h', '127.0.0.1', '-U', 'postgres', check=False).returncode == 0:
            return
        time.sleep(.5)
    raise RuntimeError('database_not_ready')

def app_args(host, initialize=True):
    return ['--network', name, '--memory', '192m', '-e', 'NODE_OPTIONS=--max-old-space-size=128', '-e', 'DATABASE_URL=postgres://postgres:rehearsal-only@' + host + ':5432/sentry', '-e', 'SENTRY_AUTO_MIGRATE=' + ('1' if initialize else '0'), '-e', 'SENTRY_NO_DEMO=1', '-e', 'PG_POOL_MAX=2', '-v', volumes[2] + ':/app/data']

login_js = """
import {readFile} from 'node:fs/promises';
const base='http://127.0.0.1:3001/api';let cookie='';
const req=async(path,body)=>{const r=await fetch(base+path,{method:body?'POST':'GET',headers:{cookie,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});if(r.headers.get('set-cookie'))cookie=r.headers.get('set-cookie').split(';')[0];const data=await r.json();if(!r.ok)throw Error('request_failed_'+r.status);return data;};
let credentials;
for(let i=0;i<120;i++){try{credentials=JSON.parse(await readFile('/app/data/initial-admin.json','utf8'));await req('/auth/login',credentials);break;}catch{await new Promise(r=>setTimeout(r,250));}}
if(!cookie)throw Error('login_failed');
"""

try:
    with tempfile.TemporaryDirectory(prefix=name) as directory:
        secret = pathlib.Path(directory) / 'runtime_password'
        secret.write_text('rehearsal-only'); secret.chmod(0o644)
        docker('network', 'create', name)
        docker('run', '-d', '--name', containers[0], '--network', name, '--memory', '256m', *backup_env,
               '-e', 'POSTGRES_PASSWORD=rehearsal-only', '-e', 'POSTGRES_DB=sentry',
               '-v', str(secret) + ':/run/secrets/runtime_password:ro', '-v', volumes[0] + ':/var/lib/postgresql/data',
               pg_image, 'postgres', '-c', 'shared_buffers=48MB', '-c', 'max_connections=16', '-c', 'archive_mode=on',
               '-c', 'archive_timeout=60', '-c', 'archive_command=sentry-pgbackrest archive-push %p')
        wait_pg(containers[0])
        docker('run', '-d', '--name', containers[1], *app_args(containers[0]), app_image, 'node', 'server/index.mjs')
        docker('exec', '-i', containers[1], 'node', '--input-type=module', stdin=login_js)
        docker('run', '-d', '--name', containers[2], *app_args(containers[0]), app_image, 'node', 'server/worker.mjs')
        business_js = login_js + """
import ExcelJS from 'exceljs';
const book=new ExcelJS.Workbook();const sheet=book.addWorksheet('Sheet1');
sheet.addRows([['batch','sam','PathogenWithReads','CT value','中文'],['OSS','A','IAV',25,'甲型流感'],['OSS','A','RSV',30,'合胞病毒'],['OSS','B','IAV','阴性','甲型流感']]);
const r=await fetch(base+'/imports/preview?province_code=420000&city_code=420100&county_code=420106&date=2026-09-01&filename=oss-rehearsal.xlsx',{method:'POST',headers:{cookie},body:await book.xlsx.writeBuffer()});if(!r.ok)throw Error('upload_failed');const {id}=await r.json();
const wait=async(status)=>{for(let i=0;i<300;i++){const j=await req('/jobs/'+id);if(j.status===status)return;if(j.status==='failed')throw Error('job_failed');await new Promise(r=>setTimeout(r,200));}throw Error('job_timeout');};
await wait('ready');await req('/imports/commit',{id});await wait('succeeded');console.log(JSON.stringify({id}));
"""
        business = json.loads(docker('exec', '-i', containers[1], 'node', '--input-type=module', stdin=business_js).stdout)
        # 密码哈希和原账号仅在内存里比较；先比较再启动恢复 API，防止补建账号造成假阳性。
        account_query = "SELECT row_to_json(u)::text FROM admin_users u ORDER BY id;"
        original_accounts = sql(containers[0], account_query)
        assert original_accounts, 'source_account_required'
        emit('oss_rehearsal_published', namespace='sentry/postgresql/rehearsal/' + name)
        for args in [('stanza-create',), ('backup', '--type=full'), ('check',)]:
            result = docker('exec', '-u', 'postgres', containers[0], 'sentry-pgbackrest', *args)
            emit('oss_command_ok', command=args[0])
        info = json.loads(docker('exec', '-u', 'postgres', containers[0], 'sentry-pgbackrest', 'info', '--output=json').stdout)
        stop = max(b['timestamp']['stop'] for b in info[0]['backup'])
        while time.time() <= stop + 1: time.sleep(.1)
        target = sql(containers[0], 'SELECT clock_timestamp();')
        time.sleep(.1)
        docker('exec', '-i', containers[1], 'node', '--input-type=module', stdin=login_js + 'await req("/imports/withdraw",' + json.dumps(business) + ');')
        assert sql(containers[0], 'SELECT status FROM imports WHERE demo=0;') == 'withdrawn'
        sql(containers[0], 'SELECT pg_switch_wal();')
        docker('exec', '-u', 'postgres', containers[0], 'sentry-pgbackrest', 'check')
        # 错误令牌仅在这个隔离命令的内存中注入，不改角色、镜像或真实备份。
        invalid = docker('exec', '-i', '-u', 'postgres', containers[0], 'python3', '-', stdin="import sys\nsys.argv=['sentry-pgbackrest','info']\ns=open('/usr/local/bin/sentry-pgbackrest').read().replace('env[key]=creds[field]',\"env[key]=('invalid-token-for-rehearsal' if field=='SecurityToken' else creds[field])\")\nexec(compile(s,'<isolated-invalid-token>','exec'))", check=False)
        assert invalid.returncode != 0 and ('403' in invalid.stdout or 'InvalidAccessKeyId' in invalid.stdout or 'InvalidSecurityToken' in invalid.stdout), 'invalid_token_must_be_rejected_by_oss'
        isolated = docker('run', '--rm', '--network', 'none', *backup_env, pg_image, 'sentry-pgbackrest', 'info', check=False)
        assert isolated.returncode != 0, 'unavailable_metadata_must_fail'
        restore_started = time.monotonic()
        for c in containers[1:3]: docker('stop', c)
        docker('stop', containers[0])
        docker('run', '--rm', '-u', 'root', '-v', volumes[1] + ':/restore', pg_image, 'chown', 'postgres:postgres', '/restore')
        docker('run', '--rm', '-u', 'postgres', '--memory', '192m', *backup_env, '-v', volumes[1] + ':/restore', pg_image,
               'sentry-pgbackrest', 'restore', '--pg1-path=/restore/pgdata', '--type=time', '--target=' + target, '--target-action=promote')
        docker('run', '-d', '--name', containers[3], '--network', name, '--memory', '256m', *backup_env,
               '-e', 'PGDATA=/restore/pgdata', '-v', volumes[1] + ':/restore', pg_image, 'postgres', '-c', 'archive_mode=off')
        wait_pg(containers[3])
        assert sql(containers[3], 'SELECT status FROM imports WHERE demo=0;') == 'published'
        assert sql(containers[3], "SELECT tested||':'||positive FROM import_metrics WHERE pathogen_code='';") == '2:1'
        assert sql(containers[3], 'SELECT count(*) FROM results;') == '3'
        assert sql(containers[3], account_query) == original_accounts, 'restored_original_accounts_must_match'
        docker('run', '-d', '--name', containers[4], *app_args(containers[3], initialize=False), app_image, 'node', 'server/index.mjs')
        docker('exec', '-i', containers[4], 'node', '--input-type=module', stdin=login_js)
        emit('oss_pitr_verified', namespace='sentry/postgresql/rehearsal/' + name, target=target,
             sourceState='withdrawn', restoredState='published', tested=2, positive=1,
             restoredLoginVerified=True, invalidTokenRejected=True, metadataUnavailableRejected=True,
             restoreSeconds=round(time.monotonic()-restore_started, 2), totalSeconds=round(time.monotonic()-started, 2))
except subprocess.CalledProcessError as e:
    # 不输出参数、输入或环境。备份包装器输出已脱敏，其他失败只记录退出码。
    detail = (e.stdout or '')[-2500:] if 'sentry-pgbackrest' in e.cmd else ''
    emit('oss_rehearsal_failed', returncode=e.returncode, detail=detail)
    raise SystemExit(1)
finally:
    leftovers = []
    for c in containers:
        docker('rm', '-f', c, check=False)
    for v in volumes:
        docker('volume', 'rm', v, check=False)
    docker('network', 'rm', name, check=False)
    for kind, args, expected in [
        ('containers', ['container', 'ls', '--all', '--format', '{{.Names}}'], containers),
        ('volumes', ['volume', 'ls', '--format', '{{.Name}}'], volumes),
        ('networks', ['network', 'ls', '--format', '{{.Name}}'], [name]),
    ]:
        inventory = docker(*args, check=False)
        if inventory.returncode != 0:
            leftovers.append(kind + ':cleanup_verification_failed')
        else:
            leftovers.extend(sorted(set(expected) & set(inventory.stdout.splitlines())))
    emit('oss_rehearsal_cleanup', localResourcesRemoved=not leftovers, leftovers=leftovers,
         ossEvidencePrefix='sentry/postgresql/rehearsal/' + name,
         ossEvidenceRetained=True)
    if leftovers: raise SystemExit(1)
