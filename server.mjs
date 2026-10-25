import 'dotenv/config';
import crypto from 'node:crypto';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import express from 'express';
import rateLimit from 'express-rate-limit';
import nodemailer from 'nodemailer';
import PDFDocument from 'pdfkit';
import pg from 'pg';
import Stripe from 'stripe';

const directory = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT) || 4242;
const baseUrl = (process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, '');
const requiredSettings = [
  'PUBLIC_BASE_URL',
  'STRIPE_SECRET_KEY',
  'STRIPE_WEBHOOK_SECRET',
  'SMTP_HOST',
  'SMTP_PORT',
  'SMTP_USER',
  'SMTP_PASS',
  'MAIL_FROM',
  'BUSINESS_NAME',
  'BUSINESS_EMAIL',
  'BUSINESS_SIRET',
  'BUSINESS_ADDRESS',
  'DATABASE_URL'
];
const missingSettings = requiredSettings.filter((setting) => !process.env[setting]);

// Sans configuration complète, la page publique reste servie et les API répondent 503
// au lieu d'arrêter le processus (un arrêt fait échouer la fonction sur Vercel).
if (missingSettings.length) {
  console.error(`Configuration manquante : ${missingSettings.join(', ')}`);
}
if (baseUrl && !/^https?:\/\//i.test(baseUrl)) {
  console.error('PUBLIC_BASE_URL doit être une URL http(s) valide.');
}
const configured = missingSettings.length === 0 && /^https?:\/\//i.test(baseUrl);

// Dépôt de pièces justificatives : désactivé tant que DOCUMENTS_UPLOAD_ENABLED n'est pas « true »
// et qu'une clé de chiffrement valide (64 caractères hexadécimaux) n'est pas fournie.
const documentsKey = /^[0-9a-f]{64}$/i.test(process.env.DOCUMENTS_ENCRYPTION_KEY || '')
  ? Buffer.from(process.env.DOCUMENTS_ENCRYPTION_KEY, 'hex')
  : null;
const uploadsEnabled = process.env.DOCUMENTS_UPLOAD_ENABLED === 'true' && Boolean(documentsKey);
if (process.env.DOCUMENTS_UPLOAD_ENABLED === 'true' && !documentsKey) {
  console.error('DOCUMENTS_ENCRYPTION_KEY absente ou invalide : dépôt de documents désactivé.');
}
const retentionDays = Math.min(Math.max(Number(process.env.DOCUMENTS_RETENTION_DAYS) || 90, 1), 365);
const adminEmails = new Set((process.env.ADMIN_EMAILS || '').split(',').map((email) => email.trim().toLowerCase()).filter(Boolean));
const maxDocumentBytes = 4 * 1024 * 1024;
const documentKinds = {
  identite: 'Pièce d’identité',
  attestation_france_travail: 'Attestation de droits France Travail',
  reliquat_are: 'Justificatif du reliquat ARE'
};

const stripe = configured ? new Stripe(process.env.STRIPE_SECRET_KEY) : null;
const { Pool } = pg;
const accountPool = process.env.DATABASE_URL ? new Pool({ connectionString: process.env.DATABASE_URL }) : null;
const mailer = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: Number(process.env.SMTP_PORT),
  secure: process.env.SMTP_SECURE === 'true',
  auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
});
const app = express();
const processing = new Set();
const scrypt = promisify(crypto.scrypt);
const sessionLifetimeSeconds = 60 * 60 * 24 * 30;
let accountStoreReady = false;
let accountStoreError = null;

// Compteurs anti-abus stockés dans PostgreSQL : sur Vercel, chaque instance a sa propre mémoire,
// un compteur en mémoire serait donc contournable en multipliant les requêtes.
class PostgresRateLimitStore {
  constructor(prefix) {
    this.prefix = prefix;
  }

  init(options) {
    this.windowSeconds = options.windowMs / 1000;
  }

  async increment(key) {
    const result = await accountPool.query(
      `INSERT INTO rate_limits (key, hits, reset_at) VALUES ($1, 1, NOW() + make_interval(secs => $2))
       ON CONFLICT (key) DO UPDATE SET
         hits = CASE WHEN rate_limits.reset_at <= NOW() THEN 1 ELSE rate_limits.hits + 1 END,
         reset_at = CASE WHEN rate_limits.reset_at <= NOW() THEN EXCLUDED.reset_at ELSE rate_limits.reset_at END
       RETURNING hits, reset_at`,
      [`${this.prefix}:${key}`, this.windowSeconds]
    );
    return { totalHits: result.rows[0].hits, resetTime: result.rows[0].reset_at };
  }

  async decrement(key) {
    await accountPool.query('UPDATE rate_limits SET hits = GREATEST(hits - 1, 0) WHERE key = $1', [`${this.prefix}:${key}`]);
  }

  async resetKey(key) {
    await accountPool.query('DELETE FROM rate_limits WHERE key = $1', [`${this.prefix}:${key}`]);
  }
}

function makeRateLimit(prefix, limit, message) {
  return rateLimit({
    windowMs: 15 * 60 * 1000,
    limit,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    store: accountPool ? new PostgresRateLimitStore(prefix) : undefined,
    passOnStoreError: true,
    handler: (_request, response) => response.status(429).json({ error: message })
  });
}

const accountRateLimit = makeRateLimit('account', 10, 'Trop de tentatives. Réessayez dans quelques minutes.');
const formRateLimit = makeRateLimit('form', 8, 'Trop de demandes. Réessayez dans quelques minutes.');
const documentRateLimit = makeRateLimit('document', 30, 'Trop de demandes. Réessayez dans quelques minutes.');
const adminCodeRateLimit = makeRateLimit('admin-code', 5, 'Trop de demandes de code. Réessayez dans quelques minutes.');

function formatMoney(cents) {
  return new Intl.NumberFormat('fr-FR', { style: 'currency', currency: 'EUR' }).format(cents / 100);
}

function readText(value, label, maxLength) {
  if (typeof value !== 'string') throw new Error(`${label} invalide.`);
  const text = value.trim();
  if (!text || text.length > maxLength) throw new Error(`${label} invalide.`);
  return text;
}

function normalizeEmail(value) {
  const email = readText(value, 'Adresse email', 254).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('Adresse email invalide.');
  return email;
}

function readPassword(value) {
  if (typeof value !== 'string' || value.length < 12 || value.length > 128) {
    throw new Error('Le mot de passe doit contenir entre 12 et 128 caractères.');
  }
  return value;
}

async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const derivedKey = await scrypt(password, salt, 64);
  return `${salt.toString('hex')}:${derivedKey.toString('hex')}`;
}

async function verifyPassword(password, storedHash) {
  const [saltHex, keyHex] = typeof storedHash === 'string' ? storedHash.split(':') : [];
  const salt = /^[0-9a-f]{32}$/.test(saltHex || '') ? Buffer.from(saltHex, 'hex') : Buffer.alloc(16);
  const expected = /^[0-9a-f]{128}$/.test(keyHex || '') ? Buffer.from(keyHex, 'hex') : Buffer.alloc(64);
  const actual = await scrypt(password, salt, 64);
  return crypto.timingSafeEqual(actual, expected) && /^[0-9a-f]{32}:[0-9a-f]{128}$/.test(storedHash || '');
}

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function readSessionToken(request) {
  const cookie = request.headers.cookie?.split(';').map((part) => part.trim())
    .find((part) => part.startsWith('facilipro_session='));
  const token = cookie?.slice('facilipro_session='.length);
  return /^[0-9a-f]{64}$/.test(token || '') ? token : null;
}

