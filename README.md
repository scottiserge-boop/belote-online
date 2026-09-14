# Belote en ligne 🃏

Prototype jouable de Belote classique à 4 joueurs (2 équipes), en temps réel,
avec un serveur Node.js (Express + Socket.io) et un client web simple
(HTML/CSS/JS, sans framework).

Interface façon table de casino en ligne : feutre vert avec cadre bois/or,
dos de cartes décoratifs pour les adversaires, et votre propre jeu affiché
en éventail (cartes qui se chevauchent et pivotent légèrement, comme un
vrai jeu tenu en main), le tout entièrement adapté au mobile. Une fois
l'atout connu, vos cartes sont automatiquement triées avec l'atout à
gauche et les autres couleurs alternées rouge/noir pour une lecture plus
rapide de la main.

## Lancer le jeu

Prérequis : [Node.js](https://nodejs.org/) 18+ installé sur la machine qui
fera office de serveur (votre ordinateur, ou un petit hébergeur).

```bash
npm install
npm start
```

Le serveur démarre sur `http://localhost:3000`. Ouvrez cette adresse dans un
navigateur : un joueur crée un salon (un code à 4 caractères est généré), les
3 autres le rejoignent en saisissant ce code depuis leur propre navigateur
(sur le même réseau, ou depuis n'importe où si le serveur est accessible sur
Internet — voir "Jouer avec des amis à distance" ci-dessous).

Vous pouvez aussi tester seul en ouvrant 4 onglets/navigateurs sur
`http://localhost:3000` et en rejoignant le même salon avec 4 pseudos
différents.

## Jouer depuis un téléphone (iPhone ou Android)

L'interface est entièrement responsive (testée sur des largeurs d'iPhone et
d'Android) : gros boutons tactiles, cartes et mise en page adaptées aux
petits écrans, aucune installation nécessaire — un simple navigateur suffit.
Sur iPhone (Safari) ou Android (Chrome), vous pouvez utiliser "Ajouter à
l'écran d'accueil" pour obtenir une icône dédiée et un affichage plein écran
sans barre d'adresse, comme une vraie application.

Il y a trois façons de connecter des téléphones au serveur, du plus simple
au plus permanent :

**1. Même réseau Wi-Fi (le plus simple, aucune configuration).** Au
démarrage (`npm start`), le serveur affiche directement dans le terminal les
adresses à utiliser, par exemple :

```
Belote en ligne disponible sur http://localhost:3000

Pour y jouer depuis un téléphone sur le même Wi-Fi, ouvrez :
  → http://192.168.1.24:3000
```

Chaque téléphone connecté au même Wi-Fi que l'ordinateur qui héberge la
partie n'a qu'à ouvrir cette adresse `http://192.168.x.x:3000` dans son
navigateur.

**2. Joueurs sur des réseaux différents, test rapide sans déploiement.**
Utilisez un tunnel temporaire (aucune inscription nécessaire) pendant que
`npm start` tourne, dans un second terminal :

```bash
npx localtunnel --port 3000
```

Cela affiche une URL publique temporaire (ex : `https://xyz.loca.lt`) à
partager avec les autres joueurs, où qu'ils soient. Pratique pour un test
ponctuel, mais l'URL change à chaque redémarrage.

**3. Solution durable.** Déployez ce dossier sur un service Node.js
classique (Render, Railway, Fly.io, un VPS avec `pm2`, etc.) — aucune base
de données n'est nécessaire, tout l'état de partie est géré en mémoire côté
serveur. Une fois déployé, partagez simplement l'URL publique et le code de
salon ; elle ne change plus au fil du temps, contrairement au tunnel.

## Règles implémentées

- Jeu de 32 cartes, 4 joueurs, 2 équipes fixes (sièges 1+3 = équipe A,
  sièges 2+4 = équipe B).
- Distribution de 8 cartes à chacun, donneur qui tourne à chaque manche.
- **Prise à la retourne (règle officielle)** : le donneur distribue 5 cartes
  à chacun puis retourne la 21e carte, qui propose une couleur d'atout.
  - *1er tour* : chaque joueur, à tour de rôle, peut "prendre" cette couleur
    ou passer.
  - Si tout le monde passe, la carte retournée reste "en jeu" (elle n'est
    pas encore donnée au donneur) et un *2e tour* commence : chaque joueur
    peut alors appeler une des 3 autres couleurs, ou passer.
  - *2e tour* : le premier joueur qui annonce une couleur ramasse la carte
    retournée dans sa propre main (et non le donneur), conformément à la
    règle officielle. Ce joueur devient donc le preneur de la manche.
  - Si tout le monde passe aux deux tours, on redistribue.
  - Dès qu'un joueur prend, les mains sont complétées à 8 cartes chacune.
    Le camp du preneur doit alors marquer plus de la moitié des points de
    la manche, sous peine de "chute".
- **Règles de jeu strictes** : obligation de fournir la couleur demandée, de
  couper à l'atout si on ne peut pas fournir, et de monter (surcouper)
  lorsque c'est possible — sauf si le partenaire est déjà maître du pli.
- **Décompte des points** : valeurs classiques (à l'atout : Valet 20, 9 14,
  As 11, 10 10, Roi 4, Dame 3 ; hors atout : As 11, 10 10, Roi 4, Dame 3,
  Valet 2), + 10 points de "dix de der" pour le dernier pli.
- **Belote / Rebelote** : +20 points automatiques pour l'équipe qui possède
  Roi et Dame d'atout.
- **Chute** : si l'équipe preneuse ne totalise pas au moins 82 points sur
  162, elle marque 0 et l'équipe adverse récupère les 162 points.
- **Capot** : une équipe qui remporte les 8 plis marque 162 + 90 points de
  bonus.
- Partie jouée jusqu'à un score cible choisi à la création du salon (301,
  501 ou 1000 points).
