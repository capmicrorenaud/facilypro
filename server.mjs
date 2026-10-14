import 'dotenv/config';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import nodemailer from 'nodemailer';
import PDFDocument from 'pdfkit';
import Stripe from 'stripe';

const directory = path.dirname(fileURLToPath(import.meta.url));
const dataDirectory = path.join(directory, 'data', 'quotes');
const port = Number(process.env.PORT || 4242);
const baseUrl = process.env.PUBLIC_BASE_URL;
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
  'BUSINESS_ADDRESS'
];
const missingSettings = requiredSettings.filter((setting) => !process.env[setting]);

if (missingSettings.length) {
  console.error(`Configuration manquante dans .env : ${missingSettings.join(', ')}`);
  process.exit(1);
}

if (!/^https?:\/\//i.test(baseUrl)) {
  console.error('PUBLIC_BASE_URL doit être une URL http(s) valide.');
  process.exit(1);
}

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const mailer = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: Number(process.env.SMTP_PORT),
  secure: process.env.SMTP_SECURE === 'true',
  auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
});
const app = express();
const processing = new Set();

function formatMoney(cents) {
  return new Intl.NumberFormat('fr-FR', { style: 'currency', currency: 'EUR' }).format(cents / 100);
}

function readText(value, label, maxLength) {
  if (typeof value !== 'string') throw new Error(`${label} invalide.`);
  const text = value.trim();
  if (!text || text.length > maxLength) throw new Error(`${label} invalide.`);
  return text;
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

function quotePath(id) {
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new Error('Référence de devis invalide.');
  return path.join(dataDirectory, `${id}.json`);
}

async function saveQuote(quote) {
  await fs.mkdir(dataDirectory, { recursive: true });
  const destination = quotePath(quote.id);
  const temporary = `${destination}.${crypto.randomUUID()}.tmp`;
  await fs.writeFile(temporary, JSON.stringify(quote), { flag: 'wx', mode: 0o600 });
  await fs.rename(temporary, destination);
}

async function loadQuote(id) {
  return JSON.parse(await fs.readFile(quotePath(id), 'utf8'));
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

app.post('/api/checkout-session', async (request, response) => {
  let quote;
  try {
    const clientName = readText(request.body.clientName, 'Nom client', 120);
    const clientEmail = readText(request.body.clientEmail, 'Adresse email', 254);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(clientEmail)) throw new Error('Adresse email invalide.');
    const service = readText(request.body.service, 'Prestation', 200);
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

app.get('/', (_request, response) => response.sendFile(path.join(directory, 'index.html')));

app.listen(port, () => console.log(`Facilipro est disponible sur ${baseUrl}`));