function setSessionCookie(response, token) {
  const secure = /^https:/i.test(baseUrl) ? '; Secure' : '';
  response.setHeader('Set-Cookie', `facilipro_session=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${sessionLifetimeSeconds}${secure}`);
}

function clearSessionCookie(response) {
  const secure = /^https:/i.test(baseUrl) ? '; Secure' : '';
  response.setHeader('Set-Cookie', `facilipro_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure}`);
}

async function createSession(userId, response) {
  const token = crypto.randomBytes(32).toString('hex');
  await accountPool.query('DELETE FROM account_sessions WHERE expires_at <= NOW()');
  await accountPool.query(
    'INSERT INTO account_sessions (token_hash, user_id, expires_at) VALUES ($1, $2, NOW() + INTERVAL \'30 days\')',
    [hashToken(token), userId]
  );
  setSessionCookie(response, token);
}

async function getAuthenticatedAccount(request) {
  const token = readSessionToken(request);
  if (!token) return null;
  const result = await accountPool.query(
    `SELECT accounts.id, accounts.email, accounts.documents_pilot,
            account_sessions.token_hash AS session_hash,
            account_sessions.admin_verified_at > NOW() - INTERVAL '12 hours' AS admin_verified
     FROM account_sessions
     JOIN accounts ON accounts.id = account_sessions.user_id
     WHERE account_sessions.token_hash = $1
       AND account_sessions.expires_at > NOW()
       AND accounts.email_verified_at IS NOT NULL`,
    [hashToken(token)]
  );
  return result.rows[0] || null;
}

function sendAccountUnavailable(response) {
  if (!accountPool) {
    response.status(503).json({ error: 'Les inscriptions seront disponibles dès que la base PostgreSQL sera configurée.' });
  } else {
    console.error('Espace client indisponible :', accountStoreError);
    response.status(503).json({ error: 'L’espace client est temporairement indisponible. Réessayez plus tard.' });
  }
}

function readCallbackPhone(value) {
  const phone = readText(value, 'Numéro de téléphone', 30).replace(/[\s().-]/g, '');
  const frenchNumber = phone.startsWith('+33')
    ? `0${phone.slice(3)}`
    : phone.startsWith('0033')
      ? `0${phone.slice(4)}`
      : phone;
  if (!/^0[1-9]\d{8}$/.test(frenchNumber)) throw new Error('Numéro de téléphone invalide.');
  return frenchNumber;
}

function toCents(value) {
  if (typeof value !== 'string' && typeof value !== 'number') throw new Error('Montant de l’aide invalide.');
  const amount = Number(String(value).trim().replace(',', '.'));
  if (!Number.isFinite(amount) || amount <= 0 || amount > 999999.99) {
    throw new Error('Le montant de l’aide doit être supérieur à 0 €.');
  }
  return Math.round(amount * 100);
}

function readSignature(value) {
  if (typeof value !== 'string' || value.length > 1_500_000) throw new Error('Signature électronique invalide.');
  const match = /^data:image\/png;base64,([A-Za-z0-9+/]+={0,2})$/.exec(value);
  if (!match) throw new Error('Veuillez fournir une signature PNG valide.');
  const image = Buffer.from(match[1], 'base64');
  const pngHeader = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  if (image.length < 8 || !image.subarray(0, 8).equals(pngHeader)) throw new Error('Le fichier de signature est invalide.');
  return image.toString('base64');
}

// Les devis sont stockés dans PostgreSQL : le disque d'un hébergement serverless n'est pas persistant.
async function saveQuote(quote) {
  await accountPool.query(
    `INSERT INTO quotes (id, client_email, data) VALUES ($1, $2, $3)
     ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, updated_at = NOW()`,
    [quote.id, quote.clientEmail.toLowerCase(), quote]
  );
}

async function loadQuote(id) {
  if (typeof id !== 'string' || !/^[0-9a-f-]{36}$/i.test(id)) throw new Error('Référence de devis invalide.');
  const result = await accountPool.query('SELECT data FROM quotes WHERE id = $1', [id]);
  if (!result.rows[0]) {
    const error = new Error('Devis introuvable.');
    error.code = 'ENOENT';
    throw error;
  }
  return result.rows[0].data;
}

// Estimation ARCE (service-public.gouv.fr F15252) : 60 % du capital restant des droits ARE,
// moins 3 % de participation aux retraites complémentaires, versé en deux moitiés à 6 mois d'écart.
function computeArce(remainingDays, dailyAllowanceCents, referenceDate) {
  const remainingRightsCents = remainingDays * dailyAllowanceCents;
  const grossCapitalCents = Math.round(remainingRightsCents * 0.6);
  const retirementDeductionCents = Math.round(grossCapitalCents * 0.03);
  const netCapitalCents = grossCapitalCents - retirementDeductionCents;
  const firstPaymentCents = Math.round(netCapitalCents / 2);
  const secondPaymentDate = new Date(`${referenceDate}T00:00:00Z`);
  secondPaymentDate.setUTCMonth(secondPaymentDate.getUTCMonth() + 6);
  return {
    remainingRightsCents,
    grossCapitalCents,
    retirementDeductionCents,
    netCapitalCents,
    firstPaymentCents,
    firstPaymentDate: referenceDate,
    secondPaymentCents: netCapitalCents - firstPaymentCents,
    secondPaymentDate: secondPaymentDate.toISOString().slice(0, 10),
    commissionCents: Math.round(netCapitalCents * 0.12)
  };
}

