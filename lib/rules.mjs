export const DISPLAY_NAME = 'Facile Pro';
export const PLANNED_SASU_OPENING_DATE = '2026-12-05';
export const RETIRED_SIREN = '109458315';
export const RETIRED_SIRET = '10945831500016';

export const paymentTerms = [
  'Commission unique de 12 % du montant total de l’ARCE accordée.',
  'Cette commission est exigible après réception du premier versement de l’ARCE, puis confirmée par l’administration.',
  'Aucune commission supplémentaire n’est due sur le second versement.',
  'La signature du devis ne déclenche aucun paiement.',
  'Le règlement unique clôture le dossier.'
];

export function computeArce(remainingDays, dailyAllowanceCents, referenceDate) {
  const remainingRightsCents = remainingDays * dailyAllowanceCents;
  const grossCapitalCents = Math.round(remainingRightsCents * 0.6);
  const retirementDeductionCents = Math.round(grossCapitalCents * 0.03);
  const netCapitalCents = grossCapitalCents - retirementDeductionCents;
  const firstPaymentCents = Math.round(netCapitalCents / 2);
  const secondPaymentDate = new Date(`${referenceDate}T00:00:00Z`);
  secondPaymentDate.setUTCMonth(secondPaymentDate.getUTCMonth() + 6);
  const commissionCents = Math.round(netCapitalCents * 0.12);
  return {
    remainingRightsCents,
    grossCapitalCents,
    retirementDeductionCents,
    netCapitalCents,
    firstPaymentCents,
    firstPaymentDate: referenceDate,
    secondPaymentCents: netCapitalCents - firstPaymentCents,
    secondPaymentDate: secondPaymentDate.toISOString().slice(0, 10),
    commissionCents,
    secondInstallmentCommissionCents: 0,
    totalDueCents: commissionCents
  };
}

export function commissionOnGrantedArce(aidAmountCents) {
  const commissionCents = Math.round(aidAmountCents * 12 / 100);
  return {
    aidAmountCents,
    commissionCents,
    secondInstallmentCommissionCents: 0,
    totalDueCents: commissionCents
  };
}

export function luhnValid(digits) {
  if (!/^\d+$/.test(digits)) return false;
  let sum = 0;
  let alternate = false;
  for (let index = digits.length - 1; index >= 0; index -= 1) {
    let digit = Number(digits[index]);
    if (alternate) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    alternate = !alternate;
  }
  return sum % 10 === 0;
}

function cleanText(value, maxLength) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  if (!text) return null;
  if (text.length > maxLength) return undefined;
  return text;
}

export function readOfficialUpdate(body) {
  const source = body && typeof body === 'object' ? body : {};
  const errors = [];
  const take = (key, label, maxLength) => {
    const value = cleanText(source[key], maxLength);
    if (value === undefined) errors.push(`${label} est invalide.`);
    return value ?? null;
  };

  let shareCapitalCents = null;
  if (source.shareCapitalEuros !== undefined && source.shareCapitalEuros !== null && source.shareCapitalEuros !== '') {
    const amount = Number(String(source.shareCapitalEuros).trim().replace(',', '.'));
    if (!Number.isFinite(amount) || amount <= 0 || amount > 100000000) {
      errors.push('Le capital social est invalide.');
    } else {
      shareCapitalCents = Math.round(amount * 100);
    }
  }

  const openingDate = cleanText(source.openingDate, 10) || PLANNED_SASU_OPENING_DATE;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(openingDate)) errors.push('La date d’ouverture prévue est invalide.');

  const profile = {
    legalName: take('legalName', 'La dénomination sociale', 200),
    legalForm: 'SASU',
    openingDate,
    presidentName: take('presidentName', 'Le président', 200),
    registeredOffice: take('registeredOffice', 'L’adresse du siège', 300),
    shareCapitalCents,
    siren: take('siren', 'Le SIREN', 9),
    siret: take('siret', 'Le SIRET', 14),
    rcs: take('rcs', 'L’immatriculation RCS', 200),
    vatNumber: take('vatNumber', 'Le numéro de TVA', 20)
  };

  if (profile.siren && (!/^\d{9}$/.test(profile.siren) || !luhnValid(profile.siren))) {
    errors.push('Le SIREN doit comporter 9 chiffres valides. N’utilisez pas un identifiant inventé.');
  }
  if (profile.siret && (!/^\d{14}$/.test(profile.siret) || !luhnValid(profile.siret))) {
    errors.push('Le SIRET doit comporter 14 chiffres valides. N’utilisez pas un identifiant inventé.');
  }
  if (profile.siren === RETIRED_SIREN || profile.siret === RETIRED_SIRET || (profile.siret || '').startsWith(RETIRED_SIREN)) {
    errors.push('L’identifiant de l’ancienne entreprise radiée ne peut pas être réutilisé.');
  }
  if (profile.siren && profile.siret && !profile.siret.startsWith(profile.siren)) {
    errors.push('Le SIRET doit commencer par le SIREN de la SASU.');
  }
  if (profile.vatNumber && !/^FR[0-9A-Z]{2}\d{9}$/.test(profile.vatNumber)) {
    errors.push('Le numéro de TVA est invalide. Laissez le champ vide s’il n’est pas encore attribué.');
  }

  return { profile, errors };
}

export function missingOfficialLabels(profile) {
  const missing = [];
  if (!profile?.legalName) missing.push('Dénomination sociale');
  if (!profile?.presidentName) missing.push('Président de la SASU');
  if (!profile?.registeredOffice) missing.push('Adresse du siège social');
  if (!profile?.shareCapitalCents) missing.push('Capital social');
  if (!profile?.siren) missing.push('SIREN');
  if (!profile?.siret) missing.push('SIRET');
  if (!profile?.rcs) missing.push('Immatriculation RCS');
  if (profile?.legalForm && profile.legalForm !== 'SASU') missing.push('Forme juridique SASU');
  return missing;
}

export function commercialDocumentsAllowed(profile) {
  return missingOfficialLabels(profile).length === 0;
}
