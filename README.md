#  Bilan Farine — Broyeur Cru Tétouan

Application web (backend + frontend) qui calcule l'**écart de bouclage du bilan farine**
à partir de l'export TIS de la journée. L'utilisateur dépose le fichier `.xlsx`,
le serveur le parse et calcule, l'interface affiche le résultat (le fameux ~5,6 %).

## Structure

```
bilan-farine-app/
├── backend/
│   ├── calc.js         moteur de calcul (pur, testable) — les 8 étapes du bilan
│   ├── server.js       API Express : /api/bilan (upload+calcul), /api/recompute
│   ├── test.js         test en ligne de commande
│   └── package.json
├── frontend/
│   └── index.html      interface (couleurs Holcim), appelle l'API
└── README.md
```

Le **backend** fait tout le travail lourd : lecture du classeur, agrégation des
1 440 minutes, calcul. Le **frontend** ne fait qu'envoyer le fichier et afficher
la réponse JSON. Les deux communiquent par une petite API REST.

## Installation

Prérequis : Node.js 18 ou plus.

```bash
cd bilan-farine-app/backend
npm install
```

## Démarrage

```bash
npm start
```

Puis ouvrir **http://localhost:3000** dans un navigateur.
Le serveur sert aussi le frontend, donc une seule commande suffit.

Pour changer le port : `PORT=8080 npm start`.

## Test en ligne de commande (sans navigateur)

```bash
node test.js /chemin/vers/04_-_Suivi_Silo_Farine.xlsx BC1
```

Affiche directement T3, T2, le SEEC et les arrêts dans le terminal.

## L'API

### `POST /api/bilan`
Multipart. Champs :
- `file` : l'export TIS `.xlsx` (obligatoire)
- `line` : `BC1` ou `BC2` (défaut `BC1`)
- `h2o`, `kDos`, `cap` : hypothèses (défauts 2.80, 0.90, 1200)

Réponse :
```json
{
  "day": "2026-05-11",
  "line": "BC1",
  "aggregates": { "sDeb": ..., "sDos": ..., "nivFirst": ..., ... },
  "result": { "prodSec": ..., "conso": ..., "T3": 198.7, "T2": 5.56, "seec": ..., ... }
}
```

### `POST /api/recompute`
JSON `{ aggregates, params }`. Recalcule sans re-téléverser le fichier —
utilisé quand l'utilisateur modifie une hypothèse dans l'interface.

## Les hypothèses (à régler dans l'interface, pas dans le TIS)

| Paramètre | Défaut | Rôle |
|-----------|--------|------|
| Humidité mélange | 2.80 % | convertit la production humide en sèche |
| Correction doseur four | 0.90 | corrige la bascule 312 DO 12 |
| Capacité silo | 1200 t | convertit le niveau (%) en tonnes |

Ces trois valeurs pilotent le résultat. Elles sont volontairement exposées dans
l'interface (panneau « Paramètres ») pour éviter le piège du fichier Excel d'origine,
où elles étaient codées en dur et invisibles.

## Colonnes lues dans le TIS

Ligne BC1 : `Débit total TH20`, `Pw Mot Br`, `Clle_BC1`, `Clle Ajouts BK2`,
`Débit Dos Farine`, `Position ON VO18`, `Débit rejet`, `Rejet vers Sol`,
`Alim vers Sol`, `Niv Silo Farine 1`.
Ligne BC2 : équivalents `... BC2 / L2`.

Le parseur ignore les lignes de totaux (`Sum`, `Avg`) et lit les données à partir
de la 4ᵉ ligne (les lignes 2 et 3 contenant les tags et unités).

## Déploiement usine

- Le frontend et le backend étant servis ensemble, il suffit de faire tourner
  `node server.js` sur un poste ou un serveur du réseau interne.
- Aucune donnée n'est stockée : le fichier est traité en mémoire puis oublié.
- Pour un service permanent, utiliser un gestionnaire de process (ex. `pm2`).

## Logo Holcim

Le logo est une marque déposée et n'est pas inclus. Dans l'interface, cliquez sur
l'emplacement en haut à gauche pour charger le fichier officiel de la charte,
ou remplacez-le en dur dans `frontend/index.html`.
