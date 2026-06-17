'use strict';

// Dossiers KYC déterministes (épreuve 3). Asymétrie d'information : ces dossiers ne sont
// servis QUE par l'endpoint /kyc (GUI métier), jamais via l'API transactions ni en base.
// Ils ne disent JAMAIS « mule » — ils rendent la légitimité ÉVIDENTE (faux positifs :
// compte ancien, activité cohérente) ou DOUTEUSE (mules : compte récent, activité incohérente),
// pour que l'analyste écarte les faux positifs par la lecture, pas par une étiquette.

const DAY_MS = 86400000;

function hashStr(s) {
  let h = 2166136261 >>> 0;
  for (const ch of String(s)) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h;
}

const LEGIT_ACTIVITIES = [
  { type: 'commerce', activity: 'Encaissements clients réguliers (commerce de détail)' },
  { type: 'PME', activity: 'Virements fournisseurs et paie mensuelle' },
  { type: 'profession_liberale', activity: 'Honoraires de clientèle établie' },
  { type: 'association', activity: 'Cotisations et subventions récurrentes' },
];

/**
 * Construit un dossier KYC déterministe pour un compte donné, selon son rôle dans le dataset.
 * @param {string} account
 * @param {{ mules: string[], falsePositives: string[] }} dataset
 * @param {number} [now]
 */
function kycFor(account, dataset, now = Date.UTC(2026, 5, 17)) {
  const h = hashStr(account);
  const isMule = dataset.mules.includes(account);
  const isFp = dataset.falsePositives.includes(account);

  if (isMule) {
    const openedDaysAgo = 4 + (h % 25); // 4–28 jours : compte très récent
    return {
      account,
      openedAt: new Date(now - openedDaysAgo * DAY_MS).toISOString().slice(0, 10),
      accountAgeDays: openedDaysAgo,
      declaredActivityType: 'particulier',
      declaredActivity: 'Compte personnel — revenus salariés déclarés modestes',
      kycReview: 'incomplet',
      riskFlags: [
        'Compte ouvert récemment',
        'Flux entrants sans rapport avec l’activité déclarée',
        'Pièces justificatives manquantes',
      ],
    };
  }

  if (isFp) {
    const a = LEGIT_ACTIVITIES[h % LEGIT_ACTIVITIES.length];
    const openedYearsAgo = 3 + (h % 12); // 3–14 ans : compte ancien et établi
    return {
      account,
      openedAt: new Date(now - openedYearsAgo * 365 * DAY_MS).toISOString().slice(0, 10),
      accountAgeDays: openedYearsAgo * 365,
      declaredActivityType: a.type,
      declaredActivity: a.activity,
      kycReview: 'complet',
      riskFlags: [], // légitimité évidente : ancienneté + activité cohérente avec les flux
    };
  }

  // Compte de bruit : dossier générique minimal.
  const openedYearsAgo = 1 + (h % 10);
  return {
    account,
    openedAt: new Date(now - openedYearsAgo * 365 * DAY_MS).toISOString().slice(0, 10),
    accountAgeDays: openedYearsAgo * 365,
    declaredActivityType: 'particulier',
    declaredActivity: 'Compte personnel',
    kycReview: 'complet',
    riskFlags: [],
  };
}

module.exports = { kycFor };