function readDossier(body) {
  const remainingDays = Number(body?.remainingDays);
  if (!Number.isInteger(remainingDays) || remainingDays < 1 || remainingDays > 1100) {
    throw new Error('Le nombre de jours restants doit être un nombre entier entre 1 et 1 100.');
  }
  const allowance = Number(String(body?.dailyAllowance ?? '').trim().replace(',', '.'));
  if (!Number.isFinite(allowance) || allowance <= 0 || allowance > 500) {
    throw new Error('L’allocation journalière brute doit être comprise entre 0,01 € et 500 €.');
  }
  const referenceDate = typeof body?.referenceDate === 'string' ? body.referenceDate : '';
  const parsed = new Date(`${referenceDate}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(referenceDate) || Number.isNaN(parsed.getTime())
    || parsed.toISOString().slice(0, 10) !== referenceDate
    || referenceDate < '2020-01-01' || parsed.getTime() > Date.now() + 366 * 24 * 3600 * 1000) {
    throw new Error('La date de référence est invalide.');
  }
  return { remainingDays, dailyAllowanceCents: Math.round(allowance * 100), referenceDate };
}

function detectDocumentType(content) {
  if (content.subarray(0, 5).toString('latin1') === '%PDF-') return { mime: 'application/pdf', extension: 'pdf' };
  if (content[0] === 0xff && content[1] === 0xd8 && content[2] === 0xff) return { mime: 'image/jpeg', extension: 'jpg' };
  if (content.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return { mime: 'image/png', extension: 'png' };
  return null;
}

function encryptDocument(content, documentId, accountId) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', documentsKey, iv);
  cipher.setAAD(Buffer.from(`${documentId}:${accountId}`));
  const ciphertext = Buffer.concat([cipher.update(content), cipher.final()]);
  return { iv, ciphertext, authTag: cipher.getAuthTag() };
}

function decryptDocument(row) {
  const decipher = crypto.createDecipheriv('aes-256-gcm', documentsKey, row.iv);
  decipher.setAAD(Buffer.from(`${row.id}:${row.account_id}`));
  decipher.setAuthTag(row.auth_tag);
  return Buffer.concat([decipher.update(row.ciphertext), decipher.final()]);
}

function sendDocumentFile(response, row) {
  const content = decryptDocument(row);
  response.setHeader('Content-Type', row.mime);
  response.setHeader('Content-Disposition', `attachment; filename="${documentKindFileName(row)}"`);
  response.setHeader('Cache-Control', 'no-store, private');
  response.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
  return response.send(content);
}

function documentKindFileName(row) {
  const extension = { 'application/pdf': 'pdf', 'image/jpeg': 'jpg', 'image/png': 'png' }[row.mime] || 'bin';
  return `${row.kind}-${row.id.slice(0, 8)}.${extension}`;
}

async function logDocumentAccess(actorEmail, accountId, documentId, action) {
  await accountPool.query(
    'INSERT INTO document_access_log (actor_email, account_id, document_id, action) VALUES ($1, $2, $3, $4)',
    [actorEmail, accountId, documentId, action]
  );
}

async function purgeExpiredDocuments() {
  const result = await accountPool.query('DELETE FROM dossier_documents WHERE expires_at <= NOW() RETURNING id, account_id');
  for (const row of result.rows) await logDocumentAccess('système', row.account_id, row.id, 'suppression automatique (durée de conservation)');
  return result.rowCount;
}

async function loadDossierView(accountId) {
  const [dossierResult, documentsResult, requestsResult] = await Promise.all([
    accountPool.query('SELECT remaining_days, daily_allowance_cents, reference_date::text, status, updated_at FROM arce_dossiers WHERE account_id = $1', [accountId]),
    accountPool.query('SELECT id, kind, size, mime, uploaded_at, expires_at FROM dossier_documents WHERE account_id = $1 ORDER BY uploaded_at', [accountId]),
    accountPool.query('SELECT id, kinds, message, created_at, resolved_at FROM document_requests WHERE account_id = $1 ORDER BY created_at DESC', [accountId])
  ]);
  const row = dossierResult.rows[0];
  const dossier = row ? {
    remainingDays: row.remaining_days,
    dailyAllowanceCents: row.daily_allowance_cents,
    referenceDate: row.reference_date,
    status: row.status,
    updatedAt: row.updated_at
  } : null;
  const documents = documentsResult.rows.map((document) => ({
    id: document.id,
    kind: document.kind,
    label: documentKinds[document.kind],
    size: document.size,
    mime: document.mime,
    uploadedAt: document.uploaded_at,
    expiresAt: document.expires_at
  }));
  const presentKinds = new Set(documents.map((document) => document.kind));
  return {
    dossier,
    estimate: dossier ? computeArce(dossier.remainingDays, dossier.dailyAllowanceCents, dossier.referenceDate) : null,
    documents,
    missingKinds: Object.keys(documentKinds).filter((kind) => !presentKinds.has(kind)),
    requests: requestsResult.rows.map((request) => ({
      id: request.id,
      kinds: request.kinds,
      labels: request.kinds.map((kind) => documentKinds[kind]),
      message: request.message,
      createdAt: request.created_at,
      resolvedAt: request.resolved_at
    }))
  };
}

function makePdf(createContent) {
  return new Promise((resolve, reject) => {
    const pdf = new PDFDocument({ size: 'A4', margin: 48 });
    const chunks = [];
    pdf.on('data', (chunk) => chunks.push(chunk));
    pdf.on('end', () => resolve(Buffer.concat(chunks)));
    pdf.on('error', reject);
    createContent(pdf);
    pdf.end();
  });
}

function drawHeader(pdf, title, quote, reference) {
  pdf.fillColor('#0d1b2a').fontSize(21).text(title);
  pdf.moveDown(0.6);
  pdf.fillColor('#334155').fontSize(10);
  pdf.text(process.env.BUSINESS_NAME);
  pdf.text(process.env.BUSINESS_ADDRESS);
  pdf.text(`SIRET : ${process.env.BUSINESS_SIRET}`);
  pdf.text(process.env.BUSINESS_EMAIL);
  pdf.moveDown();
  pdf.fillColor('#17212f').fontSize(10);
  pdf.text(`Référence : ${reference}`);
  pdf.text(`Date : ${new Date().toLocaleDateString('fr-FR')}`);
  pdf.text(`Client : ${quote.clientName}`);
  pdf.text(`Email : ${quote.clientEmail}`);
  pdf.moveDown();
}

function drawQuoteDetails(pdf, quote) {
  pdf.fillColor('#17212f').fontSize(12).text('Détail du devis', { underline: true });
  pdf.moveDown(0.5);
  pdf.fontSize(11);
  pdf.text(`Prestation : ${quote.service}`);
  pdf.text(`Montant total de l’aide déclaré : ${formatMoney(quote.aidAmountCents)}`);
  pdf.text(`Commission (12 %) : ${formatMoney(quote.commissionCents)}`);
  pdf.text(`Premier versement du client : ${formatMoney(quote.commissionCents)}`);
  pdf.text(`Somme totale à payer : ${formatMoney(quote.commissionCents)}`);
}

async function createDocuments(quote) {
  const reference = quote.id.slice(0, 8).toUpperCase();
  const paymentTerms = [
    'La commission de 12 % est calculée sur le montant total de l’aide déclaré au devis.',
    'La totalité de la commission est due et réglée en un seul versement dès le premier déblocage de l’ARCE.',
    'Le paiement de cette commission solde l’ensemble des frais de notre prestation.'
  ];

  const quotePdf = await makePdf((pdf) => {
    drawHeader(pdf, 'Devis accepté', quote, `DEV-${reference}`);
    drawQuoteDetails(pdf, quote);
    pdf.moveDown();
    pdf.fontSize(12).text('Conditions de paiement', { underline: true });
    pdf.moveDown(0.5);
    paymentTerms.forEach((term) => pdf.fontSize(10).text(`• ${term}`, { indent: 8, lineGap: 3 }));
    pdf.moveDown();
    pdf.fontSize(10).text('Devis accepté par signature électronique :');
    pdf.moveDown(0.5);
    pdf.image(Buffer.from(quote.signature, 'base64'), { fit: [220, 75] });
  });

  const invoicePdf = await makePdf((pdf) => {
    drawHeader(pdf, 'Facture acquittée', quote, `FAC-${reference}`);
    drawQuoteDetails(pdf, quote);
    pdf.moveDown();
    pdf.fontSize(12).text(`Montant réglé : ${formatMoney(quote.commissionCents)}`);
    pdf.fontSize(10).text(`Paiement confirmé le : ${new Date(quote.paidAt).toLocaleDateString('fr-FR')}`);
    pdf.moveDown();
    pdf.fontSize(12).text('Conditions', { underline: true });
    pdf.moveDown(0.5);
    paymentTerms.forEach((term) => pdf.fontSize(10).text(`• ${term}`, { indent: 8, lineGap: 3 }));
  });

  return { reference, quotePdf, invoicePdf };
}

async function sendDocuments(quote) {
  const documents = await createDocuments(quote);
  await mailer.sendMail({
    from: process.env.MAIL_FROM,
    to: quote.clientEmail,
    subject: `Votre devis signé et votre facture acquittée - ${documents.reference}`,
    text: [
      `Bonjour ${quote.clientName},`,
      '',
      'Votre paiement a été confirmé par Stripe. Vous trouverez en pièces jointes votre devis signé et votre facture acquittée.',
      '',
      `Montant total de l’aide déclaré : ${formatMoney(quote.aidAmountCents)}`,
      `Commission de 12 % réglée : ${formatMoney(quote.commissionCents)}`,
      '',
      'La totalité de la commission est réglée en un seul versement dès le premier déblocage de l’ARCE et solde l’ensemble des frais de notre prestation.',
      '',
      process.env.BUSINESS_NAME
    ].join('\n'),
    attachments: [
      { filename: `devis-DEV-${documents.reference}.pdf`, content: documents.quotePdf },
      { filename: `facture-FAC-${documents.reference}.pdf`, content: documents.invoicePdf }
    ]
  });
  return `FAC-${documents.reference}`;
}

async function processPaidCheckout(session) {
  const quoteId = session.metadata?.quoteId;
  if (!quoteId || session.payment_status !== 'paid') return;
  if (processing.has(quoteId)) return;
  processing.add(quoteId);
  try {
    const quote = await loadQuote(quoteId);
    if (quote.checkoutSessionId !== session.id) throw new Error('La session Stripe ne correspond pas au devis.');
    if (quote.documentsSentAt) return;

    quote.paymentStatus = 'paid';
    quote.paidAt ||= new Date().toISOString();
    await saveQuote(quote);
    quote.invoiceNumber = await sendDocuments(quote);
    quote.documentsSentAt = new Date().toISOString();
    await saveQuote(quote);
  } finally {
    processing.delete(quoteId);
  }
}

// Même politique que dans vercel.json (qui l'applique aux pages servies par le CDN).
const contentSecurityPolicy = "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https://images.unsplash.com; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'; object-src 'none'";

app.set('trust proxy', 1);
app.disable('x-powered-by');

app.use((_request, response, next) => {
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('X-Frame-Options', 'DENY');
  response.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  response.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  response.setHeader('Content-Security-Policy', contentSecurityPolicy);
  if (/^https:/i.test(baseUrl)) response.setHeader('Strict-Transport-Security', 'max-age=63072000; includeSubDomains');
  next();
});

app.use('/api', (_request, response, next) => {
  if (configured) return next();
  return response.status(503).json({ error: 'Le service est en cours de configuration. Réessayez plus tard ou appelez le 06 89 20 41 17.' });
});

app.post('/api/stripe-webhook', express.raw({ type: 'application/json' }), async (request, response) => {
  let event;
  try {
    event = stripe.webhooks.constructEvent(
      request.body,
      request.headers['stripe-signature'],
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (error) {
    console.error('Webhook Stripe refusé : signature invalide.', error.message);
    return response.status(400).send('Signature webhook invalide.');
  }

  if (event.type === 'checkout.session.completed' || event.type === 'checkout.session.async_payment_succeeded') {
    try {
      await processPaidCheckout(event.data.object);
    } catch (error) {
      console.error('Traitement du paiement / envoi des documents impossible :', error);
      return response.status(500).send('Erreur lors du traitement du paiement; Stripe réessaiera.');
    }
  }
  return response.json({ received: true });
});

app.use(express.json({ limit: '2mb' }));

app.get('/api/account/status', (_request, response) => {
  response.json({ enabled: Boolean(accountPool && accountStoreReady) });
});

app.post('/api/account/register', accountRateLimit, async (request, response) => {
  if (!accountPool || !accountStoreReady) return sendAccountUnavailable(response);

  let email;
  let password;
  try {
    email = normalizeEmail(request.body?.email);
    password = readPassword(request.body?.password);
  } catch (error) {
    return response.status(400).json({ error: error.message });
  }

  try {
    const passwordHash = await hashPassword(password);
    const verificationToken = crypto.randomBytes(32).toString('hex');
    const result = await accountPool.query(
      `INSERT INTO accounts (id, email, password_hash, verification_token_hash, verification_expires_at)
       VALUES ($1, $2, $3, $4, NOW() + INTERVAL '24 hours')
       ON CONFLICT (email) DO UPDATE
         SET password_hash = EXCLUDED.password_hash,
             verification_token_hash = EXCLUDED.verification_token_hash,
             verification_expires_at = EXCLUDED.verification_expires_at
         WHERE accounts.email_verified_at IS NULL
       RETURNING id`,
      [crypto.randomUUID(), email, passwordHash, hashToken(verificationToken)]
    );
    if (!result.rows[0]) {
      return response.status(409).json({ error: 'Cette adresse possède déjà un compte vérifié. Connectez-vous.' });
    }

    const verificationUrl = new URL('/', baseUrl);
    verificationUrl.searchParams.set('verify-email', verificationToken);
    verificationUrl.hash = 'compte';
    try {
      await mailer.sendMail({
        from: process.env.MAIL_FROM,
        to: email,
        subject: 'Confirmez votre adresse email - FacilePro',
        text: [
          'Bonjour,',
          '',
          'Pour confirmer votre adresse email et activer votre espace client FacilePro, ouvrez ce lien :',
          verificationUrl.toString(),
          '',
          'Ce lien est valable 24 heures. Si vous n’avez pas demandé la création d’un compte, ignorez cet email.'
        ].join('\n')
      });
    } catch (error) {
      console.error('Envoi de l’email de confirmation impossible :', error);
      return response.status(502).json({ error: 'Le compte est enregistré, mais l’email de confirmation n’a pas pu être envoyé. Réessayez l’inscription.' });
    }
    return response.json({ message: 'Un lien de confirmation vient d’être envoyé à votre adresse email.' });
  } catch (error) {
    console.error('Création du compte impossible :', error);
    return response.status(500).json({ error: 'Impossible de créer le compte pour le moment.' });
  }
});

app.post('/api/account/verify-email', accountRateLimit, async (request, response) => {
  if (!accountPool || !accountStoreReady) return sendAccountUnavailable(response);
  const token = request.body?.token;
  if (typeof token !== 'string' || !/^[0-9a-f]{64}$/.test(token)) {
    return response.status(400).json({ error: 'Le lien de confirmation est invalide.' });
  }

  try {
    const result = await accountPool.query(
      `UPDATE accounts
       SET email_verified_at = NOW(),
           verification_token_hash = NULL,
           verification_expires_at = NULL
       WHERE verification_token_hash = $1
         AND verification_expires_at > NOW()
         AND email_verified_at IS NULL
       RETURNING id, email`,
      [hashToken(token)]
    );
    const account = result.rows[0];
    if (!account) return response.status(400).json({ error: 'Ce lien de confirmation est invalide ou a expiré.' });
    await createSession(account.id, response);
    return response.json({ email: account.email });
  } catch (error) {
    console.error('Confirmation de compte impossible :', error);
    return response.status(500).json({ error: 'Impossible de confirmer le compte pour le moment.' });
  }
});

app.post('/api/account/login', accountRateLimit, async (request, response) => {
  if (!accountPool || !accountStoreReady) return sendAccountUnavailable(response);

  let email;
  let password;
  try {
    email = normalizeEmail(request.body?.email);
    password = request.body?.password;
    if (typeof password !== 'string' || password.length === 0 || password.length > 128) {
      throw new Error('Mot de passe invalide.');
    }
  } catch (error) {
    return response.status(400).json({ error: error.message });
  }

  try {
    const result = await accountPool.query(
      'SELECT id, email, password_hash, email_verified_at FROM accounts WHERE email = $1',
      [email]
    );
    const account = result.rows[0];
    const passwordMatches = await verifyPassword(password, account?.password_hash);
    if (!account || !passwordMatches) {
      return response.status(401).json({ error: 'Adresse email ou mot de passe incorrect.' });
    }
    if (!account.email_verified_at) {
      return response.status(403).json({ error: 'Confirmez votre adresse email grâce au lien reçu avant de vous connecter.' });
    }
    await createSession(account.id, response);
    return response.json({ email: account.email });
  } catch (error) {
    console.error('Connexion au compte impossible :', error);
    return response.status(500).json({ error: 'Impossible de vous connecter pour le moment.' });
  }
});

app.get('/api/account/me', async (request, response) => {
  if (!accountPool || !accountStoreReady) return sendAccountUnavailable(response);
  try {
    const account = await getAuthenticatedAccount(request);
    if (!account) return response.status(401).json({ error: 'Veuillez vous connecter.' });
    return response.json({ email: account.email, isAdmin: adminEmails.has(account.email) });
  } catch (error) {
    console.error('Lecture du compte impossible :', error);
    return response.status(500).json({ error: 'Impossible de lire le compte pour le moment.' });
  }
});

app.get('/api/account/quotes', async (request, response) => {
  if (!accountPool || !accountStoreReady) return sendAccountUnavailable(response);
  try {
    const account = await getAuthenticatedAccount(request);
    if (!account) return response.status(401).json({ error: 'Veuillez vous connecter.' });
    const result = await accountPool.query(
      'SELECT data FROM quotes WHERE client_email = $1 ORDER BY created_at DESC',
      [account.email]
    );
    const quotes = result.rows.map(({ data: quote }) => ({
      reference: quote.id.slice(0, 8).toUpperCase(),
      service: quote.service,
      aidAmountCents: quote.aidAmountCents,
      commissionCents: quote.commissionCents,
      paymentStatus: quote.paymentStatus,
      createdAt: quote.createdAt,
      paidAt: quote.paidAt || null,
      documentsSent: Boolean(quote.documentsSentAt)
    }));
    return response.json({ quotes });
  } catch (error) {
    console.error('Lecture des devis du compte impossible :', error);
    return response.status(500).json({ error: 'Impossible de lire les devis pour le moment.' });
  }
});

app.post('/api/account/logout', async (request, response) => {
  if (!accountPool || !accountStoreReady) return sendAccountUnavailable(response);
  try {
    const token = readSessionToken(request);
    if (token) await accountPool.query('DELETE FROM account_sessions WHERE token_hash = $1', [hashToken(token)]);
    clearSessionCookie(response);
    return response.json({ message: 'Vous êtes déconnecté.' });
  } catch (error) {
    console.error('Déconnexion du compte impossible :', error);
    return response.status(500).json({ error: 'Impossible de vous déconnecter pour le moment.' });
  }
});

// Exige un compte connecté et vérifié ; avec admin = true, exige aussi une adresse listée dans ADMIN_EMAILS
// et un code reçu par email validé sur cette session depuis moins de 12 heures.
function requireAccount({ admin = false } = {}) {
  return async (request, response, next) => {
    if (!accountPool || !accountStoreReady) return sendAccountUnavailable(response);
    try {
      const account = await getAuthenticatedAccount(request);
      if (!account) return response.status(401).json({ error: 'Veuillez vous connecter.' });
      if (admin && !adminEmails.has(account.email)) return response.status(403).json({ error: 'Accès réservé aux administrateurs.' });
      if (admin && !account.admin_verified) {
        return response.status(403).json({ error: 'Code de vérification requis.', code: 'admin_code_required' });
      }
      request.account = account;
      response.setHeader('Cache-Control', 'no-store, private');
      return next();
    } catch (error) {
      console.error('Vérification de la session impossible :', error);
      return response.status(500).json({ error: 'Impossible de vérifier votre session.' });
    }
  };
}

function isUuid(value) {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

function hashAdminCode(sessionHash, code) {
  return crypto.createHash('sha256').update(`${sessionHash}:${code}`).digest('hex');
}

app.post('/api/admin/code/request', adminCodeRateLimit, requireAccount(), async (request, response) => {
  if (!adminEmails.has(request.account.email)) return response.status(403).json({ error: 'Accès réservé aux administrateurs.' });
  const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
  try {
    await accountPool.query(
      `UPDATE account_sessions
       SET admin_code_hash = $1, admin_code_expires_at = NOW() + INTERVAL '10 minutes', admin_code_attempts = 0
       WHERE token_hash = $2`,
      [hashAdminCode(request.account.session_hash, code), request.account.session_hash]
    );
    await mailer.sendMail({
      from: process.env.MAIL_FROM,
      to: request.account.email,
      subject: `Code d’accès administrateur FacilePro : ${code}`,
      text: [
        `Votre code d’accès au tableau de bord administrateur : ${code}`,
        '',
        'Il est valable 10 minutes. Si vous n’êtes pas à l’origine de cette demande, changez votre mot de passe.'
      ].join('\n')
    });
    return response.json({ message: 'Un code à 6 chiffres vient d’être envoyé à votre adresse email.' });
  } catch (error) {
    console.error('Envoi du code administrateur impossible :', error);
    return response.status(502).json({ error: 'Impossible d’envoyer le code pour le moment.' });
  }
});

app.post('/api/admin/code/verify', adminCodeRateLimit, requireAccount(), async (request, response) => {
  if (!adminEmails.has(request.account.email)) return response.status(403).json({ error: 'Accès réservé aux administrateurs.' });
  const code = typeof request.body?.code === 'string' ? request.body.code.trim() : '';
  if (!/^\d{6}$/.test(code)) return response.status(400).json({ error: 'Le code doit contenir 6 chiffres.' });
  try {
    const result = await accountPool.query(
      `UPDATE account_sessions SET admin_code_attempts = admin_code_attempts + 1
       WHERE token_hash = $1 AND admin_code_hash IS NOT NULL AND admin_code_expires_at > NOW() AND admin_code_attempts < 5
       RETURNING admin_code_hash`,
      [request.account.session_hash]
    );
    const expected = result.rows[0]?.admin_code_hash;
    const received = hashAdminCode(request.account.session_hash, code);
    if (!expected || !crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(received))) {
      return response.status(400).json({ error: 'Code incorrect ou expiré. Demandez un nouveau code.' });
    }
    await accountPool.query(
      `UPDATE account_sessions
       SET admin_verified_at = NOW(), admin_code_hash = NULL, admin_code_expires_at = NULL, admin_code_attempts = 0
       WHERE token_hash = $1`,
      [request.account.session_hash]
    );
    await logDocumentAccess(request.account.email, null, null, 'connexion administrateur validée par code');
    return response.json({ message: 'Accès administrateur validé.' });
  } catch (error) {
    console.error('Vérification du code administrateur impossible :', error);
    return response.status(500).json({ error: 'Impossible de vérifier le code.' });
  }
});

// Droit à l'effacement : supprime le compte, le dossier ARCE, les pièces et les sessions.
// Les devis et factures restent conservés au titre des obligations comptables.
app.delete('/api/account', accountRateLimit, requireAccount(), async (request, response) => {
  const password = request.body?.password;
  if (typeof password !== 'string' || password.length === 0 || password.length > 128) {
    return response.status(400).json({ error: 'Saisissez votre mot de passe pour confirmer.' });
  }
  try {
    const result = await accountPool.query('SELECT password_hash FROM accounts WHERE id = $1', [request.account.id]);
    if (!await verifyPassword(password, result.rows[0]?.password_hash)) {
      return response.status(401).json({ error: 'Mot de passe incorrect.' });
    }
    const deleted = await accountPool.query('SELECT COUNT(*)::int AS n FROM dossier_documents WHERE account_id = $1', [request.account.id]);
    await accountPool.query('DELETE FROM accounts WHERE id = $1', [request.account.id]);
    await logDocumentAccess(request.account.email, request.account.id, null, `suppression du compte par le client (${deleted.rows[0].n} document(s))`);
    clearSessionCookie(response);
    return response.json({ message: 'Votre compte, votre dossier et vos documents ont été supprimés définitivement.' });
  } catch (error) {
    console.error('Suppression du compte impossible :', error);
    return response.status(500).json({ error: 'Impossible de supprimer le compte pour le moment.' });
  }
});

// Le dépôt est ouvert à tous quand DOCUMENTS_UPLOAD_ENABLED vaut « true », ou seulement aux comptes
// marqués « pilote » en base (phase de test en production, sans ouverture au public).
function canUpload(account) {
  return uploadsEnabled || (Boolean(documentsKey) && account.documents_pilot === true);
}

app.get('/api/account/dossier', documentRateLimit, requireAccount(), async (request, response) => {
  try {
    await purgeExpiredDocuments();
    const view = await loadDossierView(request.account.id);
    return response.json({ ...view, uploadsEnabled: canUpload(request.account), retentionDays, documentKinds });
  } catch (error) {
    console.error('Lecture du dossier impossible :', error);
    return response.status(500).json({ error: 'Impossible de charger votre dossier.' });
  }
});

app.put('/api/account/dossier', documentRateLimit, requireAccount(), async (request, response) => {
  let dossier;
  try {
    dossier = readDossier(request.body);
  } catch (error) {
    return response.status(400).json({ error: error.message });
  }
  try {
    await accountPool.query(
      `INSERT INTO arce_dossiers (account_id, remaining_days, daily_allowance_cents, reference_date)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (account_id) DO UPDATE
         SET remaining_days = EXCLUDED.remaining_days,
             daily_allowance_cents = EXCLUDED.daily_allowance_cents,
             reference_date = EXCLUDED.reference_date,
             updated_at = NOW()`,
      [request.account.id, dossier.remainingDays, dossier.dailyAllowanceCents, dossier.referenceDate]
    );
    return response.json({ estimate: computeArce(dossier.remainingDays, dossier.dailyAllowanceCents, dossier.referenceDate) });
  } catch (error) {
    console.error('Enregistrement du dossier impossible :', error);
    return response.status(500).json({ error: 'Impossible d’enregistrer votre dossier.' });
  }
});

app.post('/api/account/documents', documentRateLimit, requireAccount(),
  express.raw({ type: 'application/octet-stream', limit: maxDocumentBytes }), async (request, response) => {
    if (!canUpload(request.account)) {
      return response.status(403).json({ error: 'Le dépôt sécurisé de documents n’est pas encore ouvert. N’envoyez aucun document par email.' });
    }
    const kind = request.query.kind;
    if (typeof kind !== 'string' || !documentKinds[kind]) return response.status(400).json({ error: 'Type de document invalide.' });
    const content = request.body;
    if (!Buffer.isBuffer(content) || content.length === 0) return response.status(400).json({ error: 'Fichier vide ou illisible.' });
    const type = detectDocumentType(content);
    if (!type) return response.status(400).json({ error: 'Format refusé : seuls les fichiers PDF, JPEG et PNG sont acceptés.' });
    if (type.mime === 'application/pdf' && /\/(JavaScript|Launch|EmbeddedFiles?)\b/.test(content.toString('latin1'))) {
      return response.status(400).json({ error: 'Ce PDF contient du contenu actif (script ou fichier intégré) et a été refusé. Enregistrez-le à nouveau en PDF simple ou envoyez une photo.' });
    }

    const documentId = crypto.randomUUID();
    const accountId = request.account.id;
    const encrypted = encryptDocument(content, documentId, accountId);
    const client = await accountPool.connect();
    try {
      await client.query('BEGIN');
      const previous = await client.query('DELETE FROM dossier_documents WHERE account_id = $1 AND kind = $2 RETURNING id', [accountId, kind]);
      await client.query(
        `INSERT INTO dossier_documents (id, account_id, kind, mime, size, iv, auth_tag, ciphertext, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW() + make_interval(days => $9))`,
        [documentId, accountId, kind, type.mime, content.length, encrypted.iv, encrypted.authTag, encrypted.ciphertext, retentionDays]
      );
      await client.query(
        `UPDATE document_requests SET resolved_at = NOW()
         WHERE account_id = $1 AND resolved_at IS NULL
           AND kinds <@ (SELECT array_agg(kind) FROM dossier_documents WHERE account_id = $1)`,
        [accountId]
      );
      await client.query('COMMIT');
      for (const row of previous.rows) await logDocumentAccess(request.account.email, accountId, row.id, 'remplacement par le client');
      await logDocumentAccess(request.account.email, accountId, documentId, 'dépôt');
      return response.json({ message: `${documentKinds[kind]} déposé(e) et chiffré(e).`, id: documentId });
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      console.error('Dépôt du document impossible :', error);
      return response.status(500).json({ error: 'Impossible d’enregistrer le document.' });
    } finally {
      client.release();
    }
  });

app.get('/api/account/documents/:id', documentRateLimit, requireAccount(), async (request, response) => {
  if (!isUuid(request.params.id) || !documentsKey) return response.status(404).json({ error: 'Document introuvable.' });
  try {
    const result = await accountPool.query(
      'SELECT * FROM dossier_documents WHERE id = $1 AND account_id = $2 AND expires_at > NOW()',
      [request.params.id, request.account.id]
    );
    if (!result.rows[0]) return response.status(404).json({ error: 'Document introuvable.' });
    await logDocumentAccess(request.account.email, request.account.id, request.params.id, 'téléchargement par le client');
    return sendDocumentFile(response, result.rows[0]);
  } catch (error) {
    console.error('Lecture du document impossible :', error);
    return response.status(500).json({ error: 'Impossible de lire le document.' });
  }
});

app.delete('/api/account/documents/:id', documentRateLimit, requireAccount(), async (request, response) => {
  if (!isUuid(request.params.id)) return response.status(404).json({ error: 'Document introuvable.' });
  try {
    const result = await accountPool.query(
      'DELETE FROM dossier_documents WHERE id = $1 AND account_id = $2 RETURNING id',
      [request.params.id, request.account.id]
    );
    if (!result.rows[0]) return response.status(404).json({ error: 'Document introuvable.' });
    await logDocumentAccess(request.account.email, request.account.id, request.params.id, 'suppression par le client');
    return response.json({ message: 'Document supprimé définitivement.' });
  } catch (error) {
    console.error('Suppression du document impossible :', error);
    return response.status(500).json({ error: 'Impossible de supprimer le document.' });
  }
});

app.get('/api/admin/dossiers', documentRateLimit, requireAccount({ admin: true }), async (_request, response) => {
  try {
    await purgeExpiredDocuments();
    const result = await accountPool.query(
      `SELECT accounts.id, accounts.email, accounts.created_at,
              arce_dossiers.remaining_days, arce_dossiers.daily_allowance_cents, arce_dossiers.reference_date::text,
              arce_dossiers.status, arce_dossiers.updated_at,
              COALESCE((SELECT array_agg(kind) FROM dossier_documents WHERE account_id = accounts.id), '{}') AS kinds,
              (SELECT COUNT(*)::int FROM document_requests WHERE account_id = accounts.id AND resolved_at IS NULL) AS open_requests
       FROM accounts
       LEFT JOIN arce_dossiers ON arce_dossiers.account_id = accounts.id
       WHERE accounts.email_verified_at IS NOT NULL
       ORDER BY COALESCE(arce_dossiers.updated_at, accounts.created_at) DESC`
    );
    return response.json({
      documentKinds,
      dossiers: result.rows.map((row) => ({
        accountId: row.id,
        email: row.email,
        createdAt: row.created_at,
        status: row.status || 'non commencé',
        updatedAt: row.updated_at,
        estimate: row.remaining_days ? computeArce(row.remaining_days, row.daily_allowance_cents, row.reference_date) : null,
        missingKinds: Object.keys(documentKinds).filter((kind) => !row.kinds.includes(kind)),
        openRequests: row.open_requests
      }))
    });
  } catch (error) {
    console.error('Liste des dossiers impossible :', error);
    return response.status(500).json({ error: 'Impossible de charger les dossiers.' });
  }
});

app.get('/api/admin/dossiers/:accountId', documentRateLimit, requireAccount({ admin: true }), async (request, response) => {
  if (!isUuid(request.params.accountId)) return response.status(404).json({ error: 'Dossier introuvable.' });
  try {
    const account = await accountPool.query('SELECT id, email FROM accounts WHERE id = $1', [request.params.accountId]);
    if (!account.rows[0]) return response.status(404).json({ error: 'Dossier introuvable.' });
    const view = await loadDossierView(request.params.accountId);
    await logDocumentAccess(request.account.email, request.params.accountId, null, 'consultation du dossier');
    return response.json({ email: account.rows[0].email, ...view, documentKinds });
  } catch (error) {
    console.error('Lecture du dossier administrateur impossible :', error);
    return response.status(500).json({ error: 'Impossible de charger le dossier.' });
  }
});

app.get('/api/admin/documents/:id', documentRateLimit, requireAccount({ admin: true }), async (request, response) => {
  if (!isUuid(request.params.id) || !documentsKey) return response.status(404).json({ error: 'Document introuvable.' });
  try {
    const result = await accountPool.query('SELECT * FROM dossier_documents WHERE id = $1 AND expires_at > NOW()', [request.params.id]);
    if (!result.rows[0]) return response.status(404).json({ error: 'Document introuvable.' });
    await logDocumentAccess(request.account.email, result.rows[0].account_id, request.params.id, 'téléchargement par un administrateur');
    return sendDocumentFile(response, result.rows[0]);
  } catch (error) {
    console.error('Lecture du document administrateur impossible :', error);
    return response.status(500).json({ error: 'Impossible de lire le document.' });
  }
});

app.post('/api/admin/dossiers/:accountId/requests', documentRateLimit, requireAccount({ admin: true }), async (request, response) => {
  if (!isUuid(request.params.accountId)) return response.status(404).json({ error: 'Dossier introuvable.' });
  const kinds = Array.isArray(request.body?.kinds) ? [...new Set(request.body.kinds)] : [];
  if (kinds.length === 0 || !kinds.every((kind) => documentKinds[kind])) {
    return response.status(400).json({ error: 'Choisissez au moins une pièce à demander.' });
  }
  const message = typeof request.body?.message === 'string' ? request.body.message.trim().slice(0, 1000) : '';
  try {
    const account = await accountPool.query('SELECT email FROM accounts WHERE id = $1', [request.params.accountId]);
    if (!account.rows[0]) return response.status(404).json({ error: 'Dossier introuvable.' });
    await accountPool.query(
      'INSERT INTO document_requests (id, account_id, kinds, message, requested_by) VALUES ($1, $2, $3, $4, $5)',
      [crypto.randomUUID(), request.params.accountId, kinds, message || null, request.account.email]
    );
    await logDocumentAccess(request.account.email, request.params.accountId, null, `demande de pièces : ${kinds.join(', ')}`);
    try {
      // L'email ne contient aucun document ni donnée personnelle : il invite seulement à se connecter.
      await mailer.sendMail({
        from: process.env.MAIL_FROM,
        to: account.rows[0].email,
        subject: 'Pièces à compléter dans votre espace client FacilePro',
        text: [
          'Bonjour,',
          '',
          'Pour avancer sur votre dossier, merci de déposer les pièces suivantes dans votre espace client sécurisé :',
          ...kinds.map((kind) => `- ${documentKinds[kind]}`),
          ...(message ? ['', message] : []),
          '',
          `Connectez-vous ici : ${baseUrl}/#compte`,
          '',
          'Important : n’envoyez jamais vos documents par email. Utilisez uniquement votre espace client.',
          '',
          process.env.BUSINESS_NAME
        ].join('\n')
      });
      return response.json({ message: 'Demande enregistrée et client prévenu par email.' });
    } catch (error) {
      console.error('Envoi de la demande de pièces impossible :', error);
      return response.json({ message: 'Demande enregistrée, mais l’email de notification n’a pas pu être envoyé.' });
    }
  } catch (error) {
    console.error('Demande de pièces impossible :', error);
    return response.status(500).json({ error: 'Impossible d’enregistrer la demande.' });
  }
});

