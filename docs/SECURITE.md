# Sécurité de TaskFlow

> Ce document décrit les contrôles de sécurité du projet, les corrections appliquées et le **registre des
> exceptions** (faux positifs assumés). Il est mis à jour à chaque fois qu'une alerte est traitée.

## 1. Les contrôles et leur place dans le pipeline

| Contrôle | Outil | Étape | Déclencheur | Ce qu'il protège |
|---|---|---|---|---|
| Secrets (pré-commit) | **gitleaks** | poste du dev | `git commit` | un secret qui part dans un commit |
| Secrets (historique) | **gitleaks** | CI | PR, push `main`, hebdo | un secret déjà présent dans l'historique |
| Dépendances (SCA) | **npm audit** `--audit-level=high` | CI | PR, push `main`, **hebdo** | dépendances avec une CVE connue |
| Dépendances (veille) | **Dependabot** | dépôt | planifié | dépendances qui vieillissent |
| Code (SAST) | **Semgrep** (`p/javascript`, `p/nodejsscan`) | CI | PR, push `main`, hebdo | injection, XSS, `eval`, secrets en dur |
| Image (SCA) | **Trivy** (bloquant sur CRITICAL) | `release.yml` | push `main` | CVE dans l'image publiée |
| Application (DAST) | **OWASP ZAP baseline** | CI | PR, push `main`, hebdo | en-têtes, cookies, fuites d'info |
| Durcissement HTTP | en-têtes **Nginx** | runtime | à chaque requête | XSS, clickjacking, fuite d'info |
| Moindre privilège | `permissions:`, actions **épinglées par SHA** | workflows | toujours | un jeton détourné, une action modifiée |

Deux workflows portent ces contrôles : `ci.yml`/`release.yml` (Jours 2-3) et **`security.yml`** (Jour 5). Le
`schedule:` hebdomadaire de `security.yml` rattrape les CVE publiées **après** un merge (shift-right).

## 2. Durcissement HTTP (en-têtes du front)

Posés dans [`front/nginx.conf`](../front/nginx.conf), sur **toutes** les réponses (`always`) :

| En-tête | Valeur | Rôle |
|---|---|---|
| `Content-Security-Policy` | `default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'` | n'autorise que nos propres ressources ; bloque la plupart des XSS |
| `X-Content-Type-Options` | `nosniff` | empêche le navigateur de « deviner » un type (JS déguisé en image) |
| `X-Frame-Options` | `DENY` | anti-clickjacking (navigateurs anciens) |
| `Referrer-Policy` | `strict-origin-when-cross-origin` | ne fuite pas l'URL complète vers les tiers |
| `Permissions-Policy` | `camera=(), microphone=(), geolocation=(), payment=(), usb=()` | coupe les API matérielles inutilisées |
| `Cross-Origin-Opener-Policy` / `-Resource-Policy` / `-Embedder-Policy` | `same-origin` / `same-origin` / `require-corp` | isolation d'origine (atténuation Spectre) |

