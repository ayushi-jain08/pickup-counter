// One-command local dev: `npm run dev`
//
// 1. Installs backend/frontend dependencies if missing.
// 2. Starts PostgreSQL in Docker, unless DATABASE_URL is already set
//    (then your own Postgres is used and Docker is not needed).
// 3. Runs the backend (tsx watch, :3000) and frontend (Vite, :5173) together.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

function runOrExit(command, cwd) {
  const result = spawnSync(command, { cwd, shell: true, stdio: 'inherit' });
  if (result.status !== 0) {
    console.error(`\n"${command}" failed in ${cwd}`);
    process.exit(result.status ?? 1);
  }
}

for (const pkg of ['backend', 'frontend']) {
  if (!existsSync(join(root, pkg, 'node_modules'))) {
    console.log(`Installing ${pkg} dependencies…`);
    runOrExit('npm install --no-audit --no-fund', join(root, pkg));
  }
}

const env = { ...process.env };
if (!env.DATABASE_URL) {
  console.log('Starting PostgreSQL in Docker (set DATABASE_URL to use your own instead)…');
  runOrExit('docker compose up -d --wait db', root);
  env.DATABASE_URL = 'postgres://pickup:pickup@localhost:5433/pickup';
}
env.WEBHOOK_SECRET ??= 'dev-webhook-secret';

const children = [
  { name: 'backend', cwd: join(root, 'backend'), command: 'npm run dev' },
  { name: 'frontend', cwd: join(root, 'frontend'), command: 'npm run dev' },
].map(({ name, cwd, command }) => {
  const child = spawn(command, { cwd, env, shell: true, stdio: 'inherit' });
  child.on('exit', (code) => {
    console.log(`${name} exited (${code}), stopping everything`);
    shutdown(code ?? 1);
  });
  return child;
});

let stopping = false;
function shutdown(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) if (child.exitCode === null) child.kill();
  process.exit(code);
}
process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

console.log('\nCustomer screen: http://localhost:5173   API: http://localhost:3000\n');
