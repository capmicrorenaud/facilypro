# Facilipro — site et paiements Stripe

Le formulaire crée une session Stripe Checkout côté serveur et encaisse seulement la commission de 12 % calculée sur le montant de l’aide saisi. La clé secrète Stripe ne va jamais dans le navigateur. Après confirmation du paiement par le webhook Stripe signé, le serveur génère le devis signé et la facture acquittée en PDF, puis les envoie à l’adresse du client par SMTP.

## Démarrage

1. Installer Node.js 20 ou une version ultérieure.
2. Exécuter `npm install`.
3. Copier `.env.example` vers `.env` et renseigner les variables.
4. Démarrer avec `npm start`.
5. Ouvrir `http://localhost:4242` — ne pas lancer la page via `file://`.

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

Les devis signés sont actuellement conservés sous `data/quotes/` sur le serveur ; le dossier est exclu du dépôt. **Ce stockage local n’est pas persistant sur Vercel et cette version ne doit pas y être mise en production telle quelle.** Pour héberger l’application sur Vercel, il faut migrer les devis/signatures vers une base de données persistante (par exemple PostgreSQL) et adapter les routes/API au déploiement choisi. Autre possibilité : héberger `server.mjs` sur un serveur Node.js avec disque persistant, HTTPS et sauvegardes.

## Informations restantes

Les mentions légales de la page affichent l’éditeur, l’adresse professionnelle `Route de Belcastel, 12390 Mayran, France`, le SIRET `10945831500016`, l’adresse `contact@facilipro.fr` et l’hébergeur Vercel Inc. L’adresse officielle et les coordonnées de l’hébergeur restent à confirmer avant publication. Vérifiez également que l’adresse du siège déclaré correspond bien à celle affichée. Les documents PDF générés sont des modèles : vérifiez les mentions de facturation applicables à votre activité avec un professionnel compétent avant d’encaisser des paiements réels.
