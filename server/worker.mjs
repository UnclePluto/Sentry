import { randomUUID } from 'node:crypto';
import { readFile, unlink, readdir, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { Worker } from 'node:worker_threads';
import { openStore, publishInTransaction } from './store.mjs';
import { originalPath } from './jobs.mjs';
import { lockWrites } from './write-gate.mjs';
import { validateSamplePayload } from './sample-import.mjs';
const dir = resolve(process.env.SENTRY_DATA_DIR || 'data');
const db = await openStore(dir),
  workerId = randomUUID();
let stopping = false,
  active;
const log = (event, fields = {}) =>
  console.log(
    JSON.stringify({ time: new Date().toISOString(), event, ...fields }),
  );
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function claim() {
  return db.transaction(async (tx) => {
    const state = await tx.get(
      'SELECT maintenance FROM dataset_state WHERE id=1',
    );
    if (state.maintenance) return;
    const job = await tx.get(
      "SELECT * FROM jobs WHERE (status='queued' AND next_attempt_at<=now()) OR (status='running' AND lease_until<now()) ORDER BY created_at,id FOR UPDATE SKIP LOCKED LIMIT 1",
    );
    if (!job) return;
    await tx.query(
      "UPDATE job_attempts SET finished_at=now(),outcome='lease_expired' WHERE job_id=$1 AND finished_at IS NULL",
      [job.id],
    );
    if (job.attempts >= 5) {
      await tx.query(
        "UPDATE jobs SET status='failed',error='重试次数已耗尽，请重新上传或联系管理员。',error_code='attempts_exhausted',retryable=false,lease_token=NULL,lease_until=NULL,updated_at=now() WHERE id=$1",
        [job.id],
      );
      return;
    }
    const token = randomUUID();
    await tx.query(
      "UPDATE jobs SET status='running',attempts=attempts+1,lease_token=$2,lease_until=now()+interval '60 seconds',updated_at=now() WHERE id=$1",
      [job.id, token],
    );
    await tx.query(
      'INSERT INTO job_attempts(job_id,phase,attempt) VALUES($1,$2,$3)',
      [job.id, job.phase, job.attempts + 1],
    );
    return { ...job, token, attempts: job.attempts + 1 };
  });
}
function parse(bytes) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./parse-worker.mjs', import.meta.url), {
      workerData: bytes,
      resourceLimits: { maxOldGenerationSizeMb: 192 },
    });
    active = worker;
    let settled = false;
    const finish = (err, data) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void worker.terminate();
      active = undefined;
      if (err) reject(err);
      else resolve(data);
    };
    const timer = setTimeout(
      () =>
        finish(
          Object.assign(Error('文件解析超时，请减少内容后重试。'), {
            business: true,
          }),
        ),
      25000,
    );
    worker.once('message', (result) =>
      finish(
        result.error
          ? Object.assign(Error(result.error), { business: true })
          : null,
        result.data,
      ),
    );
    worker.once('error', () =>
      finish(
        Object.assign(Error('文件超过解析资源限制或格式异常，请检查后重试。'), {
          business: true,
        }),
      ),
    );
    worker.once('exit', () => {
      if (!settled) finish(Error('解析进程意外退出'));
    });
  });
}
async function processJob(job) {
  const start = Date.now();
  log('job_started', { id: job.id, phase: job.phase, attempt: job.attempts });
  const renew = setInterval(
    () =>
      db
        .query(
          "UPDATE jobs SET lease_until=now()+interval '60 seconds' WHERE id=$1 AND lease_token=$2 AND status='running'",
          [job.id, job.token],
        )
        .catch((e) => log('lease_renew_failed', { code: e.code || 'unknown' })),
    10000,
  );
  try {
    if (job.phase === 'parse') {
      let bytes;
      try {
        bytes = await readFile(originalPath(dir, job.id));
      } catch (e) {
        if (e.code === 'ENOENT')
          throw Object.assign(Error('临时原文件已丢失，请重新上传。'), {
            business: true,
          });
        throw e;
      }
      const payload = await parse(bytes);
      validateSamplePayload(payload);
      const accepted = await db.transaction(async (tx) => {
        const current = await tx.get(
          'SELECT * FROM jobs WHERE id=$1 FOR UPDATE',
          job.id,
        );
        if (current.lease_token !== job.token || current.status !== 'running')
          return;
        await tx.query(
          "UPDATE imports SET payload=$2,summary=$3,warnings=$4,source_sheet=$5,format_version=2,expires_at=now()+interval '7 days' WHERE id=$1 AND status='staged'",
          [
            job.id,
            JSON.stringify(payload),
            JSON.stringify(payload.summary),
            JSON.stringify(payload.warnings),
            payload.sheet,
          ],
        );
        await tx.query(
          "UPDATE jobs SET status='ready',lease_token=NULL,lease_until=NULL,updated_at=now() WHERE id=$1",
          [job.id],
        );
        await tx.query(
          "UPDATE job_attempts SET finished_at=now(),outcome='ready' WHERE job_id=$1 AND attempt=$2 AND phase=$3",
          [job.id, job.attempts, job.phase],
        );
        return true;
      });
      if (accepted) await unlink(originalPath(dir, job.id)).catch(() => {});
    } else {
      await db.transaction(async (tx) => {
        await lockWrites(tx);
        const current = await tx.get(
          'SELECT * FROM jobs WHERE id=$1 FOR UPDATE',
          job.id,
        );
        if (current.lease_token !== job.token || current.status !== 'running')
          return;
        await publishInTransaction(tx, job.id);
        await tx.query(
          "UPDATE jobs SET status='succeeded',lease_token=NULL,lease_until=NULL,updated_at=now(),retryable=false WHERE id=$1",
          [job.id],
        );
        await tx.query(
          "UPDATE job_attempts SET finished_at=now(),outcome='succeeded' WHERE job_id=$1 AND attempt=$2 AND phase=$3",
          [job.id, job.attempts, job.phase],
        );
      });
    }
    log('job_finished', {
      id: job.id,
      phase: job.phase,
      durationMs: Date.now() - start,
    });
  } catch (error) {
    const terminal = error.business || job.attempts >= 3;
    const code = error.business
      ? 'invalid_workbook'
      : error.code || 'worker_failure';
    const recorded = await db
      .transaction(async (tx) => {
        const changed = await tx.query(
          `UPDATE jobs SET status=$3,error=$4,error_code=$5,retryable=$6,lease_token=NULL,lease_until=NULL,next_attempt_at=now()+interval '5 seconds',updated_at=now() WHERE id=$1 AND lease_token=$2 AND status='running'`,
          [
            job.id,
            job.token,
            terminal ? 'failed' : 'queued',
            error.business
              ? error.message
              : job.attempts >= 5
                ? '重试次数已耗尽，请重新上传或联系管理员。'
                : '任务暂时未完成，系统将重试；持续失败时请联系管理员。',
            code,
            !error.business && job.phase === 'commit' && job.attempts < 5,
          ],
        );
        if (changed.rowCount)
          await tx.query(
            'UPDATE job_attempts SET finished_at=now(),outcome=$4,error_code=$5 WHERE job_id=$1 AND attempt=$2 AND phase=$3',
            [
              job.id,
              job.attempts,
              job.phase,
              terminal ? 'failed' : 'retry',
              code,
            ],
          );
        return changed.rowCount > 0;
      })
      .catch((e) =>
        log('job_failure_record_failed', {
          id: job.id,
          code: e.code || 'unknown',
        }),
      );
    if (recorded && terminal && job.phase === 'parse')
      await unlink(originalPath(dir, job.id)).catch(() => {});
    log('job_failed', {
      id: job.id,
      phase: job.phase,
      code,
      durationMs: Date.now() - start,
    });
  } finally {
    clearInterval(renew);
  }
}
async function cleanup() {
  await db.transaction(async (tx) => {
    const expired = await tx.all(
      "SELECT j.id FROM jobs j JOIN imports i ON i.id=j.import_id WHERE i.status='staged' AND i.expires_at<now() AND j.status NOT IN('running','queued') FOR UPDATE OF j SKIP LOCKED LIMIT 100",
    );
    for (const { id } of expired) {
      await tx.query(
        "UPDATE imports SET status='expired',payload=NULL,expires_at=NULL WHERE id=$1",
        [id],
      );
      await tx.query(
        "UPDATE jobs SET status='expired',retryable=false,updated_at=now() WHERE id=$1",
        [id],
      );
    }
  });
  for (const file of await readdir(join(dir, 'uploads')).catch(() => [])) {
    if (!/^[a-f0-9-]{36}\.xlsx$/.test(file)) continue;
    const path = join(dir, 'uploads', file);
    const info = await stat(path).catch(() => null);
    if (!info) continue;
    const job = await db.get(
      'SELECT status FROM jobs WHERE id=$1',
      file.slice(0, -5),
    );
    if (
      Date.now() - info.mtimeMs > 86400000 &&
      job &&
      ['queued', 'running'].includes(job.status)
    ) {
      await db.transaction(async (tx) => {
        const j = await tx.get(
          'SELECT * FROM jobs WHERE id=$1 FOR UPDATE',
          file.slice(0, -5),
        );
        if (j.phase === 'parse' && ['queued', 'running'].includes(j.status)) {
          await tx.query(
            "UPDATE jobs SET status='failed',error='原文件已超过 24 小时，请重新上传。',error_code='original_expired',retryable=false,lease_token=NULL,lease_until=NULL,updated_at=now() WHERE id=$1",
            [j.id],
          );
        }
      });
    }
    if (
      (job && !['queued', 'running'].includes(job.status)) ||
      Date.now() - info.mtimeMs > 86400000
    )
      await unlink(path).catch(() => {});
  }
  await db.query('DELETE FROM admin_sessions WHERE expires_at<$1', [
    Date.now(),
  ]);
  await db.query(
    "DELETE FROM worker_heartbeats WHERE seen_at<now()-interval '1 day'",
  );
}
for (const signal of ['SIGINT', 'SIGTERM'])
  process.on(signal, () => {
    stopping = true;
  });
let lastCleanup = 0;
log('worker_ready');
while (!stopping) {
  try {
    await db.query(
      'INSERT INTO worker_heartbeats(id,seen_at) VALUES($1,now()) ON CONFLICT(id) DO UPDATE SET seen_at=now()',
      [workerId],
    );
    if (Date.now() - lastCleanup > 60000) {
      await cleanup();
      lastCleanup = Date.now();
    }
    const job = await claim();
    if (job) await processJob(job);
    else await sleep(500);
  } catch (e) {
    log('worker_loop_failed', { code: e.code || 'unknown' });
    await sleep(2000);
  }
}
await active?.terminate();
await db.close();
