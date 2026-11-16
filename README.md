# Facile Pro

Site d’accompagnement ARCE. Le nom affiché est Facile Pro. La signature d’un devis n’entraîne aucun paiement en ligne.

La commission est unique : 12 % du montant total de l’ARCE accordée. Elle devient exigible après réception du premier versement, puis un administrateur la confirme. Aucune commission n’est due sur le second versement. Cette confirmation clôture les frais du dossier.

Les documents commerciaux (devis PDF et facture) ne sont émis que si les informations officielles de la SASU sont complètes. L’ouverture est prévue le 5 décembre 2026. Les identifiants se saisissent dans l’administration ; ceux de l’ancienne entreprise radiée sont refusés. Aucun identifiant n’est inventé dans le site.

## Démarrage

1. Installer Node.js 20 ou une version ultérieure.
2. Exécuter `npm install`.
3. Copier `.env.example` vers `.env` et renseigner une base PostgreSQL ainsi qu’un SMTP de test.
4. Démarrer avec `npm start`, puis ouvrir l’URL indiquée. Ne pas ouvrir la page via `file://`.

`npm run preview` démarre une prévisualisation locale sur PostgreSQL (`data/postgres`). Les comptes, dossiers, pièces, devis et emails locaux restent après un redémarrage. `npm run backup` écrit une sauvegarde dans `data/backups`. Aucun email réel ne part tant que le SMTP n’est pas renseigné. `npm test` vérifie le calcul, les droits, la persistance après redémarrage, la sauvegarde et la restauration.

Le site n’est pas prêt pour de vrais clients tant que ces éléments manquent : une base PostgreSQL de production (`DATABASE_URL`), un SMTP réel (`SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`), une clé `DOCUMENTS_ENCRYPTION_KEY` conservée hors du dépôt, `CRON_SECRET`, `ADMIN_EMAILS`, puis les identifiants officiels de la SASU après immatriculation. Ne pas les inventer et ne pas réutiliser ceux de l’entreprise radiée. `/api/ready` indique `readyForRealClients: false` tant que ce n’est pas le cas.

## Espace client et administration

L’inscription envoie un lien de confirmation. Les devis signés sont rattachés à l’adresse email vérifiée. Les pièces justificatives restent chiffrées, réservées au client et aux administrateurs, puis journalisées. Le tableau de bord `/admin.html` demande un code email, permet de compléter la SASU, de suivre les demandes, de confirmer le règlement unique et de relire les brouillons publicitaires. Ces brouillons ne sont pas diffusés.

## Référencement

`sitemap.xml` et `robots.txt` préparent l’indexation de la page publique et excluent l’administration. La soumission à Google Search Console et toute prévisualisation Vercel restent à faire après validation. Ne pas les lancer pendant cette reprise.

## Informations officielles

Tant que la dénomination, le président, le siège, le capital, le SIREN, le SIRET et le RCS ne sont pas enregistrés, les mentions légales indiquent que les identifiants ne sont pas encore attribués. L’adresse de contact actuelle reste Route de Belcastel, 12390 Mayran. Le siège de la SASU n’est affiché qu’après saisie réelle.
