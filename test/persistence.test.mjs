import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startLocalPostgres, stopEmbeddedPostgresProcesses, stopLocalPostgres } from '../scripts/local-postgres.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const key = '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff';
const clusters = [];
const servers = [];

function pngSignature() {
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64'
  );
  return `data:image/png;base64,${png.toString('base64')}`;
}

function startServer(port, databaseUrl) {
  const child = spawn(process.execPath, ['server.mjs'], {
    cwd: root,
    env: {
      ...process.env,
      LISTEN: 'true',
      PORT: String(port),
      DATABASE_URL: databaseUrl,
      MAIL_CAPTURE: 'true',
      PREVIEW: 'true',
      PUBLIC_BASE_URL: `http://127.0.0.1:${port}`,
      MAIL_FROM: 'Facile Pro <contact@facilepro.fr>',
      BUSINESS_NAME: 'Facile Pro',
      BUSINESS_EMAIL: 'contact@facilepro.fr',
      BUSINESS_ADDRESS: 'Route de Belcastel, 12390 Mayran, France',
      ADMIN_EMAILS: 'admin@exemple.test',
      DOCUMENTS_UPLOAD_ENABLED: 'true',
      DOCUMENTS_ENCRYPTION_KEY: key,
      CRON_SECRET: 'secret-de-test'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  servers.push(child);
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(output || 'Démarrage trop long')), 40000);
    const done = { settled: false };
    const finish = (error) => {
      if (done.settled) return;
      done.settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(child);
    };
    const check = () => {
      if (output.includes('Facile Pro est disponible')) finish();
    };
    child.stdout.on('data', check);
    child.stderr.on('data', check);
    child.on('exit', (code) => finish(new Error(`Serveur arrêté (${code})\n${output}`)));
  });
}

function stopServer(child) {
  return new Promise((resolve) => {
    if (!child || child.exitCode !== null) return resolve();
    const timer = setTimeout(resolve, 5000);
    child.once('exit', () => { clearTimeout(timer); resolve(); });
    child.kill();
  });
}

