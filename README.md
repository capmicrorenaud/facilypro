# FacilePro — site et paiements Stripe

Le formulaire crée une session Stripe Checkout côté serveur et encaisse seulement la commission de 12 % calculée sur le montant de l’aide saisi. La clé secrète Stripe ne va jamais dans le navigateur. Après confirmation du paiement par le webhook Stripe signé, le serveur génère le devis signé et la facture acquittée en PDF, puis les envoie à l’adresse du client par SMTP.

Le formulaire « Être rappelé(e) » valide un numéro français et envoie une demande de rappel à `BUSINESS_EMAIL` via le SMTP configuré (`contact@facilipro.fr`). Le numéro professionnel affiché dans l’en-tête ouvre également un appel téléphonique.

La page d’accueil est publique ; l’inscription et l’espace client utilisent PostgreSQL (`DATABASE_URL`). Au démarrage, le serveur crée les tables de comptes et de sessions si elles n’existent pas. L’inscription envoie un lien de confirmation par SMTP et nécessite une `PUBLIC_BASE_URL` accessible aux utilisateurs. Sans `DATABASE_URL`, le site reste accessible, mais l’inscription et la connexion sont désactivées.

Après connexion, les devis du compte sont retrouvés à partir de l’adresse email vérifiée. Les devis (avec signature) sont stockés dans la table PostgreSQL `quotes`, créée automatiquement au démarrage : `DATABASE_URL` est donc obligatoire pour encaisser des paiements.

Le projet contient `sitemap.xml` et `robots.txt`. Après avoir déployé le site sur son domaine public et vérifié que ces deux fichiers y sont servis, soumettez `https://facilipro.fr/sitemap.xml` dans la rubrique « Sitemaps » de Google Search Console. Adaptez leur domaine si le domaine public du site change.

## Dossier ARCE et pièces justificatives

Dans l’espace client, le client renseigne ses jours restants, son allocation journalière brute et sa date de référence (début d’activité). Le calculateur applique les règles de service-public.gouv.fr (fiche F15252) : 60 % du capital restant des droits ARE, moins 3 % de participation aux retraites complémentaires, versés en deux moitiés à 6 mois d’intervalle ; la commission FacilePro est de 12 % de l’ARCE estimée. Un lien mène au modèle officiel de déclaration de non-condamnation et de filiation (RCS/RNE).

Le client peut déposer trois pièces (pièce d’identité, attestation de droits France Travail, justificatif du reliquat ARE) : PDF, JPEG ou PNG, 4 Mo maximum, format vérifié sur le contenu du fichier. Les fichiers sont chiffrés en AES-256-GCM avec `DOCUMENTS_ENCRYPTION_KEY` avant d’être stockés dans PostgreSQL, accessibles seulement au client et aux comptes listés dans `ADMIN_EMAILS`, et chaque accès est inscrit dans `document_access_log`. Ils sont supprimés après `DOCUMENTS_RETENTION_DAYS` jours (90 par défaut) par une tâche Vercel Cron quotidienne (`/api/cron/purge-documents`, protégée par `CRON_SECRET`), à la clôture du dossier par un administrateur, ou par le client lui-même. Aucun document n’est envoyé par email : la demande de pièces manquantes envoie seulement une invitation à se connecter.

Le dépôt reste fermé tant que `DOCUMENTS_UPLOAD_ENABLED` ne vaut pas `true`. Le tableau de bord administrateur est disponible sur `/admin.html` pour un compte vérifié listé dans `ADMIN_EMAILS`.

## Démarrage

1. Installer Node.js 20 ou une version ultérieure.
2. Exécuter `npm install`.
3. Copier `.env.example` vers `.env` et renseigner les variables.
4. Renseigner `DATABASE_URL` avec l’URL de votre base PostgreSQL pour activer les comptes clients.
5. Démarrer avec `npm start`.
6. Ouvrir `http://localhost:4242` — ne pas lancer la page via `file://`.

Ne publiez jamais `.env`. `STRIPE_SECRET_KEY` doit être une clé test (`sk_test_...`) pour les essais, et une clé live uniquement après validation. Configurez un SMTP autorisé à envoyer au nom de `contact@facilipro.fr`.

## Webhook Stripe

Dans le tableau de bord Stripe, ajoutez l’URL publique `https://votre-domaine/api/stripe-webhook` et activez :

- `checkout.session.completed`
- `checkout.session.async_payment_succeeded`

Placez le secret `whsec_...` fourni pour ce webhook dans `STRIPE_WEBHOOK_SECRET`. En local, utilisez Stripe CLI :

```text
stripe listen --forward-to localhost:4242/api/stripe-webhook
```

Utilisez le secret de signature communiqué par Stripe CLI pour les essais locaux. Faites un paiement de test et vérifiez la réception des deux pièces jointes avant d’activer les paiements réels.

## Hébergement Vercel

`server.mjs` exporte l’application Express (détectée automatiquement par Vercel) ; les fichiers publics (`index.html`, `robots.txt`, `sitemap.xml`) sont dans `public/`. Toutes les variables de `.env.example` doivent être renseignées dans Vercel → Settings → Environment Variables, avec `PUBLIC_BASE_URL=https://facilipro.fr`. Si une variable manque, la page reste visible mais les formulaires répondent « en cours de configuration ».

## Informations restantes

Les mentions légales de la page affichent l’éditeur, l’adresse professionnelle `Route de Belcastel, 12390 Mayran, France`, le SIRET `10945831500016`, l’adresse `contact@facilipro.fr`, l’hébergeur Vercel Inc. et une politique de confidentialité. Vérifiez également que l’adresse du siège déclaré correspond bien à celle affichée. Les documents PDF générés sont des modèles : vérifiez les mentions de facturation applicables à votre activité avec un professionnel compétent avant d’encaisser des paiements réels.
