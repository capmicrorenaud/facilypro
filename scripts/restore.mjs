import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const backupDir = process.argv[2];
const connectionString = process.env.DATABASE_URL;
if (!backupDir || !connectionString) {
  console.error('Usage : DATABASE_URL=... node scripts/restore.mjs <dossier-de-sauvegarde>');
  process.exit(1);
}
const manifest = JSON.parse(fs.readFileSync(path.join(backupDir, 'manifest.json'), 'utf8'));
const client = new pg.Client({ connectionString });
await client.connect();
const tables = Object.keys(manifest.tables);
await client.query('BEGIN');
await client.query(`TRUNCATE ${tables.join(', ')} RESTART IDENTITY CASCADE`);
for (const table of tables) {
  const file = JSON.parse(fs.readFileSync(path.join(backupDir, `${table}.json`), 'utf8'));
  for (const row of file.rows) {
    const columns = file.columns.map((column) => column.column_name);
    const values = file.columns.map((column) => decodeValue(row[column.column_name]));
    const placeholders = columns.map((_, index) => `$${index + 1}`);
    await client.query(
      `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${placeholders.join(', ')})`,
      values
    );
  }
}
const serials = await client.query(`
  SELECT table_name, column_name,
         pg_get_serial_sequence(format('%I.%I', table_schema, table_name), column_name) AS sequence_name
  FROM information_schema.columns
  WHERE table_schema = 'public' AND column_default LIKE 'nextval(%'
`);
for (const row of serials.rows) {
  if (!row.sequence_name || !/^[a-z_][a-z0-9_]*$/.test(row.table_name) || !/^[a-z_][a-z0-9_]*$/.test(row.column_name)) continue;
  await client.query(
    `SELECT setval($1::regclass, GREATEST(COALESCE((SELECT MAX("${row.column_name}") FROM "${row.table_name}"), 1), 1),
      EXISTS (SELECT 1 FROM "${row.table_name}"))`
  , [row.sequence_name]);
}
await client.query('COMMIT');
await client.end();
restoreEncryptionKey(backupDir);
console.log(`Restauration terminée depuis ${backupDir}`);

function restoreEncryptionKey(dir) {
  const source = path.join(dir, 'encryption.key');
  const destination = path.join(root, 'data', 'encryption.key');
  if (!fs.existsSync(source)) return;
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  if (!fs.existsSync(destination)) {
    fs.copyFileSync(source, destination);
    console.log('Clé de chiffrement restaurée dans data/encryption.key');
    return;
  }
  const same = fs.readFileSync(source).equals(fs.readFileSync(destination));
  console.log(same
    ? 'Clé de chiffrement identique à celle déjà présente.'
    : 'La sauvegarde contient une autre clé. data/encryption.key n’a pas été remplacée.');
}

function decodeValue(value) {
  if (!value || typeof value !== 'object' || !value.type) return value;
  if (value.type === 'bytea') return Buffer.from(value.hex, 'hex');
  if (value.type === 'json') return value.value;
  if (value.type === 'date') return value.iso;
  return value.value;
}
