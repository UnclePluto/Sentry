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
  db.exec(`CREATE TABLE IF NOT EXISTS admin_users (
    id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE COLLATE NOCASE, display_name TEXT NOT NULL,
    password_hash TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('superadmin','admin')),
    enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)), created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS admin_sessions (
    token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_admin_sessions_user ON admin_sessions(user_id);
  CREATE TABLE IF NOT EXISTS admin_login_attempts (username TEXT PRIMARY KEY, count INTEGER NOT NULL, reset_at INTEGER NOT NULL);`);
  const credentialsPath = join(dataDir, 'initial-admin.json');
  if (!db.prepare('SELECT id FROM admin_users LIMIT 1').get()) {
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
    db.prepare('INSERT INTO admin_users VALUES(?,?,?,?,?,?,?)').run(
      randomUUID(),
      'superadmin',
      '超级管理员',
      hash,
      'superadmin',
      1,
      new Date().toISOString(),
    );
  }
  function token(req) {
    return (
      String(req.headers.cookie || '')
        .split(';')
        .map((s) => s.trim())
        .find((s) => s.startsWith(cookieName + '='))
        ?.slice(cookieName.length + 1) || ''
    );
  }
  function current(req) {
    const value = token(req);
    if (!/^[a-f0-9]{64}$/.test(value)) return null;
    return (
      db
        .prepare(
          `SELECT u.* FROM admin_sessions s JOIN admin_users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires_at>? AND u.enabled=1`,
        )
        .get(digest(value), Date.now()) || null
    );
  }
  const cookie = (value, maxAge) =>
    `${cookieName}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${process.env.SENTRY_SECURE_COOKIE === '1' ? '; Secure' : ''}`;
  async function handle(req, res, url, readBody, json) {
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
      const now = Date.now();
      db.prepare('DELETE FROM admin_login_attempts WHERE reset_at<=?').run(now);
      const attempts = db
        .prepare('SELECT * FROM admin_login_attempts WHERE username=?')
        .get(username);
      if (attempts?.count >= 8)
        throw invalid('登录尝试过多，请 15 分钟后再试。', 429);
      const user = db
        .prepare('SELECT * FROM admin_users WHERE username=?')
        .get(username);
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
        db.prepare(
          `INSERT INTO admin_login_attempts VALUES(?,1,?) ON CONFLICT(username) DO UPDATE SET count=count+1`,
        ).run(username, now + 15 * 60 * 1000);
        throw invalid('账号或密码错误，或账号已停用。', 401);
      }
      db.prepare('DELETE FROM admin_login_attempts WHERE username=?').run(
        username,
      );
      db.prepare('DELETE FROM admin_sessions WHERE expires_at<=?').run(now);
      const session = randomBytes(32).toString('hex');
      db.prepare('INSERT INTO admin_sessions VALUES(?,?,?)').run(
        digest(session),
        user.id,
        now + 8 * 3600000,
      );
      res.setHeader('Set-Cookie', cookie(session, 8 * 3600));
      json(res, safeUser(user));
      return true;
    }
    const user = current(req);
    if (!user) throw invalid('请先登录管理员账号。', 401);
    if (path === '/api/auth/me' && req.method === 'GET') {
      json(res, safeUser(user));
      return true;
    }
    if (path === '/api/auth/logout' && req.method === 'POST') {
      db.prepare('DELETE FROM admin_sessions WHERE token_hash=?').run(
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
      db.prepare('UPDATE admin_users SET password_hash=? WHERE id=?').run(
        hash,
        user.id,
      );
      db.prepare('DELETE FROM admin_sessions WHERE user_id=?').run(user.id);
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
          db
            .prepare('SELECT * FROM admin_users ORDER BY role DESC,created_at')
            .all()
            .map(safeUser),
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
          db
            .prepare('SELECT id FROM admin_users WHERE username=?')
            .get(username)
        )
          throw invalid('该账号已存在。', 409);
        const hash = await passwordHash(value.password);
        const id = randomUUID();
        db.prepare('INSERT INTO admin_users VALUES(?,?,?,?,?,?,?)').run(
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
          safeUser(db.prepare('SELECT * FROM admin_users WHERE id=?').get(id)),
          201,
        );
        return true;
      }
      const match = path.match(/^\/api\/admins\/([a-f0-9-]+)$/);
      if (match && req.method === 'POST') {
        const target = db
          .prepare('SELECT * FROM admin_users WHERE id=?')
          .get(match[1]);
        if (!target) throw invalid('管理员不存在。', 404);
        if (target.role === 'superadmin')
          throw invalid(
            '不能停用、删除或代重置超级管理员，请使用修改自己的密码。',
            403,
          );
        const value = await input();
        if (value.action === 'reset-password') {
          const hash = await passwordHash(value.password);
          db.prepare('UPDATE admin_users SET password_hash=? WHERE id=?').run(
            hash,
            target.id,
          );
          db.prepare('DELETE FROM admin_login_attempts WHERE username=?').run(
            target.username,
          );
        } else if (['enable', 'disable'].includes(value.action)) {
          db.prepare('UPDATE admin_users SET enabled=? WHERE id=?').run(
            value.action === 'enable' ? 1 : 0,
            target.id,
          );
        } else if (value.action === 'delete') {
          db.prepare('DELETE FROM admin_users WHERE id=?').run(target.id);
        } else throw invalid('不支持的账号操作。');
        db.prepare('DELETE FROM admin_sessions WHERE user_id=?').run(target.id);
        json(res, { ok: true });
        return true;
      }
    }
    json(res, { error: '接口不存在' }, 404);
    return true;
  }
  return { current, handle };
}
