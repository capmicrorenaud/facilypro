process.env.LISTEN = 'true';
process.env.PREVIEW = 'true';
process.env.PORT = process.env.PORT || '4242';
process.env.DATABASE_URL = 'pglite:memory';
process.env.MAIL_CAPTURE = 'true';
process.env.PUBLIC_BASE_URL = `http://127.0.0.1:${process.env.PORT}`;
process.env.MAIL_FROM = 'Facile Pro <contact@facilepro.fr>';
process.env.BUSINESS_NAME = 'Facile Pro';
process.env.BUSINESS_EMAIL = 'contact@facilepro.fr';
process.env.BUSINESS_ADDRESS = 'Route de Belcastel, 12390 Mayran, France';
process.env.ADMIN_EMAILS = 'admin@exemple.test';
process.env.DOCUMENTS_UPLOAD_ENABLED = 'true';
process.env.DOCUMENTS_ENCRYPTION_KEY = process.env.DOCUMENTS_ENCRYPTION_KEY
  || '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff';
process.env.CRON_SECRET = 'apercu-local-uniquement';

await import('../server.mjs');
console.log('Prévisualisation locale isolée. Aucun email réel, aucun paiement, données effacées à l’arrêt.');
console.log('Compte administrateur de démonstration à créer : admin@exemple.test');