async function request(port, urlPath, { method = 'GET', cookie = '', body, raw } = {}) {
  const headers = {};
  if (cookie) headers.cookie = cookie;
  if (body) headers['content-type'] = 'application/json';
  if (raw) headers['content-type'] = 'application/octet-stream';
  const response = await fetch(`http://127.0.0.1:${port}${urlPath}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : raw
  });
  const setCookie = response.headers.getSetCookie?.().map((value) => value.split(';')[0]).join('; ') || '';
  const text = await response.text();
  let payload = text;
  try { payload = text ? JSON.parse(text) : null; } catch { /* fichier binaire */ }
  return { status: response.status, payload, cookie: setCookie || cookie, text };
}

test('les dossiers PostgreSQL survivent au redémarrage, à la sauvegarde, et restent isolés', { timeout: 240000 }, async () => {
  const dirA = path.join(root, 'data', 'persistence-a');
  const dirB = path.join(root, 'data', 'persistence-b');
  await stopEmbeddedPostgresProcesses();
  fs.rmSync(dirA, { recursive: true, force: true });
  fs.rmSync(dirB, { recursive: true, force: true });
  const postgresA = await startLocalPostgres({ dataDir: dirA, port: 54340 });
  clusters.push(postgresA);
  let server = await startServer(4277, postgresA.url);
  const ready = await request(4277, '/api/ready');
  assert.equal(ready.payload.persistentDatabase, true);
  assert.equal(ready.payload.emailDelivery, false);
  assert.equal(ready.payload.readyForRealClients, false);

  const registration = await request(4277, '/api/account/register', {
    method: 'POST',
    body: { email: 'camille.durable@exemple.test', password: 'motdepasse-test-12' }
  });
  assert.equal(registration.status, 200, JSON.stringify(registration.payload));
  assert.equal(registration.payload.emailDelivered, false);
  const mailbox = await request(4277, '/api/preview/mailbox');
  assert.equal(mailbox.payload.durable, true);
  const token = mailbox.payload.messages.at(-1).text.match(/verify-email=([0-9a-f]{64})/)[1];
  const verification = await request(4277, '/api/account/verify-email', { method: 'POST', body: { token } });
  const cookie = verification.cookie;
  await request(4277, '/api/account/dossier', {
    method: 'PUT',
    cookie,
    body: { remainingDays: 100, dailyAllowance: '50', referenceDate: '2026-12-05' }
  });
  const upload = await request(4277, '/api/account/documents?kind=identite', {
    method: 'POST',
    cookie,
    raw: Buffer.from('%PDF-1.4\npersistance\n%%EOF')
  });
  assert.equal(upload.status, 200, JSON.stringify(upload.payload));
  const signed = await request(4277, '/api/quotes', {
    method: 'POST',
    cookie,
    body: {
      clientName: 'Camille Durable',
      clientEmail: 'camille.durable@exemple.test',
      service: 'Accompagnement ARCE',
      aidAmount: '10000',
      signature: pngSignature()
    }
  });
  assert.equal(signed.payload.paymentStarted, false);
  assert.equal(signed.payload.quote.commissionCents, 120000);
  const other = await request(4277, '/api/account/register', {
    method: 'POST',
    body: { email: 'autre.client@exemple.test', password: 'motdepasse-test-12' }
  });
  assert.equal(other.status, 200);
  const otherToken = (await request(4277, '/api/preview/mailbox')).payload.messages.at(-1).text.match(/verify-email=([0-9a-f]{64})/)[1];
  const otherSession = await request(4277, '/api/account/verify-email', { method: 'POST', body: { token: otherToken } });
  const denied = await request(4277, `/api/account/documents/${upload.payload.id}`, { cookie: otherSession.cookie });
  assert.equal(denied.status, 404);

  await stopServer(server);
  await stopLocalPostgres(postgresA);
  const restartedPostgres = await startLocalPostgres({ dataDir: dirA, port: 54340 });
  clusters.push(restartedPostgres);
  server = await startServer(4277, restartedPostgres.url);
  const login = await request(4277, '/api/account/login', {
    method: 'POST',
    body: { email: 'camille.durable@exemple.test', password: 'motdepasse-test-12' }
  });
  assert.equal(login.status, 200);
  const quotes = await request(4277, '/api/account/quotes', { cookie: login.cookie });
  assert.equal(quotes.payload.quotes[0].commissionCents, 120000);
  assert.equal(quotes.payload.quotes[0].secondInstallmentCommissionCents, 0);
  const dossier = await request(4277, '/api/account/dossier', { cookie: login.cookie });
  assert.equal(dossier.payload.dossier.remainingDays, 100);
  const download = await request(4277, `/api/account/documents/${upload.payload.id}`, { cookie: login.cookie });
  assert.equal(download.status, 200);
  assert.match(download.text, /persistance/);
  const emails = await request(4277, '/api/preview/mailbox');
  assert.ok(emails.payload.messages.some((message) => message.to === 'camille.durable@exemple.test'));
  const stillDenied = await request(4277, `/api/account/documents/${upload.payload.id}`, { cookie: otherSession.cookie });
  assert.equal(stillDenied.status, 404);

  const adminRegistration = await request(4277, '/api/account/register', {
    method: 'POST',
    body: { email: 'admin@exemple.test', password: 'motdepasse-test-12' }
  });
  assert.equal(adminRegistration.status, 200);
  const adminToken = (await request(4277, '/api/preview/mailbox')).payload.messages.at(-1).text.match(/verify-email=([0-9a-f]{64})/)[1];
  const adminSession = await request(4277, '/api/account/verify-email', { method: 'POST', body: { token: adminToken } });
  await request(4277, '/api/admin/code/request', { method: 'POST', cookie: adminSession.cookie });
  const code = (await request(4277, '/api/preview/mailbox')).payload.messages.at(-1).text.match(/(\d{6})/)[1];
  const codeCheck = await request(4277, '/api/admin/code/verify', {
    method: 'POST',
    cookie: adminSession.cookie,
    body: { code }
  });
  assert.equal(codeCheck.status, 200);
  const adminQuotes = await request(4277, '/api/admin/quotes', { cookie: adminSession.cookie });
  const quoteId = adminQuotes.payload.quotes[0].id;
  const refused = await request(4277, `/api/admin/quotes/${quoteId}/confirm-settlement`, {
    method: 'POST',
    cookie: adminSession.cookie,
    body: { firstArceInstallmentReceived: false }
  });
  assert.equal(refused.status, 400);
  const blocked = await request(4277, `/api/admin/quotes/${quoteId}/confirm-settlement`, {
    method: 'POST',
    cookie: adminSession.cookie,
    body: { firstArceInstallmentReceived: true }
  });
  assert.equal(blocked.status, 200);
  assert.equal(blocked.payload.documentsIssued, false);
  assert.equal(blocked.payload.quote.commissionCents, 120000);
  assert.equal(blocked.payload.quote.secondInstallmentCommissionCents, 0);
  assert.ok(blocked.payload.missingOfficialFields.includes('SIREN'));
  const suivi = await request(4277, '/api/admin/suivi', { cookie: adminSession.cookie });
  assert.ok(suivi.payload.quotes.some((quote) => quote.paymentStatus === 'reglement_unique_confirme'));

  const backup = spawn(process.execPath, ['scripts/backup.mjs'], {
    cwd: root,
    env: { ...process.env, DATABASE_URL: restartedPostgres.url },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const backupOutput = await new Promise((resolve, reject) => {
    let text = '';
    backup.stdout.on('data', (chunk) => { text += chunk; });
    backup.stderr.on('data', (chunk) => { text += chunk; });
    backup.on('exit', (code) => (code === 0 ? resolve(text) : reject(new Error(text))));
  });
  const backupDir = backupOutput.match(/Sauvegarde écrite : (.+)/)[1].trim();
  assert.match(fs.readFileSync(path.join(backupDir, 'accounts.json'), 'utf8'), /camille.durable@exemple.test/);

  await stopServer(server);
  const postgresB = await startLocalPostgres({ dataDir: dirB, port: 54341 });
  clusters.push(postgresB);
  const schemaServer = await startServer(4278, postgresB.url);
  await stopServer(schemaServer);
  const restore = spawn(process.execPath, ['scripts/restore.mjs', backupDir], {
    cwd: root,
    env: { ...process.env, DATABASE_URL: postgresB.url },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const restoreOutput = await new Promise((resolve, reject) => {
    let text = '';
    restore.stdout.on('data', (chunk) => { text += chunk; });
    restore.stderr.on('data', (chunk) => { text += chunk; });
    restore.on('exit', (code) => (code === 0 ? resolve(text) : reject(new Error(text))));
  });
  assert.match(restoreOutput, /Restauration terminée/);
  server = await startServer(4278, postgresB.url);
  const restoredLogin = await request(4278, '/api/account/login', {
    method: 'POST',
    body: { email: 'camille.durable@exemple.test', password: 'motdepasse-test-12' }
  });
  assert.equal(restoredLogin.status, 200, JSON.stringify(restoredLogin.payload));
  const restoredFile = await request(4278, `/api/account/documents/${upload.payload.id}`, { cookie: restoredLogin.cookie });
  assert.match(restoredFile.text, /persistance/);
  const restoredOther = await request(4278, '/api/account/login', {
    method: 'POST',
    body: { email: 'autre.client@exemple.test', password: 'motdepasse-test-12' }
  });
  const restoredDenied = await request(4278, `/api/account/documents/${upload.payload.id}`, { cookie: restoredOther.cookie });
  assert.equal(restoredDenied.status, 404);
});

test.after(async () => {
  await Promise.all(servers.map((server) => stopServer(server)));
  for (const cluster of clusters) {
    try { await stopLocalPostgres(cluster); } catch { /* déjà arrêté */ }
  }
  await stopEmbeddedPostgresProcesses();
});
