import test from 'node:test';
import assert from 'node:assert/strict';
import { luhnValid } from '../lib/rules.mjs';

process.env.LISTEN = 'false';
process.env.DATABASE_URL = 'pglite:memory';
process.env.MAIL_CAPTURE = 'true';
process.env.PUBLIC_BASE_URL = 'http://127.0.0.1:4242';
process.env.MAIL_FROM = 'Facile Pro <contact@facilepro.fr>';
process.env.BUSINESS_NAME = 'Facile Pro';
process.env.BUSINESS_EMAIL = 'contact@facilepro.fr';
process.env.BUSINESS_ADDRESS = 'Route de Belcastel, 12390 Mayran, France';
process.env.ADMIN_EMAILS = 'admin@exemple.test';
process.env.DOCUMENTS_UPLOAD_ENABLED = 'true';
process.env.DOCUMENTS_ENCRYPTION_KEY = '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff';
process.env.CRON_SECRET = 'secret-de-test';

const { default: app, getCapturedMail, clearCapturedMail } = await import('../server.mjs');

const server = await new Promise((resolve) => {
  const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
});
const base = `http://127.0.0.1:${server.address().port}`;

function withLuhn(body) {
  for (let digit = 0; digit <= 9; digit += 1) {
    const candidate = `${body}${digit}`;
    if (luhnValid(candidate)) return candidate;
  }
  throw new Error('Aucun chiffre de contrôle.');
}

const fictionalSiren = withLuhn('10000000');
const fictionalSiret = withLuhn(`${fictionalSiren}0001`);

