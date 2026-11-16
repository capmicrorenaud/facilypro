import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  commercialDocumentsAllowed,
  commissionOnGrantedArce,
  computeArce,
  luhnValid,
  missingOfficialLabels,
  readOfficialUpdate,
  RETIRED_SIRET
} from '../lib/rules.mjs';

test('la commission est de 12 % du total ARCE et rien sur le second versement', () => {
  const estimate = computeArce(100, 5000, '2026-12-05');
  assert.equal(estimate.remainingRightsCents, 500000);
  assert.equal(estimate.grossCapitalCents, 300000);
  assert.equal(estimate.retirementDeductionCents, 9000);
  assert.equal(estimate.netCapitalCents, 291000);
  assert.equal(estimate.firstPaymentCents + estimate.secondPaymentCents, 291000);
  assert.equal(estimate.commissionCents, 34920);
  assert.equal(estimate.secondInstallmentCommissionCents, 0);
  assert.equal(estimate.totalDueCents, 34920);
  assert.equal(estimate.secondPaymentDate, '2027-06-05');

  const granted = commissionOnGrantedArce(1000000);
  assert.equal(granted.commissionCents, 120000);
  assert.equal(granted.secondInstallmentCommissionCents, 0);
});

test('le profil SASU incomplet bloque les documents et refuse l’ancien SIRET', () => {
  assert.equal(commercialDocumentsAllowed({ legalForm: 'SASU', openingDate: '2026-12-05' }), false);
  assert.ok(missingOfficialLabels({}).includes('SIRET'));

  const retired = readOfficialUpdate({
    legalName: 'SASU exemple',
    presidentName: 'Camille Martin',
    registeredOffice: '1 rue fictive, 75000 Paris',
    shareCapitalEuros: '100',
    siren: '109458315',
    siret: RETIRED_SIRET,
    rcs: 'RCS test',
    openingDate: '2026-12-05'
  });
  assert.ok(retired.errors.some((error) => error.includes('ancienne entreprise')));
  assert.equal(luhnValid(RETIRED_SIRET), true);
});

test('le site public ne réintroduit pas Stripe ni l’ancien SIRET', async () => {
  const [page, server, admin] = await Promise.all([
    readFile(new URL('../public/index.html', import.meta.url), 'utf8'),
    readFile(new URL('../server.mjs', import.meta.url), 'utf8'),
    readFile(new URL('../public/admin.html', import.meta.url), 'utf8')
  ]);
  for (const source of [page, server, admin]) {
    assert.equal(source.includes('stripe'), false);
    assert.equal(source.includes(RETIRED_SIRET), false);
    assert.equal(source.includes('Belcastel'), false);
  }
  assert.match(page, /Facile Pro/);
  assert.match(page, /Signer le devis/);
  assert.match(admin, /Confirmer le règlement unique/);
  assert.match(admin, /brouillon/);
});
