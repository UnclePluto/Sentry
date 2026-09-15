import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test(
  '管理员登录、权限隔离、账号停用/重置/删除、会话撤销与超管保护',
  { timeout: 40000 },
  async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sentry-auth-'));
    const child = spawn(process.execPath, ['server/index.mjs'], {
      env: {
        ...process.env,
        API_PORT: '3098',
        SENTRY_DATA_DIR: dir,
        SENTRY_NO_DEMO: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let superCookie = '',
      adminCookie = '';
    async function request(path, cookie = '', data) {
      const res = await fetch('http://127.0.0.1:3098/api' + path, {
        method: data ? 'POST' : 'GET',
        headers: {
          cookie,
          ...(data ? { 'Content-Type': 'application/json' } : {}),
        },
        body: data ? JSON.stringify(data) : undefined,
      });
      return {
        status: res.status,
        data: await res.json(),
        cookie: res.headers.get('set-cookie'),
      };
    }
    try {
      await new Promise((resolve, reject) => {
        child.stdout.once('data', resolve);
        child.once('error', reject);
        child.once('exit', () => reject(new Error('认证测试服务未启动')));
      });
      const credentials = JSON.parse(
        await readFile(join(dir, 'initial-admin.json'), 'utf8'),
      );
      assert.equal((await request('/imports')).status, 401);
      assert.equal((await request('/institutions', '', {})).status, 401);
      assert.equal((await request('/dashboard?demo=0')).status, 200);
      assert.equal(
        (
          await request('/auth/login', '', {
            ...credentials,
            password: 'wrong-password',
          })
        ).status,
        401,
      );
      const login = await request('/auth/login', '', credentials);
      assert.equal(login.status, 200);
      assert.match(login.cookie, /HttpOnly/);
      assert.match(login.cookie, /SameSite=Strict/);
      superCookie = login.cookie.split(';')[0];
      const superId = login.data.id;
      assert.equal(login.data.role, 'superadmin');
      assert.equal(login.data.password_hash, undefined);
      const created = await request('/admins', superCookie, {
        username: 'doctor01',
        displayName: '测试管理员',
        password: 'Doctor-Initial-12345',
        role: 'superadmin',
      });
      assert.equal(created.status, 201);
      assert.equal(created.data.role, 'admin');
      assert.equal(
        (
          await request('/admins', superCookie, {
            username: 'doctor01',
            displayName: '重复',
            password: 'Doctor-Initial-12345',
          })
        ).status,
        409,
      );
      const adminLogin = await request('/auth/login', '', {
        username: 'doctor01',
        password: 'Doctor-Initial-12345',
      });
      adminCookie = adminLogin.cookie.split(';')[0];
      assert.equal((await request('/imports', adminCookie)).status, 200);
      assert.equal((await request('/admins', adminCookie)).status, 403);
      assert.equal(
        (
          await request('/admins', adminCookie, {
            username: 'hacked',
            displayName: '越权',
            password: 'Doctor-Initial-12345',
          })
        ).status,
        403,
      );
      assert.equal(
        (await request('/admins/' + superId, superCookie, { action: 'delete' }))
          .status,
        403,
      );
      await request('/admins/' + created.data.id, superCookie, {
        action: 'disable',
      });
      assert.equal((await request('/auth/me', adminCookie)).status, 401);
      assert.equal(
        (
          await request('/auth/login', '', {
            username: 'doctor01',
            password: 'Doctor-Initial-12345',
          })
        ).status,
        401,
      );
      await request('/admins/' + created.data.id, superCookie, {
        action: 'enable',
      });
      adminCookie = (
        await request('/auth/login', '', {
          username: 'doctor01',
          password: 'Doctor-Initial-12345',
        })
      ).cookie.split(';')[0];
      await request('/admins/' + created.data.id, superCookie, {
        action: 'reset-password',
        password: 'Doctor-Changed-12345',
      });
      assert.equal((await request('/imports', adminCookie)).status, 401);
      assert.equal(
        (
          await request('/auth/login', '', {
            username: 'doctor01',
            password: 'Doctor-Initial-12345',
          })
        ).status,
        401,
      );
      adminCookie = (
        await request('/auth/login', '', {
          username: 'doctor01',
          password: 'Doctor-Changed-12345',
        })
      ).cookie.split(';')[0];
      await request('/admins/' + created.data.id, superCookie, {
        action: 'delete',
      });
      assert.equal((await request('/auth/me', adminCookie)).status, 401);
      const csrf = await fetch('http://127.0.0.1:3098/api/auth/logout', {
        method: 'POST',
        headers: { cookie: superCookie, origin: 'http://evil.example' },
      });
      assert.equal(csrf.status, 403);
      assert.equal(
        (
          await request('/auth/password', superCookie, {
            currentPassword: 'wrong-password',
            password: 'Super-New-12345678',
          })
        ).status,
        400,
      );
      assert.equal(
        (
          await request('/auth/password', superCookie, {
            currentPassword: credentials.password,
            password: 'Super-New-12345678',
          })
        ).status,
        200,
      );
      assert.equal((await request('/admins', superCookie)).status, 401);
      await assert.rejects(access(join(dir, 'initial-admin.json')));
      const again = await request('/auth/login', '', {
        username: credentials.username,
        password: 'Super-New-12345678',
      });
      assert.equal(again.status, 200);
      superCookie = again.cookie.split(';')[0];
      await request('/auth/logout', superCookie, {});
      assert.equal((await request('/auth/me', superCookie)).status, 401);
      for (let i = 0; i < 8; i++)
        await request('/auth/login', '', {
          username: 'missinguser',
          password: 'wrong-password',
        });
      assert.equal(
        (
          await request('/auth/login', '', {
            username: 'missinguser',
            password: 'wrong-password',
          })
        ).status,
        429,
      );
    } finally {
      if (child.exitCode === null)
        await new Promise((resolve) => {
          child.once('exit', resolve);
          child.kill('SIGTERM');
        });
      await rm(dir, { recursive: true, force: true });
    }
  },
);
