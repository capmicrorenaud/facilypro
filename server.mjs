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

const accountRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  handler: (_request, response) => response.status(429).json({ error: 'Trop de tentatives. Réessayez dans quelques minutes.' })
});

const formRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 8,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  handler: (_request, response) => response.status(429).json({ error: 'Trop de demandes. Réessayez dans quelques minutes.' })
});

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
    `SELECT accounts.id, accounts.email
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

app.set('trust proxy', 1);
app.disable('x-powered-by');

app.use((_request, response, next) => {
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('X-Frame-Options', 'DENY');
  response.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  response.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
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
    return response.json({ email: account.email });
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
