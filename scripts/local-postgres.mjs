import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import EmbeddedPostgres from 'embedded-postgres';

export async function startLocalPostgres({ dataDir, port }) {
  fs.mkdirSync(dataDir, { recursive: true });
  const clusterDir = path.join(dataDir, 'cluster');
  const passwordPath = path.join(dataDir, 'password.txt');
  const clusterExists = fs.existsSync(path.join(clusterDir, 'PG_VERSION'));
  const password = clusterExists
    ? fs.readFileSync(passwordPath, 'utf8').trim()
    : crypto.randomBytes(18).toString('hex');
  if (!clusterExists) fs.writeFileSync(passwordPath, `${password}\n`, { mode: 0o600 });

  const embedded = new EmbeddedPostgres({
    databaseDir: clusterDir,
    user: 'facilepro',
    password,
    port,
    persistent: true,
    autoRehydrateSymlinks: true,
    initdbFlags: ['--encoding=UTF8', '--locale=C']
  });
  if (!clusterExists) await embedded.initialise();
  await embedded.start();
  try {
    await embedded.createDatabase('facilepro');
  } catch (error) {
    if (!/already exists/i.test(String(error?.message || error))) throw error;
  }
  const url = `postgresql://facilepro:${encodeURIComponent(password)}@127.0.0.1:${port}/facilepro`;
  return { embedded, url, clusterDir };
}

export function stopEmbeddedPostgresProcesses() {
  if (process.platform !== 'win32') return Promise.resolve();
  const script = "Get-CimInstance Win32_Process -Filter \"Name = 'postgres.exe' OR Name = 'initdb.exe'\" | Where-Object { $_.CommandLine -like '*@embedded-postgres*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }";
  return new Promise((resolve) => {
    const child = spawn('powershell', ['-NoProfile', '-Command', script], { stdio: 'ignore' });
    const timer = setTimeout(resolve, 8000);
    child.on('exit', () => { clearTimeout(timer); resolve(); });
  });
}

export async function stopLocalPostgres(started) {
  if (!started?.embedded) return;
  const pid = started.embedded.process?.pid;
  const ctl = pgCtlPath();
  await new Promise((resolve) => {
    const child = fs.existsSync(ctl) && started.clusterDir
      ? spawn(ctl, ['-D', started.clusterDir, 'stop', '-m', 'fast', '-w'], { stdio: 'ignore' })
      : spawn('taskkill', ['/pid', String(pid || 0), '/f', '/t'], { stdio: 'ignore' });
    const timer = setTimeout(() => {
      if (pid) spawn('taskkill', ['/pid', String(pid), '/f', '/t'], { stdio: 'ignore' });
      resolve();
    }, 12000);
    child.on('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
  started.embedded.process = undefined;
}

function pgCtlPath() {
  const binary = process.platform === 'win32' ? 'pg_ctl.exe' : 'pg_ctl';
  const folder = process.platform === 'win32' ? 'windows-x64' : `${process.platform}-${process.arch}`;
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'node_modules', '@embedded-postgres', folder, 'native', 'bin', binary);
}