async function request(path, { method = 'GET', cookie = '', body, raw } = {}) {
  const headers = {};
  if (cookie) headers.cookie = cookie;
  if (body) headers['content-type'] = 'application/json';
  if (raw) headers['content-type'] = 'application/octet-stream';
  const response = await fetch(`${base}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : raw
  });
  const setCookie = response.headers.getSetCookie?.().map((value) => value.split(';')[0]).join('; ') || '';
  const text = await response.text();
  let payload = null;
  try { payload = text ? JSON.parse(text) : null; } catch { payload = text; }
  return { status: response.status, payload, cookie: setCookie || cookie, headers: response.headers };
}

function tokenFrom(mail) {
  const match = mail.text.match(/verify-email=([0-9a-f]{64})/);
  assert.ok(match, 'lien de confirmation introuvable');
  return match[1];
}

function codeFrom(mail) {
  const match = mail.text.match(/(\d{6})/);
  assert.ok(match, 'code administrateur introuvable');
  return match[1];
}

function pngSignature() {
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64'
  );
  return `data:image/png;base64,${png.toString('base64')}`;
}

test('inscription, confirmation et connexion avec email capturé', async () => {
  clearCapturedMail();
  const registration = await request('/api/account/register', {
    method: 'POST',
    body: { email: 'camille.martin@exemple.test', password: 'motdepasse-test-12' }
  });
  assert.equal(registration.status, 200);
  const mail = getCapturedMail().at(-1);
  assert.equal(mail.to, 'camille.martin@exemple.test');
  assert.match(mail.subject, /Facile Pro/);

  const verification = await request('/api/account/verify-email', {
    method: 'POST',
    body: { token: tokenFrom(mail) }
  });
  assert.equal(verification.status, 200);
  assert.match(verification.cookie, /facilipro_session=/);

  const session = await request('/api/account/me', { cookie: verification.cookie });
  assert.equal(session.status, 200);
  assert.equal(session.payload.isAdmin, false);

  const adminPage = await request('/api/admin/quotes', { cookie: verification.cookie });
  assert.equal(adminPage.status, 403);
});

test('la signature ne déclenche aucun paiement et les documents restent bloqués', async () => {
  clearCapturedMail();
  const login = await request('/api/account/login', {
    method: 'POST',
    body: { email: 'camille.martin@exemple.test', password: 'motdepasse-test-12' }
  });
  const signed = await request('/api/quotes', {
    method: 'POST',
    cookie: login.cookie,
    body: {
      clientName: 'Camille Martin',
      clientEmail: 'camille.martin@exemple.test',
      service: 'Accompagnement ARCE',
      aidAmount: '10000',
      signature: pngSignature()
    }
  });
  assert.equal(signed.status, 200);
  assert.equal(signed.payload.paymentStarted, false);
  assert.equal(signed.payload.documentsIssued, false);
  assert.equal(signed.payload.quote.commissionCents, 120000);
  assert.equal(signed.payload.quote.secondInstallmentCommissionCents, 0);
  assert.equal(signed.payload.quote.paymentStatus, 'signature_enregistree');
  assert.ok(signed.payload.missingOfficialFields.includes('SIRET'));

  const legacy = await request('/api/checkout-session', { method: 'POST', body: {} });
  assert.equal(legacy.status, 410);

  const quotes = await request('/api/account/quotes', { cookie: login.cookie });
  assert.equal(quotes.payload.quotes.length, 1);
  assert.equal(getCapturedMail().some((mail) => mail.subject.includes('facture')), false);
});

test('l’administration confirme le règlement unique puis émet les documents', async () => {
  clearCapturedMail();
  const registration = await request('/api/account/register', {
    method: 'POST',
    body: { email: 'admin@exemple.test', password: 'administration-test-12' }
  });
  assert.equal(registration.status, 200);
  const verification = await request('/api/account/verify-email', {
    method: 'POST',
    body: { token: tokenFrom(getCapturedMail().at(-1)) }
  });
  let cookie = verification.cookie;

  const withoutCode = await request('/api/admin/company', { cookie });
  assert.equal(withoutCode.status, 403);
  assert.equal(withoutCode.payload.code, 'admin_code_required');

  await request('/api/admin/code/request', { method: 'POST', cookie });
  const codeMail = getCapturedMail().at(-1);
  assert.equal(codeMail.to, 'admin@exemple.test');
  const verified = await request('/api/admin/code/verify', {
    method: 'POST',
    cookie,
    body: { code: codeFrom(codeMail) }
  });
  assert.equal(verified.status, 200);

  const dossiers = await request('/api/admin/dossiers', { cookie });
  assert.equal(dossiers.status, 200);

  const clientQuotes = await request('/api/admin/quotes', { cookie });
  const quoteId = clientQuotes.payload.quotes[0].id;
  const refused = await request(`/api/admin/quotes/${quoteId}/confirm-settlement`, {
    method: 'POST',
    cookie,
    body: { firstArceInstallmentReceived: false }
  });
  assert.equal(refused.status, 400);

  const blocked = await request(`/api/admin/quotes/${quoteId}/confirm-settlement`, {
    method: 'POST',
    cookie,
    body: { firstArceInstallmentReceived: true }
  });
  assert.equal(blocked.status, 200);
  assert.equal(blocked.payload.documentsIssued, false);
  assert.equal(blocked.payload.quote.commissionCents, 120000);
  assert.equal(blocked.payload.quote.secondInstallmentCommissionCents, 0);
  assert.ok(blocked.payload.missingOfficialFields.includes('SIREN'));

  const retired = await request('/api/admin/company', {
    method: 'PUT',
    cookie,
    body: {
      legalName: 'Ancienne structure',
      presidentName: 'Camille Martin',
      registeredOffice: '1 rue fictive',
      shareCapitalEuros: '100',
      siren: '109458315',
      siret: '10945831500016',
      rcs: 'RCS radié',
      openingDate: '2026-12-05'
    }
  });
  assert.equal(retired.status, 400);

  const profile = await request('/api/admin/company', {
    method: 'PUT',
    cookie,
    body: {
      legalName: 'SASU fictive de test',
      presidentName: 'Camille Martin',
      registeredOffice: '1 rue fictive, 75000 Paris',
      shareCapitalEuros: '100',
      siren: fictionalSiren,
      siret: fictionalSiret,
      rcs: 'RCS Paris, identifiant fictif de test',
      openingDate: '2026-12-05'
    }
  });
  assert.equal(profile.status, 200, JSON.stringify(profile.payload));
  assert.equal(profile.payload.ready, true);

  clearCapturedMail();
  const issued = await request(`/api/admin/quotes/${quoteId}/confirm-settlement`, {
    method: 'POST',
    cookie,
    body: { firstArceInstallmentReceived: true }
  });
  assert.equal(issued.status, 200);
  assert.equal(issued.payload.documentsIssued, true);
  assert.equal(issued.payload.quote.commissionCents, 120000);
  const invoice = getCapturedMail().at(-1);
  assert.equal(invoice.to, 'camille.martin@exemple.test');
  assert.equal(invoice.attachments.length, 2);
  assert.equal(invoice.attachments[0].content.subarray(0, 4).toString(), '%PDF');
  assert.match(invoice.text, /second versement : 0 €/);

  const repeated = await request(`/api/admin/quotes/${quoteId}/confirm-settlement`, {
    method: 'POST',
    cookie,
    body: { firstArceInstallmentReceived: true }
  });
  assert.equal(repeated.payload.quote.commissionCents, 120000);
  assert.equal(repeated.payload.quote.secondInstallmentCommissionCents, 0);

  const preparation = await request('/api/admin/preparation', { cookie });
  assert.equal(preparation.payload.published, false);
  assert.ok(preparation.payload.ads.every((draft) => draft.status === 'brouillon_non_diffuse'));

  const suivi = await request('/api/admin/suivi', { cookie });
  assert.ok(suivi.payload.quotes.some((quote) => quote.paymentStatus === 'reglement_unique_confirme'));
});

test('un client ne lit pas le document d’un autre compte', async () => {
  const login = await request('/api/account/login', {
    method: 'POST',
    body: { email: 'camille.martin@exemple.test', password: 'motdepasse-test-12' }
  });
  const upload = await request('/api/account/documents?kind=identite', {
    method: 'POST',
    cookie: login.cookie,
    raw: Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF')
  });
  assert.equal(upload.status, 200, JSON.stringify(upload.payload));
  const other = await request(`/api/account/documents/${upload.payload.id}`);
  assert.equal(other.status, 401);
  const download = await request(`/api/account/documents/${upload.payload.id}`, { cookie: login.cookie });
  assert.equal(download.status, 200);
  assert.match(download.headers.get('content-type'), /pdf/);
});

test.after(() => {
  server.close();
});
