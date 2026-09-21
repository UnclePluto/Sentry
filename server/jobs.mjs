import { randomUUID } from 'node:crypto';
import { mkdir, writeFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { stage, owned } from './store.mjs';
import { authorizeWrite } from './write-gate.mjs';
export const invalid = (message, status = 400) =>
  Object.assign(Error(message), { status });
export const originalPath = (dir, id) => join(dir, 'uploads', id + '.xlsx');
export async function enqueue(db, dir, input, bytes) {
  const id = randomUUID();
  await mkdir(join(dir, 'uploads'), { recursive: true, mode: 0o700 });
  await writeFile(originalPath(dir, id), bytes, { mode: 0o600, flag: 'wx' });
  try {
    await db.transaction(async (tx) => {
      await authorizeWrite(tx, input.user);
      await stage(tx, { ...input, id });
      await tx.query(
        "INSERT INTO jobs(id,import_id,owner_id,status) VALUES($1,$1,$2,'queued')",
        [id, input.user.id],
      );
    });
  } catch (e) {
    await unlink(originalPath(dir, id)).catch(() => {});
    throw e;
  }
  return { id, status: 'queued', phase: 'parse' };
}
export async function getJob(db, id, user) {
  const row = await owned(db, id, user);
  const job = await db.get(
    'SELECT id,phase,status,attempts,error,error_code,retryable,created_at,updated_at FROM jobs WHERE import_id=$1',
    id,
  );
  if (!job) throw invalid('任务不存在。', 404);
  return {
    ...job,
    formatVersion: row.format_version,
    sheet: row.source_sheet,
    sheets:
      row.payload?.sheets ||
      (row.format_version === 2 ? ['Sheet1', 'Sheet2'] : [row.source_sheet]),
    summary: row.summary,
    warnings: row.warnings,
    expiresAt: row.expires_at,
    date: row.report_date,
    location: { province: row.province, city: row.city, county: row.county },
    added: row.summary.samples,
    alreadyCommitted: row.status === 'published',
  };
}
export async function commitJob(db, id, user) {
  return db.transaction(async (tx) => {
    await authorizeWrite(tx, user);
    // 所有工作者、取消和确认使用相同顺序：任务，再批次。
    const job = await tx.get('SELECT * FROM jobs WHERE id=$1 FOR UPDATE', id);
    const row = await owned(tx, id, user, true);
    if (!job) throw invalid('任务不存在。', 404);
    if (row.status === 'published')
      return {
        id,
        status: 'succeeded',
        added: row.summary.samples,
        alreadyCommitted: true,
      };
    if (job.phase === 'commit' && ['queued', 'running'].includes(job.status))
      return { id, status: job.status, phase: 'commit' };
    if (
      job.status !== 'ready' ||
      !row.payload ||
      new Date(row.expires_at) <= new Date()
    )
      throw invalid('预览不可提交或已过期，请重新上传。');
    if (row.format_version !== 2 || row.payload.formatVersion !== 2)
      throw invalid('旧格式预览不能提交，请重新上传双工作表文件。');
    await tx.query(
      "UPDATE jobs SET phase='commit',status='queued',attempts=0,error=NULL,error_code=NULL,retryable=false,next_attempt_at=now(),updated_at=now() WHERE id=$1",
      [id],
    );
    return { id, status: 'queued', phase: 'commit' };
  });
}
export async function cancelJob(db, dir, id, user) {
  await db.transaction(async (tx) => {
    await authorizeWrite(tx, user);
    const job = await tx.get('SELECT * FROM jobs WHERE id=$1 FOR UPDATE', id);
    await owned(tx, id, user, true);
    if (
      !job ||
      job.phase !== 'parse' ||
      !['queued', 'running', 'ready', 'failed', 'cancelled'].includes(
        job.status,
      )
    )
      throw invalid('该任务不能取消。');
    await tx.query(
      "UPDATE jobs SET status='cancelled',lease_token=NULL,lease_until=NULL,updated_at=now() WHERE id=$1",
      [id],
    );
    await tx.query(
      "UPDATE imports SET status='cancelled',payload=NULL,expires_at=NULL WHERE id=$1",
      [id],
    );
  });
  await unlink(originalPath(dir, id)).catch(() => {});
  return { ok: true };
}
export async function retryJob(db, id, user) {
  return db.transaction(async (tx) => {
    await authorizeWrite(tx, user);
    const job = await tx.get('SELECT * FROM jobs WHERE id=$1 FOR UPDATE', id);
    const row = await owned(tx, id, user, true);
    if (
      !job ||
      job.status !== 'failed' ||
      !job.retryable ||
      job.attempts >= 5 ||
      !row.payload ||
      new Date(row.expires_at) <= new Date()
    )
      throw invalid('该任务不能重试，请重新上传。');
    await tx.query(
      "UPDATE jobs SET status='queued',next_attempt_at=now(),updated_at=now(),error=NULL,error_code=NULL WHERE id=$1",
      [id],
    );
    return { id, status: 'queued' };
  });
}
export async function history(
  db,
  user,
  { page = 1, pageSize = 20, tasks = false } = {},
) {
  page = Math.max(1, Math.min(1000000, Number(page) || 1));
  pageSize = Math.max(1, Math.min(100, Number(pageSize) || 20));
  if (!Number.isInteger(page) || !Number.isInteger(pageSize))
    throw invalid('分页参数无效。');
  const values = [];
  let where = 'i.demo=0';
  if (user.role !== 'superadmin') {
    values.push(user.id);
    where += ' AND i.submitted_by=$1';
  }
  where += tasks
    ? " AND j.id IS NOT NULL AND j.status<>'succeeded'"
    : " AND i.status IN('published','withdrawn')";
  return db.transaction(
    async (tx) => {
      const { total } = await tx.get(
        `SELECT count(*) total FROM imports i LEFT JOIN jobs j ON j.import_id=i.id WHERE ${where}`,
        ...values,
      );
      const rows = await tx.all(
        `SELECT i.id,i.file_name,i.province,i.city,i.county,i.report_date,i.created_at,i.status,i.submitted_name,i.submitted_username,i.summary,i.format_version "formatVersion",i.withdrawn_at,i.withdrawn_name,j.status job_status,j.phase,j.error,j.retryable FROM imports i LEFT JOIN jobs j ON j.import_id=i.id WHERE ${where} ORDER BY i.created_at DESC,i.id DESC LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
        ...values,
        pageSize,
        (page - 1) * pageSize,
      );
      return { items: rows, total, page, pageSize };
    },
    { readOnly: true },
  );
}