app.delete('/api/admin/dossiers/:accountId/documents', documentRateLimit, requireAccount({ admin: true }), async (request, response) => {
  if (!isUuid(request.params.accountId)) return response.status(404).json({ error: 'Dossier introuvable.' });
  try {
    const result = await accountPool.query('DELETE FROM dossier_documents WHERE account_id = $1 RETURNING id', [request.params.accountId]);
    await accountPool.query(
      `UPDATE arce_dossiers SET status = 'clos', updated_at = NOW() WHERE account_id = $1`,
      [request.params.accountId]
    );
    await accountPool.query('UPDATE document_requests SET resolved_at = NOW() WHERE account_id = $1 AND resolved_at IS NULL', [request.params.accountId]);
    await logDocumentAccess(request.account.email, request.params.accountId, null, `clôture : ${result.rowCount} document(s) supprimé(s)`);
    return response.json({ message: `Dossier clos : ${result.rowCount} document(s) supprimé(s) définitivement.` });
  } catch (error) {
    console.error('Clôture du dossier impossible :', error);
    return response.status(500).json({ error: 'Impossible de clore le dossier.' });
  }
});

// Appelée chaque jour par Vercel Cron (en-tête Authorization: Bearer CRON_SECRET).
app.get('/api/cron/purge-documents', async (request, response) => {
  const secret = process.env.CRON_SECRET;
  const expected = Buffer.from(`Bearer ${secret || ''}`);
  const received = Buffer.from(request.headers.authorization || '');
  if (!secret || expected.length !== received.length || !crypto.timingSafeEqual(expected, received)) {
    return response.status(401).json({ error: 'Non autorisé.' });
  }
  if (!accountPool || !accountStoreReady) return sendAccountUnavailable(response);
  try {
    const deleted = await purgeExpiredDocuments();
    await accountPool.query('DELETE FROM rate_limits WHERE reset_at <= NOW()');
    await accountPool.query('DELETE FROM account_sessions WHERE expires_at <= NOW()');
    return response.json({ deleted });
  } catch (error) {
    console.error('Purge des documents impossible :', error);
    return response.status(500).json({ error: 'Purge impossible.' });
  }
});

