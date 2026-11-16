import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startLocalPostgres } from './local-postgres.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = path.join(root, 'data', 'postgres');
const postgresPort = Number(process.env.POSTGRES_PORT) || 54329;
const { url } = await startLocalPostgres({ dataDir, port: postgresPort });

const keyPath = path.join(root, 'data', 'encryption.key');
fs.mkdirSync(path.dirname(keyPath), { recursive: true });
if (!fs.existsSync(keyPath)) {
  fs.writeFileSync(keyPath, `${crypto.randomBytes(32).toString('hex')}\n`, { mode: 0o600 });
}
const encryptionKey = fs.readFileSync(keyPath, 'utf8').trim();

const appPort = process.env.PORT || '4242';
process.env.LISTEN = 'true';
process.env.PREVIEW = 'true';
process.env.PORT = appPort;
process.env.DATABASE_URL = url;
process.env.MAIL_CAPTURE = 'true';
process.env.PUBLIC_BASE_URL = `http://127.0.0.1:${appPort}`;
process.env.MAIL_FROM = 'Facile Pro <contact@facilepro.fr>';
process.env.BUSINESS_NAME = 'Facile Pro';
process.env.BUSINESS_EMAIL = 'contact@facilepro.fr';
process.env.BUSINESS_ADDRESS = 'Route de Belcastel, 12390 Mayran, France';
process.env.ADMIN_EMAILS = 'admin@exemple.test';
process.env.DOCUMENTS_UPLOAD_ENABLED = 'true';
process.env.DOCUMENTS_ENCRYPTION_KEY = encryptionKey;
process.env.CRON_SECRET = 'apercu-local-uniquement';

fs.writeFileSync(path.join(root, 'data', 'local.env'), [
  `DATABASE_URL=${url}`,
  `DOCUMENTS_ENCRYPTION_KEY=${encryptionKey}`,
  'MAIL_CAPTURE=true',
  `PUBLIC_BASE_URL=http://127.0.0.1:${appPort}`,
  'MAIL_FROM=Facile Pro <contact@facilepro.fr>',
  'BUSINESS_NAME=Facile Pro',
  'BUSINESS_EMAIL=contact@facilepro.fr',
  'BUSINESS_ADDRESS=Route de Belcastel, 12390 Mayran, France',
  'ADMIN_EMAILS=admin@exemple.test',
  'DOCUMENTS_UPLOAD_ENABLED=true',
  'CRON_SECRET=apercu-local-uniquement'
].join('\n'), { mode: 0o600 });

await import('../server.mjs');
console.log('PostgreSQL durable : data/postgres. Les dossiers restent après redémarrage.');
console.log('Emails réels : inactifs. Boîte locale durable : http://127.0.0.1:' + appPort + '/apercu-emails.html');
console.log('Sauvegarde : npm run backup');
console.log('Compte administrateur de cet aperçu : admin@exemple.test');
