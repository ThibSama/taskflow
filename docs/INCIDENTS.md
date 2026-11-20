# Gestion des incidents

Quand quelque chose casse en production, on répare d'abord, puis on comprend et on écrit ce qu'on a appris.
Un post-mortem n'a pas pour but de trouver un coupable mais d'éviter que l'incident se reproduise. Il est sans blâme :
on parle de processus et de systèmes, pas de personnes.

## Incident n° 1 - L'API redémarre en boucle après une modification du `.env`

**Gravité** : élevée — l'API était indisponible et les utilisateurs ne pouvaient plus consulter ni modifier les tâches.
**Détection** : alerte `TaskFlowApiDown`, environ 1 min 08 s après le premier échec observé.
**Durée** : 14:37:03 - environ 14:44 heure de Paris, soit environ 7 min jusqu’à la résolution confirmée par la supervision. Le service était déjà fonctionnel à 14:42:56.
**Rédaction** : TaskFlow

### Résumé

La production TaskFlow est devenue indisponible après la recréation du conteneur API avec une configuration erronée.
Les routes `/health` et `/api/tasks` renvoyaient HTTP 502, car l'API redémarrait en boucle et n'était plus joignable
par le front.

La variable `DATABASE_URL` avait été renommée en `DATABASE_UR` dans le `.env` de production. Le conteneur recevait donc
une configuration incomplète et l'API échouait au démarrage avec `ECONNREFUSED`. La supervision a détecté la panne via
la sonde Blackbox traversant le front.

### Chronologie (heure de Paris, UTC+1)

- **14:37:03** - Premier échec de démarrage observé dans les logs de l'API : `Démarrage impossible : ECONNREFUSED`.
- **14:38:11** - L'alerte `TaskFlowApiDown` passe en `FIRING` dans Alertmanager et une notification est reçue dans Mailpit.
- **14:38** - Grafana affiche la disponibilité `/health` en `EN PANNE`. Le panneau d'erreurs 5xx reste à 0 %, car
  l'API morte ne peut plus produire ses propres métriques HTTP.
- **14:39:15** - `GET /health` via le proxy renvoie `502 Bad Gateway`.
- **14:39:23** - `GET /api/tasks` renvoie également `502 Bad Gateway`.
- **14:39** - `docker compose ps` montre la base, le front et le proxy healthy, mais l'API en
  `Restarting (1)`.
- **14:40** - Les logs montrent des échecs répétés `ECONNREFUSED` au démarrage.
- **14:40** - La cause est prouvée : `.env` contient `DATABASE_UR`, `.env.bak` contient `DATABASE_URL`, et
  `docker inspect` confirme que le conteneur reçoit `DATABASE_UR`.
- **14:42** - La configuration d'origine est restaurée et le conteneur API est recréé.
- **14:42** - `docker compose ps` montre de nouveau l'API `healthy`; `/health` répond `status=ok`.
- **14:42:56** - Une création de tâche réussit avec `Post-incident verification`; `probe_success` vaut de nouveau `1`
  et `TaskFlowApiDown` n'est plus active.
- **14:44 environ** - Mail `[RESOLVED] TaskFlowApiDown prod` reçu dans Mailpit ; la chaîne de supervision confirme le retour à la normale.

### Cause racine (5 pourquoi)

1. **Pourquoi les utilisateurs recevaient-ils des réponses 502 ?**
   Le front ne pouvait plus joindre l'API.

2. **Pourquoi le front ne pouvait-il plus joindre l'API ?**
   Le conteneur API redémarrait en boucle et n'était jamais disponible.

3. **Pourquoi l'API redémarrait-elle en boucle ?**
   Elle échouait pendant son initialisation de la connexion PostgreSQL avec `ECONNREFUSED`.

4. **Pourquoi la configuration de connexion à PostgreSQL était-elle incorrecte ?**
   La variable attendue `DATABASE_URL` était absente du conteneur : le `.env` contenait `DATABASE_UR`.

5. **Pourquoi une variable de configuration invalide a-t-elle pu atteindre la production ?**
   La complétude des variables obligatoires du `.env` n'est pas contrôlée automatiquement avant la recréation de
   l'API, et l'application ne refuse pas explicitement une configuration de production incomplète avant de tenter de
   démarrer.

### Ce qui a bien fonctionné

- La sonde Blackbox a détecté le problème du point de vue utilisateur, à travers le front.
- `TaskFlowApiDown` a signalé la panne environ une minute après son apparition.
- Alertmanager et Mailpit ont correctement transmis la notification.
- Grafana a immédiatement rendu visible la perte de disponibilité.
- L'état des conteneurs a rapidement isolé l'API comme service défaillant.
- Les logs structurés ont fourni l'indice `ECONNREFUSED`.
- `docker inspect` et la comparaison des fichiers `.env` ont permis de prouver la cause au lieu de la supposer.
- La restauration de la configuration n'a pas nécessité de rollback de l'image applicative.

### Ce qui a moins bien fonctionné

- Une variable obligatoire peut manquer en production sans être rejetée explicitement avant le démarrage.
- La configuration `.env` peut être modifiée sans contrôle automatique de sa structure.
- Le symptôme côté métriques applicatives est trompeur : le panneau des erreurs 5xx reste à 0 % lorsque l'API est
  complètement arrêtée.
- Le diagnostic nécessite encore plusieurs commandes manuelles pour distinguer rapidement une erreur de configuration
  d'un problème d'image ou de base de données.

### Actions

| Action | Type | Issue | Statut |
| --- | --- | --- | --- |
| En production, faire échouer explicitement le démarrage si `DATABASE_URL` est absente, avec un test automatisé | prévention | #28 | à faire |
| Vérifier avant déploiement que les variables obligatoires du `.env` sont présentes | prévention | à créer | à faire |
| Conserver la procédure de diagnostic `TaskFlowApiDown` dans ce runbook | processus | — | fait |
