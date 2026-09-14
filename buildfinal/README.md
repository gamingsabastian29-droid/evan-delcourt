# Evan_Delcourt — serveur comptes FREE/VIP + Stripe

Cette version est prête pour un **hébergement qui exécute Node.js**. Le site et son API sont servis par le même serveur Express, donc les formulaires de création de compte et de connexion utilisent directement `/api/...` et ne dépendent pas de GitHub Pages.

## Ce qui fonctionne côté serveur
- 👤 Création de compte avec **nom/pseudo + courriel + mot de passe**
- 🔐 Connexion / déconnexion avec session sécurisée
- 🔔 Compte **FREE** par défaut
- ⭐ Compte **VIP** après abonnement Stripe actif
- 💳 Stripe Checkout à **4,99 $/mois**
- 🔄 Synchronisation VIP par webhook Stripe
- 🛡️ Contenu VIP vérifié côté serveur
- 🏆 Classement FREE/VIP depuis la base de données
- 🩺 Endpoint `/health` pour vérifier que le serveur est en ligne
- 💾 SQLite pour les comptes

## Mise en ligne
1. Envoie ce projet sur ton hébergeur Node.js (Render, Railway, VPS ou autre hébergement Node).
2. Configure les variables d'environnement suivantes dans le tableau de bord de l'hébergeur :

```text
STRIPE_SECRET_KEY=sk_live_...
STRIPE_WEBHOOK_SECRET=whsec_...
STRIPE_PRICE_ID=price_...
SESSION_SECRET=une-longue-valeur-aleatoire-d-au-moins-32-caracteres
BASE_URL=https://ton-domaine.com
PORT=3000
NODE_ENV=production
```

**Ne mets jamais une clé secrète Stripe dans `public/` ou dans le JavaScript du navigateur.**

3. Commande d'installation : `npm install`
4. Commande de démarrage : `npm start`
5. Vérifie `https://ton-domaine.com/health` : la réponse doit contenir `{"ok":true}`.

## Stripe Webhook
Dans Stripe, configure :

`POST https://ton-domaine.com/api/stripe/webhook`

Événements utilisés :
- `checkout.session.completed`
- `customer.subscription.updated`
- `customer.subscription.deleted`

Le webhook doit utiliser le secret `STRIPE_WEBHOOK_SECRET` fourni par Stripe.

## Important pour GitHub
GitHub peut héberger les fichiers statiques, mais **GitHub Pages ne fait pas tourner `server.js`**. Pour cette version, déploie le dossier complet sur un hébergeur Node.js. Le navigateur et l'API seront alors sur le même domaine et l'erreur « Échec de la récupération » ne viendra plus d'une API absente sur GitHub Pages.

## Base de données
`members.db` est créé automatiquement au démarrage. Pour une vraie production avec plusieurs instances, utilise une base de données persistante/externe ou un disque persistant fourni par ton hébergeur.