app.post('/api/callback-request', formRateLimit, async (request, response) => {
  let phone;
  try {
    phone = readCallbackPhone(request.body?.phone);
  } catch (error) {
    return response.status(400).json({ error: error.message });
  }

  try {
    await mailer.sendMail({
      from: process.env.MAIL_FROM,
      to: process.env.BUSINESS_EMAIL,
      subject: 'Demande de rappel depuis le site FacilePro',
      text: `Une demande de rappel a été reçue depuis le site FacilePro.\n\nNuméro de téléphone : ${phone}`
    });
    return response.json({ message: 'Votre demande de rappel a bien été envoyée.' });
  } catch (error) {
    console.error('Envoi de la demande de rappel impossible :', error);
    return response.status(502).json({ error: 'Impossible d’envoyer votre demande pour le moment. Réessayez plus tard.' });
  }
});

app.post('/api/checkout-session', formRateLimit, async (request, response) => {
  if (!accountPool || !accountStoreReady) {
    console.error('Base de données indisponible pour les devis :', accountStoreError);
    return response.status(503).json({ error: 'Le paiement est temporairement indisponible. Réessayez plus tard.' });
  }
  let quote;
  try {
    const clientName = readText(request.body?.clientName, 'Nom client', 120);
    const clientEmail = normalizeEmail(request.body?.clientEmail);
    const service = readText(request.body?.service, 'Prestation', 200);
    const aidAmountCents = toCents(request.body.aidAmount);
    const commissionCents = Math.round(aidAmountCents * 12 / 100);
    if (commissionCents < 50) throw new Error('La commission doit être d’au moins 0,50 € pour un paiement Stripe.');
    const signature = readSignature(request.body.signature);

    quote = {
      id: crypto.randomUUID(),
      clientName,
      clientEmail,
      service,
      aidAmountCents,
      commissionCents,
      signature,
      createdAt: new Date().toISOString(),
      paymentStatus: 'pending',
      documentsSentAt: null
    };
    await saveQuote(quote);

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      customer_email: clientEmail,
      client_reference_id: quote.id,
      metadata: { quoteId: quote.id },
      payment_intent_data: { metadata: { quoteId: quote.id } },
      line_items: [{
        quantity: 1,
        price_data: {
          currency: 'eur',
          unit_amount: commissionCents,
          product_data: {
            name: 'Commission d’accompagnement ARCE (12 %)',
            description: `Calculée sur le montant d’aide déclaré. ${service}`
          }
        }
      }],
      success_url: `${baseUrl}/?payment=success&session_id={CHECKOUT_SESSION_ID}#devis`,
      cancel_url: `${baseUrl}/?payment=cancelled#devis`
    });

    quote.checkoutSessionId = session.id;
    await saveQuote(quote);
    return response.json({ checkoutUrl: session.url });
  } catch (error) {
    if (error instanceof Stripe.errors.StripeError) {
      console.error('Création de la session Stripe impossible :', error.message);
      return response.status(502).json({ error: 'Stripe ne peut pas préparer le paiement actuellement. Réessayez plus tard.' });
    }
    if (error.message?.includes('invalide') || error.message?.includes('doit être') || error.message?.includes('au moins')) {
      return response.status(400).json({ error: error.message });
    }
    console.error('Création de paiement impossible :', error);
    return response.status(500).json({ error: 'Impossible de préparer le paiement. Réessayez plus tard.' });
  }
});

