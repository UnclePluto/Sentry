#!/usr/bin/env python3
"""从 ECS IMDSv2 取临时授权；不写密钥、不打印命令环境。"""
import json, os, re, subprocess, sys, tempfile, time, urllib.request

def metadata(path, token=None, method='GET'):
    headers={'X-aliyun-ecs-metadata-token':token} if token else {'X-aliyun-ecs-metadata-token-ttl-seconds':'60'}
    req=urllib.request.Request('http://100.100.100.200/latest/'+path,headers=headers,method=method)
    with urllib.request.urlopen(req,timeout=3) as r: return r.read().decode()

def main():
    args=sys.argv[1:]
    if not args or args[0] not in ['archive-push','archive-get','backup','check','info','stanza-create','restore','expire']: raise ValueError('unsupported_command')
    if args[0]=='info':
        args=[a for a in args if not a.startswith('--output=')]+['--output=json']
    env=os.environ.copy();secrets=[]
    local=env.get('SENTRY_BACKUP_LOCAL_REPO')
    if local:
        if not local.startswith('/rehearsal/'): raise ValueError('local_repo_must_be_isolated')
        repo='repo1-type=posix\nrepo1-path='+local
    else:
        name=env.get('SENTRY_BACKUP_INSTANCE','');stage=env.get('SENTRY_BACKUP_ENV','production')
        if not re.fullmatch(r'[a-zA-Z0-9_-]{8,80}',name) or not re.fullmatch(r'[a-z0-9_-]{1,30}',stage): raise ValueError('backup_namespace_required')
        bucket=env.get('SENTRY_OSS_BUCKET','');endpoint=env.get('SENTRY_OSS_ENDPOINT','')
        region_match=re.fullmatch(r'oss-([a-z0-9-]+)\.aliyuncs\.com',endpoint)
        if not re.fullmatch(r'[a-z0-9][a-z0-9-]{1,61}[a-z0-9]',bucket) or not region_match: raise ValueError('explicit_oss_bucket_and_endpoint_required')
        region=region_match.group(1)
        token=metadata('api/token',method='PUT')
        role=metadata('meta-data/ram/security-credentials/',token).strip()
        if not re.fullmatch(r'[A-Za-z0-9_.-]+',role): raise ValueError('ram_role_unavailable')
        creds=json.loads(metadata('meta-data/ram/security-credentials/'+role,token))
        for field,key in [('AccessKeyId','PGBACKREST_REPO1_S3_KEY'),('AccessKeySecret','PGBACKREST_REPO1_S3_KEY_SECRET'),('SecurityToken','PGBACKREST_REPO1_S3_TOKEN')]:
            env[key]=creds[field];secrets.append(creds[field])
        repo='\n'.join(['repo1-type=s3','repo1-s3-endpoint='+endpoint,'repo1-s3-region='+region,'repo1-s3-bucket='+bucket,'repo1-s3-uri-style=host','repo1-path=/sentry/postgresql/'+stage+'/'+name])
    config='[global]\n'+repo+'\nrepo1-retention-full-type=time\nrepo1-retention-full=30\nprocess-max=1\ncompress-type=gz\ncompress-level=3\nlog-level-console=warn\nlog-level-file=off\narchive-timeout=120\n[sentry]\npg1-path='+env.get('PGDATA','/var/lib/postgresql/data')+'\npg1-socket-path=/var/run/postgresql\n'
    if args[0]=='restore':
        args.append('--recovery-option=restore_command=sentry-pgbackrest archive-get %f "%p"')
        target=next((a.split('=',1)[1] for a in args if a.startswith('--pg1-path=')),None)
        if not target or not target.startswith('/restore/') or os.path.exists(os.path.join(target,'postmaster.pid')): raise ValueError('restore_target_must_be_isolated')
        if os.path.isdir(target) and os.listdir(target): raise ValueError('restore_target_must_be_empty')
    with tempfile.NamedTemporaryFile(mode='w',prefix='sentry-backrest-',delete=True) as f:
        f.write(config);f.flush()
        result=subprocess.run(['pgbackrest','--config='+f.name,'--stanza=sentry']+args,env=env,capture_output=True,text=True)
    output=result.stdout+result.stderr;stdout=result.stdout;returncode=result.returncode
    for value in secrets:
        output=output.replace(value,'[redacted]');stdout=stdout.replace(value,'[redacted]')
    if args[0]=='info' and returncode==0:
        # pgBackRest info 在仓库返回 403 时仍可能退出 0；必须检查结构化状态。
        info=json.loads(stdout)
        if not info or any(s.get('status',{}).get('code')!=0 or any(r.get('status',{}).get('code')!=0 for r in s.get('repo',[])) for s in info): returncode=1
        else:
            print(stdout.strip());return 0
    print(json.dumps({'time':time.time(),'event':'backup_command','command':args[0],'ok':returncode==0,'detail':output[-3000:]},ensure_ascii=False))
    return returncode
try: sys.exit(main())
except Exception as e:
    print(json.dumps({'event':'backup_failed','type':type(e).__name__}),file=sys.stderr);sys.exit(1)
