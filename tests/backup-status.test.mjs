import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

test('备份状态不能把 pgBackRest 退出码 0 的仓库错误当作成功', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'sentry-backup-status-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const executable = join(dir, 'pgbackrest');
  await writeFile(
    executable,
    '#!/usr/bin/env python3\nimport os\nprint(os.environ["SENTRY_TEST_INFO"])\n',
  );
  await chmod(executable, 0o700);
  for (const [stanzaCode, repoCode, expected] of [
    [0, 0, 0],
    [99, 99, 1],
    [0, 99, 1],
    [2, 0, 1],
  ]) {
    const result = spawnSync('python3', ['deploy/postgres/backup.py', 'info'], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: dir + ':' + process.env.PATH,
        SENTRY_BACKUP_LOCAL_REPO: '/rehearsal/contract',
        SENTRY_TEST_INFO: JSON.stringify([
          {
            status: { code: stanzaCode },
            repo: [{ status: { code: repoCode } }],
          },
        ]),
      },
    });
    assert.equal(result.status, expected, `stanza=${stanzaCode}, repo=${repoCode}`);
    if (expected) assert.equal(JSON.parse(result.stdout).ok, false);
  }
});