Également : `server_tokens off;` (cache la version de Nginx) et `proxy_hide_header X-Powered-By;` (retire l'en-tête
`X-Powered-By: Express` des réponses de l'API).

**Pas de `'unsafe-inline'`** : le build Vite ne produit ni script ni style *inline* (vérifié dans `dist/index.html`,
les ressources sont des fichiers `/assets/*` chargés via `<script src>` / `<link href>`). La CSP a été testée dans un
navigateur (création de tâche, bascule, suppression : aucune violation CSP liée à TaskFlow ; les violations observées au chargement provenaient de scripts injectés par des extensions du navigateur).

> **Point d'attention Nginx** : `add_header` **n'est pas hérité** par une `location` qui a son propre `add_header`.
> Le `Cache-Control` des assets est donc posé via un `map` au niveau `http`, pas par un `add_header` dans
> `location /assets/`, pour ne pas y perdre la CSP. Toujours vérifier les en-têtes **sur un fichier `/assets/...`**,
> pas seulement sur `/`.

**Non couvert ici** : `Strict-Transport-Security` (HSTS) se pose sur le **proxy HTTPS de production**
(`compose.prod.yaml`, Jour 3), pas sur ce Nginx qui parle HTTP en interne.

## 3. Dépendances

- `api/` : aucune vulnérabilité `high`/`critical` dans les dépendances d'exécution (`express`, `pg`). Les outils de
  test (`vitest`, `@vitest/coverage-v8`) sont tenus à jour.
- `front/` : **toutes** les dépendances sont des `devDependencies` (le livrable est un ensemble de fichiers statiques
  servis par Nginx ; aucun code npm ne tourne en production). Les alertes `vite`/`vitest` concernent le **serveur de
  développement** et les **tests**, pas l'image déployée. On les corrige quand même (elles s'exécutent dans le CI et
  sur les postes) en montant `vite`, `vitest` et `@vitest/coverage-v8` ; `npm test` et `npm run build` restent verts.

## 4. Registre des exceptions

> Chaque exception est **étroite** (une règle, un chemin) et **justifiée**. Un vrai secret ne s'ajoute jamais ici :
> on le **révoque**.

### ZAP — [`.zap/rules.tsv`](../.zap/rules.tsv)

| Règle | Action | Justification | Revue |
|---|---|---|---|
| 10049 Storable and Cacheable Content | IGNORE | informatif ; les assets Vite (nom avec hash) sont **volontairement** cachés 1 an | à la montée de version de ZAP |
| 10109 Modern Web Application | IGNORE | informatif ; signale seulement qu'il s'agit d'une SPA | idem |
| 10027 Information Disclosure - Suspicious Comments | IGNORE | mots-clés (`select`, `user`, `TODO`) dans le **bundle minifié** de Vite/dépendances, pas dans notre code ; vérifié = faux positif | à chaque montée de Vite |
| 10038, 10020, 10021, 10063, 10036, 10037 | **FAIL** | en-têtes **corrigés** : toute régression doit **bloquer** (test de non-régression de sécurité) | — |

### gitleaks — [`.gitleaks.toml`](../.gitleaks.toml)

| Exception | Justification |
|---|---|
| `*.env.example`, `package-lock.json` | valeurs d'exemple / sommes de hachage, publiques par construction |
| `postgres://taskflow:taskflow@…` | mot de passe **jetable** de la base de dev et des tests (éphémère, jamais exposée hors du réseau Docker ni du CI) |

### Semgrep

Aucune exception à ce jour. En cas de faux positif, ajouter `// nosemgrep: <id-de-règle>` **sur la ligne concernée**
(jamais un `nosemgrep` nu) et une entrée datée dans ce registre.

## 5. Limites connues

- La **baseline** ZAP est **passive** : elle ne teste ni l'authentification, ni les injections (scan actif), ni le
  contrôle d'accès. Elle ne remplace ni un scan actif planifié sur *staging*, ni un pentest humain, ni la revue de
  code.
- Semgrep (règles publiques, sans compte) peut rater une injection si la requête est construite dans une autre
  fonction que l'appel : le SAST **complète** la revue, il ne la remplace pas.
- TaskFlow n'a volontairement **ni authentification ni multi-utilisateurs** : les catégories OWASP A01 (contrôle
  d'accès) et A07 (authentification) sont traitées en cours sur des exemples, pas dans ce code.

## 6. En cas de secret exposé

1. **Révoquer** immédiatement le secret concerné (régénérer la clé / le jeton côté fournisseur).
2. Le remplacer par une nouvelle valeur, stockée en **secret GitHub** / `.env` hors Git.
3. Purger l'historique si nécessaire (`git filter-repo`), prévenir l'équipe (l'ancien secret reste dans les clones).
4. Ouvrir une issue de post-mortem (comme pour un incident, cf. `INCIDENTS.md`).
