#!/usr/bin/env python3
import subprocess, time, json, shutil, signal
running=True
last_full=0
last_diff=0

def stop(*args):
    global running
    running=False
for sig in [signal.SIGINT,signal.SIGTERM]: signal.signal(sig,stop)
while running:
    now=time.time()
    try:
        info=subprocess.run(['sentry-pgbackrest','info','--output=json'],capture_output=True,text=True,timeout=60)
        if info.returncode: raise RuntimeError('backup_repository_unavailable')
        parsed=json.loads(info.stdout)
        backups=parsed[0].get('backup',[]) if parsed else []
        last_full=max([b['timestamp']['stop'] for b in backups if b['type']=='full'] or [0])
        last_diff=max([b['timestamp']['stop'] for b in backups] or [0])
        mode='full' if now-last_full>=7*86400 else 'diff' if now-last_diff>=86400 else None
        if mode:
            result=subprocess.run(['sentry-pgbackrest','backup','--type='+mode],timeout=3600)
            if result.returncode: raise RuntimeError('backup_failed')
        free=shutil.disk_usage('/var/lib/postgresql/data').free
        print(json.dumps({'event':'backup_status','lastFull':last_full,'lastBackup':last_diff,'freeBytes':free,'diskLow':free<5*1024**3}),flush=True)
        check=subprocess.run(['sentry-pgbackrest','check'],timeout=180)
        if check.returncode: raise RuntimeError('wal_archive_check_failed')
    except Exception as e: print(json.dumps({'event':'backup_schedule_failed','type':type(e).__name__}),flush=True)
    for _ in range(300):
        if not running: break
        time.sleep(1)
