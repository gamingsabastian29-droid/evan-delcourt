CORRECTION COMPTES / BASE DE DONNEES RENDER

Le serveur utilise maintenant DB_PATH pour la base SQLite.

SUR RENDER :
1. Ouvre le service evan-delcourt-site.
2. Settings -> Disks -> Add Disk.
3. Mount Path : /var/data
4. Taille : 1 GB suffit pour commencer.
5. Dans Environment -> ajoute :
   DB_PATH=/var/data/members.db
6. Redéploie le service.

IMPORTANT :
- Le disque persistant doit être attaché AVANT le prochain déploiement si tu veux conserver une base existante.
- Si les anciens comptes ont déjà été effacés par un précédent déploiement sans disque persistant, ils ne peuvent pas être récupérés par le code seul.
- Après ce correctif, les comptes, favoris, logs, messages, etc. restent dans la base sur le disque persistant.