app.get('/api/payment-status', async (request, response) => {
  try {
    const sessionId = readText(request.query.session_id, 'Référence de paiement', 255);
    if (!/^cs_(test|live)_[A-Za-z0-9]+$/.test(sessionId)) throw new Error('Référence de paiement invalide.');
    const session = await stripe.checkout.sessions.retrieve(sessionId);
    const quoteId = session.metadata?.quoteId;
    if (!quoteId) return response.status(404).json({ error: 'Paiement introuvable.' });
    const quote = await loadQuote(quoteId);
    if (quote.checkoutSessionId !== session.id) return response.status(404).json({ error: 'Paiement introuvable.' });
    return response.json({
      paymentStatus: session.payment_status === 'paid' ? 'paid' : session.status,
      documentsSent: Boolean(quote.documentsSentAt)
    });
  } catch (error) {
    if (error instanceof Stripe.errors.StripeError) {
      console.error('Vérification auprès de Stripe impossible :', error.message);
      return response.status(502).json({ error: 'La vérification du paiement auprès de Stripe a échoué.' });
    }
    if (error.code === 'ENOENT') return response.status(404).json({ error: 'Paiement introuvable.' });
    if (error.message?.includes('invalide')) return response.status(400).json({ error: error.message });
    console.error('Lecture du statut de paiement impossible :', error);
    return response.status(500).json({ error: 'Impossible de vérifier le paiement.' });
  }
});

