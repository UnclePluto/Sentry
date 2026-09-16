import { mkdir, writeFile, chmod } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { resolve, join } from 'node:path';
const dir = resolve(process.argv[2] || 'data/postgres-secrets');
await mkdir(dir, { recursive: true, mode: 0o700 });
await chmod(dir, 0o700);
const admin = randomBytes(32).toString('base64url'),
  runtime = randomBytes(32).toString('base64url');
for (const [name, value] of Object.entries({
  postgres_password: admin,
  runtime_password: runtime,
  database_url: `postgres://sentry_app:${runtime}@postgres:5432/sentry`,
  migration_database_url: `postgres://postgres:${admin}@postgres:5432/sentry`,
}))
  await writeFile(join(dir, name), value + '\n', { mode: 0o444, flag: 'wx' });
console.log(
  '已生成私有凭据文件；父目录权限为 700；只读挂载指定凭据文件，不输出密码。',
);
