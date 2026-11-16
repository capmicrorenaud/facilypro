export const adDrafts = [
  {
    id: 'recherche-arce-accompagnement',
    channel: 'Recherche',
    status: 'brouillon_non_diffuse',
    headline: 'Accompagnement ARCE',
    description: 'Étude du dossier, devis signé sans paiement immédiat, commission unique de 12 % après le premier versement.',
    note: 'Brouillon interne. Ne pas diffuser tant que la SASU n’est pas immatriculée et que la prévisualisation n’est pas validée.'
  },
  {
    id: 'recherche-commission-unique',
    channel: 'Recherche',
    status: 'brouillon_non_diffuse',
    headline: 'Commission unique de 12 %',
    description: '12 % du montant total de l’ARCE accordée. Rien n’est dû sur le second versement.',
    note: 'Aucun budget, aucune campagne et aucune diffusion ne sont associés à ce texte.'
  },
  {
    id: 'local-suivi-dossier',
    channel: 'Réseau local',
    status: 'brouillon_non_diffuse',
    headline: 'Suivi de dossier ARCE',
    description: 'Espace client pour suivre le devis, les pièces demandées et l’avancement administratif.',
    note: 'À relire avant toute utilisation. Ne pas publier depuis cette reprise.'
  }
];

export const seoChecklist = [
  { id: 'title', label: 'Titre et description de la page d’accueil', done: true },
  { id: 'canonical', label: 'Lien canonique vers https://www.facilepro.fr/', done: true },
  { id: 'sitemap', label: 'sitemap.xml limité à la page publique', done: true },
  { id: 'robots', label: 'robots.txt autorise le site et interdit /admin.html et /api/', done: true },
  { id: 'admin-noindex', label: 'Page d’administration en noindex', done: true },
  { id: 'ads', label: 'Brouillons publicitaires conservés hors ligne', done: true },
  { id: 'search-console', label: 'Soumission Google Search Console', done: false, blockedBy: 'À faire après validation, sans changer la production pendant la reprise.' },
  { id: 'vercel-preview', label: 'Prévisualisation Vercel de cette branche', done: false, blockedBy: 'Aucun déploiement n’est lancé depuis cette reprise.' }
];
