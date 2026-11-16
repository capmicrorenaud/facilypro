import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
loadLocalEnv(path.join(root, 'data', 'local.env'));
const connectionString = process.env.DATABASE_URL;
if (!connectionString || connectionString === 'pglite:memory') {
  console.error('DATABASE_URL doit pointer vers PostgreSQL. Lancez d’abord la prévisualisation durable.');
  process.exit(1);
}

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const backupDir = path.join(root, 'data', 'backups', stamp);
fs.mkdirSync(backupDir, { recursive: true });
const client = new pg.Client({ connectionString });
await client.connect();
const tables = [
  'accounts', 'account_sessions', 'quotes', 'arce_dossiers', 'dossier_documents',
  'document_requests', 'document_access_log', 'rate_limits', 'company_profile',
  'callback_requests', 'outbound_emails'
];
const manifest = { createdAt: new Date().toISOString(), tables: {} };
for (const table of tables) {
  const columns = await client.query(
    `SELECT column_name, udt_name FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = $1 ORDER BY ordinal_position`,
    [table]
  );
  const rows = await client.query(`SELECT * FROM ${table}`);
  const encoded = rows.rows.map((row) => encodeRow(row, columns.rows));
  fs.writeFileSync(path.join(backupDir, `${table}.json`), JSON.stringify({ columns: columns.rows, rows: encoded }));
  manifest.tables[table] = encoded.length;
}
const keyPath = path.join(root, 'data', 'encryption.key');
if (fs.existsSync(keyPath)) fs.copyFileSync(keyPath, path.join(backupDir, 'encryption.key'));
fs.writeFileSync(path.join(backupDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
await client.end();
console.log(`Sauvegarde écrite : ${backupDir}`);
console.log(JSON.stringify(manifest.tables));

function encodeRow(row, columns) {
  const output = {};
  for (const column of columns) {
    output[column.column_name] = encodeValue(row[column.column_name], column.udt_name);
  }
  return output;
}

function encodeValue(value, udtName) {
  if (value === null || value === undefined) return null;
  if (udtName === 'bytea') return { type: 'bytea', hex: Buffer.from(value).toString('hex') };
  if (udtName === 'jsonb' || udtName === 'json') return { type: 'json', value };
  if (value instanceof Date) return { type: 'date', iso: value.toISOString() };
  return { type: 'scalar', value };
}

function loadLocalEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const separator = line.indexOf('=');
    if (separator === -1 || line.startsWith('#')) continue;
    const key = line.slice(0, separator);
    if (!process.env[key]) process.env[key] = line.slice(separator + 1);
  }
}
