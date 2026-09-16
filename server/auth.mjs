import {
  randomBytes,
  randomUUID,
  createHash,
  scrypt as scryptCallback,
  timingSafeEqual,
} from 'node:crypto';
import { promisify } from 'node:util';
import { writeFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
const scrypt = promisify(scryptCallback);
const digest = (value) => createHash('sha256').update(value).digest('hex');
const cookieName = 'sentry_admin_session';
const safeUser = (row) =>
  row && {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    role: row.role,
    enabled: Boolean(row.enabled),
    createdAt: row.created_at,
  };
const invalid = (message, status = 400) =>
  Object.assign(new Error(message), { status });
function checkPassword(value) {
  if (typeof value !== 'string' || value.length < 12 || value.length > 128)
    throw invalid('密码长度需为 12–128 个字符。');
}
async function passwordHash(value) {
  checkPassword(value);
  const salt = randomBytes(16).toString('hex');
  const key = await scrypt(value, salt, 64);
  return `${salt}:${key.toString('hex')}`;
}
async function passwordMatches(value, encoded) {
  const [salt, hash] = (
    encoded || '00000000000000000000000000000000:' + '00'.repeat(64)
  ).split(':');
  const key = await scrypt(
    typeof value === 'string' ? value.slice(0, 128) : '',
    salt,
    64,
  );
  return (
    typeof value === 'string' &&
    value.length <= 128 &&
    timingSafeEqual(key, Buffer.from(hash, 'hex'))
  );
}
export async function createAuth(db, dataDir) {
  const credentialsPath = join(dataDir, 'initial-admin.json');
  await db.transaction(async (tx) => {
    await tx.query('SELECT pg_advisory_xact_lock(78230402)');
    if (!(await tx.get('SELECT id FROM admin_users LIMIT 1'))) {
      const password =
        process.env.SENTRY_BOOTSTRAP_PASSWORD ||
        randomBytes(18).toString('base64url');
      const hash = await passwordHash(password);
      // 凭据只在首次初始化时生成，不覆盖现有账号密码。
      await writeFile(
        credentialsPath,
        JSON.stringify({ username: 'superadmin', password }, null, 2),
        { mode: 0o600, flag: 'w' },
      );
      await tx.run(
        'INSERT INTO admin_users VALUES($1,$2,$3,$4,$5,$6,$7)',
        randomUUID(),
        'superadmin',
        '超级管理员',
        hash,
        'superadmin',
        1,
        new Date().toISOString(),
      );
    }
  });
  function token(req) {
    return (
      String(req.headers.cookie || '')
        .split(';')
        .map((s) => s.trim())
        .find((s) => s.startsWith(cookieName + '='))
        ?.slice(cookieName.length + 1) || ''
    );
  }
  async function current(req, connection = db, lock = false) {
    const value = token(req);
    if (!/^[a-f0-9]{64}$/.test(value)) return null;
    return (
      (await connection.get(
        `SELECT u.* FROM admin_sessions s JOIN admin_users u ON u.id=s.user_id WHERE s.token_hash=$1 AND s.expires_at>$2 AND u.enabled=1` +
          (lock ? ' FOR UPDATE OF u' : ''),
        digest(value),
        Date.now(),
      )) || null
    );
  }
  const cookie = (value, maxAge) =>
    `${cookieName}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${process.env.SENTRY_SECURE_COOKIE === '1' ? '; Secure' : ''}`;
  async function handle(db, req, res, url, readBody, json) {
    const path = url.pathname;
    if (!path.startsWith('/api/auth/') && !path.startsWith('/api/admins'))
      return false;
    const input = async () => {
      if (
        !String(req.headers['content-type'] || '').startsWith(
          'application/json',
        )
      )
        throw invalid('请使用 JSON 请求。', 415);
      return JSON.parse(await readBody(req, 4096));
    };
    if (path === '/api/auth/login' && req.method === 'POST') {
      const value = await input();
      const username =
        typeof value.username === 'string'
          ? value.username.trim().toLowerCase().slice(0, 64)
          : '';
      await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
        'login:' + username,
      ]);
      const now = Date.now();
      await db.run('DELETE FROM admin_login_attempts WHERE reset_at<=$1', now);
      const attempts = await db.get(
        'SELECT * FROM admin_login_attempts WHERE username=$1',
        username,
      );
      if (attempts?.count >= 8)
        throw invalid('登录尝试过多，请 15 分钟后再试。', 429);
      const user = await db.get(
        'SELECT * FROM admin_users WHERE username=$1 FOR UPDATE',
        username,
      );
      const matches = await passwordMatches(
        value.password,
        user?.password_hash,
      );
      if (
        !matches ||
        !user?.enabled ||
        typeof value.password !== 'string' ||
        value.password.length > 128
      ) {
        await db.run(
          `INSERT INTO admin_login_attempts VALUES($1,1,$2) ON CONFLICT(username) DO UPDATE SET count=admin_login_attempts.count+1`,
          username,
          now + 15 * 60 * 1000,
        );
        json(res, { error: '账号或密码错误，或账号已停用。' }, 401);
        return true;
      }
      await db.run(
        'DELETE FROM admin_login_attempts WHERE username=$1',
        username,
      );
      await db.run('DELETE FROM admin_sessions WHERE expires_at<=$1', now);
      const session = randomBytes(32).toString('hex');
      await db.run(
        'INSERT INTO admin_sessions VALUES($1,$2,$3)',
        digest(session),
        user.id,
        now + 8 * 3600000,
      );
      res.setHeader('Set-Cookie', cookie(session, 8 * 3600));
      json(res, safeUser(user));
      return true;
    }
    const user = await current(req, db, req.method !== 'GET');
    if (!user) throw invalid('请先登录管理员账号。', 401);
    if (path === '/api/auth/me' && req.method === 'GET') {
      json(res, safeUser(user));
      return true;
    }
    if (path === '/api/auth/logout' && req.method === 'POST') {
      await db.run(
        'DELETE FROM admin_sessions WHERE token_hash=$1',
        digest(token(req)),
      );
      res.setHeader('Set-Cookie', cookie('', 0));
      json(res, { ok: true });
      return true;
    }
    if (path === '/api/auth/password' && req.method === 'POST') {
      const value = await input();
      if (!(await passwordMatches(value.currentPassword, user.password_hash)))
        throw invalid('当前密码不正确。');
      const hash = await passwordHash(value.password);
      await db.run(
        'UPDATE admin_users SET password_hash=$1 WHERE id=$2',
        hash,
        user.id,
      );
      await db.run('DELETE FROM admin_sessions WHERE user_id=$1', user.id);
      if (user.role === 'superadmin')
        await unlink(credentialsPath).catch(() => {});
      res.setHeader('Set-Cookie', cookie('', 0));
      json(res, { ok: true });
      return true;
    }
    if (path.startsWith('/api/admins')) {
      if (user.role !== 'superadmin')
        throw invalid('仅超级管理员可以管理账号。', 403);
      if (path === '/api/admins' && req.method === 'GET') {
        json(
          res,
          (
            await db.all(
              'SELECT * FROM admin_users ORDER BY role DESC,created_at',
            )
          ).map(safeUser),
        );
        return true;
      }
      if (path === '/api/admins' && req.method === 'POST') {
        const value = await input();
        const username =
          typeof value.username === 'string'
            ? value.username.trim().toLowerCase()
            : '';
        const name =
          typeof value.displayName === 'string' ? value.displayName.trim() : '';
        if (!/^[a-z0-9][a-z0-9_.-]{2,31}$/.test(username))
          throw invalid('账号需为 3–32 位字母、数字、下划线、点或短横线。');
        if (!name || name.length > 40)
          throw invalid('请填写 1–40 字的管理员姓名。');
        if (
          await db.get('SELECT id FROM admin_users WHERE username=$1', username)
        )
          throw invalid('该账号已存在。', 409);
        const hash = await passwordHash(value.password);
        const id = randomUUID();
        await db.run(
          'INSERT INTO admin_users VALUES($1,$2,$3,$4,$5,$6,$7)',
          id,
          username,
          name,
          hash,
          'admin',
          1,
          new Date().toISOString(),
        );
        json(
          res,
          safeUser(await db.get('SELECT * FROM admin_users WHERE id=$1', id)),
          201,
        );
        return true;
      }
      const match = path.match(/^\/api\/admins\/([a-f0-9-]+)$/);
      if (match && req.method === 'POST') {
        const target = await db.get(
          'SELECT * FROM admin_users WHERE id=$1 FOR UPDATE',
          match[1],
        );
        if (!target) throw invalid('管理员不存在。', 404);
        if (target.role === 'superadmin')
          throw invalid(
            '不能停用、删除或代重置超级管理员，请使用修改自己的密码。',
            403,
          );
        const value = await input();
        if (value.action === 'reset-password') {
          const hash = await passwordHash(value.password);
          await db.run(
            'UPDATE admin_users SET password_hash=$1 WHERE id=$2',
            hash,
            target.id,
          );
          await db.run(
            'DELETE FROM admin_login_attempts WHERE username=$1',
            target.username,
          );
        } else if (['enable', 'disable'].includes(value.action)) {
          await db.run(
            'UPDATE admin_users SET enabled=$1 WHERE id=$2',
            value.action === 'enable' ? 1 : 0,
            target.id,
          );
        } else if (value.action === 'delete') {
          await db.run('DELETE FROM admin_users WHERE id=$1', target.id);
        } else throw invalid('不支持的账号操作。');
        await db.run('DELETE FROM admin_sessions WHERE user_id=$1', target.id);
        json(res, { ok: true });
        return true;
      }
    }
    json(res, { error: '接口不存在' }, 404);
    return true;
  }
  return {
    current,
    handle: async (req, res, url, readBody, json) => {
      if (
        !url.pathname.startsWith('/api/auth/') &&
        !url.pathname.startsWith('/api/admins')
      )
        return false;
      if (!['POST', 'PUT', 'DELETE', 'PATCH'].includes(req.method))
        return handle(db, req, res, url, readBody, json);
      let response;
      const handled = await db.transaction(async (tx) => {
        if (
          url.pathname.startsWith('/api/admins') ||
          url.pathname === '/api/auth/password'
        ) {
          const state = await tx.get(
            'SELECT maintenance FROM dataset_state WHERE id=1 FOR SHARE',
          );
          if (state.maintenance)
            throw invalid('系统维护中，暂时停止写入。', 503);
        }
        return handle(tx, req, res, url, readBody, (...args) => {
          response = args;
        });
      });
      if (response) json(...response);
      return handled;
    },
  };
}