- Reconnexion tolérée : si un joueur perd sa connexion, la partie continue
  (le serveur joue automatiquement un coup légal à sa place après quelques
  secondes d'inactivité, pour ne pas bloquer les 3 autres joueurs).
- **Reprise de partie** : en cas de fermeture accidentelle de l'écran ou de
  coupure réseau, le joueur peut revenir sur l'écran d'accueil et saisir à
  nouveau le même pseudo et le même code de salon : il reprend exactement
  son siège et sa main en cours (même en pleine manche), au lieu de se voir
  refuser l'accès à un salon "déjà complet".
- **Joueur IA (robot)** : depuis l'écran d'accueil, le bouton "Remplacer une
  place vide par une IA" permet de faire occuper un siège libre d'un salon
  par un robot, qui annonce et joue automatiquement à sa place (utile pour
  compléter une table à 4 quand un seul joueur est disponible). Un robot est
  repéré par l'icône 🤖 à côté de son nom, dans le salon comme en jeu.

## Structure du projet

```
belote-online/
├── server/
│   ├── server.js       # Serveur Express + Socket.io, événements réseau
│   ├── rooms.js         # Gestion des salons (création, codes, nettoyage)
│   └── game/
│       ├── deck.js      # Cartes, valeurs de points, ordres de force
│       ├── rules.js     # Règles de coups légaux, calcul du gagnant d'un pli
│       └── Game.js       # État complet d'une partie (distribution, enchères, score)
├── public/
│   ├── index.html       # Écrans (accueil, salon, table de jeu)
│   ├── style.css         # Design responsive (bureau + mobile)
│   ├── app.js            # Client Socket.io, rendu de la table et de la main
│   ├── manifest.json     # Manifeste PWA ("Ajouter à l'écran d'accueil")
│   └── icons/            # Icônes de l'application (192/512px, apple-touch-icon)
├── test/
│   ├── simulate.js        # Simulation de 25 parties complètes avec bots aléatoires
│   └── integration.js     # Test bout-en-bout (vrai serveur + 4 clients Socket.io)
└── package.json
```

## Tests

```bash
npm test                 # simulation du moteur de jeu (25 parties, bots aléatoires)
npm run test:integration # test bout-en-bout serveur + Socket.io (nécessite npm install au préalable)
```

Le script de simulation vérifie qu'aucune règle n'est violée et que chaque
manche totalise bien 162 points de cartes. Le test d'intégration démarre le
vrai serveur, connecte 4 clients, crée un salon, lance une partie et joue un
pli complet pour valider toute la chaîne réseau.

## Pistes d'évolution

- Ajouter la variante Coinche (contrats, surcoinche, annonces).
- Ajouter un bouton d'annonce manuelle de Belote/Rebelote (actuellement
  automatique) et d'autres annonces (Tierce, Cinquante, Cent…).
- Persistance des parties (reprise après redémarrage du serveur).
- Mode spectateur, historique des manches consultable, chat entre joueurs.