// En local, Express sert public/ ; sur Vercel, ce dossier est servi directement par le CDN.
app.use(express.static(path.join(directory, 'public')));

app.use((error, _request, response, _next) => {
  if (error.type === 'entity.too.large') {
    return response.status(413).json({ error: 'Fichier trop volumineux : 4 Mo maximum.' });
  }
  if (error.type === 'entity.parse.failed') return response.status(400).json({ error: 'Requête invalide.' });
  console.error('Erreur inattendue :', error);
  return response.status(500).json({ error: 'Une erreur est survenue.' });
});

async function initializeAccountStore() {
  if (!accountPool) {
    accountStoreError = new Error('DATABASE_URL n’est pas configurée.');
    console.warn('Espace client désactivé : configurez DATABASE_URL pour activer les comptes.');
    return;
  }

  try {
    await accountPool.query(`
      CREATE TABLE IF NOT EXISTS accounts (
        id UUID PRIMARY KEY,
        email TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        email_verified_at TIMESTAMPTZ,
        verification_token_hash TEXT,
        verification_expires_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS account_sessions (
        token_hash TEXT PRIMARY KEY,
        user_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        expires_at TIMESTAMPTZ NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS account_sessions_expiry_idx ON account_sessions (expires_at);
      CREATE TABLE IF NOT EXISTS quotes (
        id UUID PRIMARY KEY,
        client_email TEXT NOT NULL,
        data JSONB NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS quotes_client_email_idx ON quotes (client_email);
      CREATE TABLE IF NOT EXISTS arce_dossiers (
        account_id UUID PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
        remaining_days INTEGER NOT NULL,
        daily_allowance_cents INTEGER NOT NULL,
        reference_date DATE NOT NULL,
        status TEXT NOT NULL DEFAULT 'ouvert',
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS dossier_documents (
        id UUID PRIMARY KEY,
        account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        kind TEXT NOT NULL,
        mime TEXT NOT NULL,
        size INTEGER NOT NULL,
        iv BYTEA NOT NULL,
        auth_tag BYTEA NOT NULL,
        ciphertext BYTEA NOT NULL,
        uploaded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        expires_at TIMESTAMPTZ NOT NULL
      );
      CREATE INDEX IF NOT EXISTS dossier_documents_account_idx ON dossier_documents (account_id);
      CREATE INDEX IF NOT EXISTS dossier_documents_expiry_idx ON dossier_documents (expires_at);
      CREATE TABLE IF NOT EXISTS document_requests (
        id UUID PRIMARY KEY,
        account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        kinds TEXT[] NOT NULL,
        message TEXT,
        requested_by TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        resolved_at TIMESTAMPTZ
      );
      CREATE TABLE IF NOT EXISTS rate_limits (
        key TEXT PRIMARY KEY,
        hits INTEGER NOT NULL,
        reset_at TIMESTAMPTZ NOT NULL
      );
      ALTER TABLE accounts ADD COLUMN IF NOT EXISTS documents_pilot BOOLEAN NOT NULL DEFAULT FALSE;
      ALTER TABLE account_sessions ADD COLUMN IF NOT EXISTS admin_code_hash TEXT;
      ALTER TABLE account_sessions ADD COLUMN IF NOT EXISTS admin_code_expires_at TIMESTAMPTZ;
      ALTER TABLE account_sessions ADD COLUMN IF NOT EXISTS admin_code_attempts INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE account_sessions ADD COLUMN IF NOT EXISTS admin_verified_at TIMESTAMPTZ;
      CREATE TABLE IF NOT EXISTS document_access_log (
        id BIGSERIAL PRIMARY KEY,
        actor_email TEXT NOT NULL,
        account_id UUID,
        document_id UUID,
        action TEXT NOT NULL,
        at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    accountStoreReady = true;
  } catch (error) {
    accountStoreError = error;
    console.error('Initialisation PostgreSQL de l’espace client impossible :', error);
  }
}

await initializeAccountStore();

if (!process.env.VERCEL) {
  app.listen(port, () => console.log(`FacilePro est disponible sur http://localhost:${port}`));
}

export default app;
