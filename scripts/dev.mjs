import { spawn } from 'node:child_process';
const production = process.argv.includes('--production');
const frontend = production
  ? ['start', '--hostname', '127.0.0.1']
  : ['dev', '--hostname', '127.0.0.1'];
const children = [
  spawn(process.execPath, ['--env-file-if-exists=.env', 'server/index.mjs'], {
    stdio: 'inherit',
  }),
  spawn(
    process.execPath,
    ['node_modules/vinext/dist/cli.js', ...frontend, '--port', '3010'],
    { stdio: 'inherit' },
  ),
  spawn(
    process.execPath,
    ['server/gateway.mjs', ...(production ? ['--production'] : [])],
    { stdio: 'inherit' },
  ),
];
let closing = false;
function close(code = 0) {
  if (closing) return;
  closing = true;
  for (const child of children) child.kill('SIGTERM');
  setTimeout(() => process.exit(code), 500).unref();
}
for (const child of children) {
  child.on('exit', (code) => close(code || 0));
  child.on('error', (error) => {
    console.error(error.message);
    close(1);
  });
}
process.on('SIGINT', () => close());
process.on('SIGTERM', () => close());
