'use strict';

const path = require('path');
const os = require('os');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');

const { RoomManager } = require('./rooms');
const { PHASES, teamOf } = require('./game/Game');
const { cardOrderIndex, cardPoints } = require('./game/deck');
const {
  PHASES: YAMS_PHASES,
  CATEGORY_KEYS: YAMS_CATEGORY_KEYS,
  computeCategoryScore: computeYamsCategoryScore,
} = require('./game/YamsGame');

const PORT = process.env.PORT || 3000;
const AUTOPLAY_CHECK_MS = 2500;
const AUTOPLAY_GRACE_MS = 6000; // délai avant de jouer automatiquement pour un joueur déconnecté

const app = express();
app.use(express.static(path.join(__dirname, '..', 'public')));

const server = http.createServer(app);
const io = new Server(server);
const rooms = new RoomManager();

// Suivi du moment où un siège est devenu "en attente" (déconnecté et c'est son tour).
const disconnectedSince = new Map(); // roomId -> Map(seat -> timestamp)

function broadcastState(game) {
  for (const player of game.players) {
    if (player && player.connected) {
      io.to(player.id).emit('state', game.getStateFor(game.seatOfSocket(player.id)));
    }
  }
}

const BOT_SUITS = ['C', 'D', 'H', 'S'];

// Évalue à quel point une main est riche dans une couleur donnée (utilisé à
// la fois pour décider de prendre à la retourne et pour choisir la couleur à
// appeler au 2e tour) : les honneurs d'atout (Valet, 9) pèsent lourd, suivis
// de l'As et du 10, chaque carte supplémentaire de la couleur ajoutant un peu
// de valeur (la longueur compte, pas seulement les points).
function suitStrength(hand, suit) {
  let score = 0;
  for (const c of hand) {
    if (c.suit !== suit) continue;
    if (c.rank === 'J') score += 3;
    else if (c.rank === '9') score += 2;
    else if (c.rank === 'A') score += 1.5;
    else if (c.rank === '10') score += 1;
    else score += 0.5;
  }
  return score;
}

// Décision d'enchère pour un siège IA, basée sur la force réelle de la main
// (plutôt qu'une probabilité fixe) : plus la couleur candidate est riche en
// atouts potentiels (Valet, 9, longueur...), plus le robot a de chances de
// prendre/appeler, avec une petite part d'aléa pour rester imprévisible, et
// une prise forcée après quelques passes pour éviter les redistributions
// trop fréquentes.
function botBid(game, seat) {
  const hand = game.hands[seat];
  const forced = game.biddingPasses >= 3;
  if (game.biddingRound === 1) {
    const score = suitStrength(hand, game.retourneCard.suit);
    const takeProb = Math.min(0.92, Math.max(0.06, score / 5));
    const shouldTake = forced || Math.random() < takeProb;
    game.bid(seat, shouldTake ? 'take' : 'pass');
  } else {
    const options = BOT_SUITS.filter((s) => s !== game.refusedSuit);
    let bestSuit = options[0];
    let bestScore = -1;
    for (const s of options) {
      const score = suitStrength(hand, s);
      if (score > bestScore) {
        bestScore = score;
        bestSuit = s;
      }
    }
    const callProb = Math.min(0.9, Math.max(0.08, bestScore / 5));
    const shouldCall = forced || Math.random() < callProb;
    if (shouldCall) {
      game.bid(seat, 'call', bestSuit);
    } else {
      game.bid(seat, 'pass');
    }
  }
}

// Choix de carte pour un siège IA (ou pour l'autoplay d'un joueur déconnecté).
// Stratégie simple mais réfléchie plutôt qu'un choix uniformément aléatoire :
// - en entame, on ouvre avec la carte la plus forte hors atout (pour tenter
//   de faire un pli à moindre risque), sinon le plus petit atout ;
// - si le partenaire est déjà maître du pli, inutile de monter : on se
//   débarrasse de la carte qui rapporte le plus de points à l'équipe ;
// - si un adversaire est maître, on essaie de reprendre la main avec la plus
//   petite carte gagnante possible (pour garder les grosses cartes en
//   réserve) ; si on ne peut pas gagner, on minimise la perte de points.
function pickSmartCard(game, seat) {
  const legal = game.legalPlaysFor(seat);
  if (legal.length === 0) return null;
  if (legal.length === 1) return legal[0];

  const trumpSuit = game.trumpSuit;
  const trick = game.trick;

  if (trick.length === 0) {
    const nonTrump = legal.filter((c) => c.suit !== trumpSuit);
    const pool = nonTrump.length > 0 ? nonTrump : legal;
    const sorted = pool.slice().sort((a, b) => cardOrderIndex(b, trumpSuit) - cardOrderIndex(a, trumpSuit));
    return sorted[0];
  }

  let bestSeat = trick[0].seat;
  let bestCard = trick[0].card;
  for (let i = 1; i < trick.length; i++) {
    const { seat: s, card: c } = trick[i];
    if (c.suit === trumpSuit && bestCard.suit !== trumpSuit) {
      bestSeat = s;
      bestCard = c;
    } else if (c.suit === bestCard.suit && cardOrderIndex(c, trumpSuit) > cardOrderIndex(bestCard, trumpSuit)) {
      bestSeat = s;
      bestCard = c;
    }
  }

  const partnerWinning = teamOf(bestSeat) === teamOf(seat);

  if (partnerWinning) {
    const sorted = legal.slice().sort((a, b) => cardPoints(b, trumpSuit) - cardPoints(a, trumpSuit));
    return sorted[0];
  }

  const winningPlays = legal.filter((c) => {
    if (c.suit === bestCard.suit) return cardOrderIndex(c, trumpSuit) > cardOrderIndex(bestCard, trumpSuit);
    if (c.suit === trumpSuit && bestCard.suit !== trumpSuit) return true;
    return false;
  });
  if (winningPlays.length > 0) {
    const sorted = winningPlays.slice().sort((a, b) => cardOrderIndex(a, trumpSuit) - cardOrderIndex(b, trumpSuit));
    return sorted[0];
  }

  const sorted = legal.slice().sort((a, b) => cardPoints(a, trumpSuit) - cardPoints(b, trumpSuit));
  return sorted[0];
}

// --- IA pour le Yams ---------------------------------------------------

// Catégories à sacrifier en dernier recours (quand aucune catégorie libre ne
// rapporte de points avec le tirage actuel), de la moins précieuse à la plus
// précieuse à garder pour plus tard.
const YAMS_SACRIFICE_ORDER = [
  'chance', 'as', 'deux', 'grandeSuite', 'petiteSuite', 'full',
  'trois', 'brelan', 'quatre', 'cinq', 'carre', 'six', 'yams',
];

// Décide quels dés garder avant de relancer : on vise le groupe de dés
// identiques le plus nombreux (brelan/carré/yams), sinon une suite si assez
// de valeurs différentes sont déjà réunies, sinon on relance tout.
function decideYamsHold(game) {
  const dice = game.dice;
  const counts = [0, 0, 0, 0, 0, 0, 0];
  for (const d of dice) counts[d] += 1;
  let modeVal = 0;
  let modeCount = 0;
  for (let v = 1; v <= 6; v++) {
    if (counts[v] > modeCount) {
      modeCount = counts[v];
      modeVal = v;
    }
  }

  if (modeCount >= 2) {
    return dice.map((d) => d === modeVal);
  }

  const uniqueVals = [...new Set(dice)];
  if (uniqueVals.length >= 4) {
    const seen = new Set();
    return dice.map((d) => {
      if (seen.has(d)) return false;
      seen.add(d);
      return true;
    });
  }

  return [false, false, false, false, false];
}

// Choisit la catégorie à valider avec le tirage courant : la meilleure
// catégorie encore libre, ou à défaut la moins coûteuse à sacrifier.
function pickYamsCategory(game, seat) {
  const sheet = game.scoreSheets[seat];
  const available = YAMS_CATEGORY_KEYS.filter((c) => sheet[c] === null);
  let best = available[0];
  let bestScore = -1;
  for (const c of available) {
    const score = computeYamsCategoryScore(game.dice, c);
    if (score > bestScore) {
      bestScore = score;
      best = c;
    }
  }
  if (bestScore > 0) return best;
  for (const c of YAMS_SACRIFICE_ORDER) {
    if (available.includes(c)) return c;
  }
  return available[0];
}

// Une "pensée" de robot par tick d'autoplay (toutes les 2,5s) : lance les
// dés, ou décide des dés à garder puis relance, ou marque la meilleure
// catégorie une fois les 3 lancers épuisés. Étalé sur plusieurs ticks pour
// garder un rythme proche de celui d'un joueur humain.
function yamsBotTurnStep(game, seat) {
  if (game.rollsLeft > 0) {
    if (game.hasRolled) {
      const mask = decideYamsHold(game);
      game.setHeldMask(seat, mask);
    }
    game.rollDice(seat);
  } else {
    const category = pickYamsCategory(game, seat);
    game.scoreCategory(seat, category);
  }
}

function autoplayTick() {
  for (const game of rooms.rooms.values()) {
    if (game.type === 'yams') {
      if (game.phase !== YAMS_PHASES.PLAYING) continue;
      const seat = game.currentTurnSeat;
      const player = game.players[seat];
      if (player && player.isBot) {
        yamsBotTurnStep(game, seat);
        broadcastState(game);
      } else if (player && !player.connected) {
        markAndMaybeAct(game, seat, () => {
          yamsBotTurnStep(game, seat);
          broadcastState(game);
        });
      }
      continue;
    }

    if (game.phase === PHASES.BIDDING) {
      const seat = game.biddingTurnSeat;
      const player = game.players[seat];
      if (player && player.isBot) {
        botBid(game, seat);
        broadcastState(game);
      } else if (player && !player.connected) {
        markAndMaybeAct(game, seat, () => {
          game.bid(seat, 'pass');
          broadcastState(game);
        });
      }
    } else if (game.phase === PHASES.PLAYING) {
      const seat = game.currentTurnSeat;
      const player = game.players[seat];
      if (player && player.isBot) {
        const card = pickSmartCard(game, seat);
        if (card) {
          game.playCard(seat, card.id);
          broadcastState(game);
        }
      } else if (player && !player.connected) {
        markAndMaybeAct(game, seat, () => {
          const card = pickSmartCard(game, seat);
          if (card) {
            game.playCard(seat, card.id);
            broadcastState(game);
          }
        });
      }
    }
  }
}

function markAndMaybeAct(game, seat, action) {
  if (!disconnectedSince.has(game.roomId)) disconnectedSince.set(game.roomId, new Map());
  const map = disconnectedSince.get(game.roomId);
  const since = map.get(seat);
  const now = Date.now();
  if (!since) {
    map.set(seat, now);
    return;
  }
  if (now - since >= AUTOPLAY_GRACE_MS) {
    map.delete(seat);
    action();
  }
}

setInterval(autoplayTick, AUTOPLAY_CHECK_MS);
setInterval(() => rooms.pruneEmptyRooms(), 60000);

io.on('connection', (socket) => {
  let currentRoomId = null;

  socket.on('create_room', ({ name, targetScore, gameType } = {}, cb) => {
    const game = rooms.createRoom(gameType, targetScore && targetScore > 0 ? targetScore : 501);
    const seat = game.addPlayer(socket.id, name);
    socket.join(game.roomId);
    currentRoomId = game.roomId;
    if (typeof cb === 'function') cb({ ok: true, roomId: game.roomId, seat });
    broadcastState(game);
  });

  socket.on('join_room', ({ roomId, name } = {}, cb) => {
    const game = rooms.getRoom(roomId);
    if (!game) {
      if (typeof cb === 'function') cb({ ok: false, error: 'Salon introuvable.' });
      return;
    }
    const alreadySeated = game.seatOfSocket(socket.id) !== -1;
    const cleanName = (name || '').trim();
    // Une reprise de partie (même pseudo qu'un siège actuellement déconnecté)
    // doit être acceptée même si le salon affiche déjà tous ses sièges occupés.
    const isReconnect =
      !alreadySeated &&
      cleanName &&
      game.players.some((p) => p && !p.connected && !p.isBot && p.name === cleanName);
    if (!alreadySeated && !isReconnect && game.isFull()) {
      if (typeof cb === 'function') {
        cb({ ok: false, error: `Ce salon est déjà complet (${game.maxPlayers} joueurs).` });
      }
      return;
    }
    const seat = game.addPlayer(socket.id, name);
    socket.join(game.roomId);
    currentRoomId = game.roomId;
    if (typeof cb === 'function') cb({ ok: true, roomId: game.roomId, seat });
    broadcastState(game);
  });

  socket.on('add_bot', ({ roomId } = {}, cb) => {
    const game = rooms.getRoom(roomId);
    if (!game) {
      if (typeof cb === 'function') cb({ ok: false, error: 'Salon introuvable.' });
      return;
    }
    if (game.isFull()) {
      if (typeof cb === 'function') {
        cb({ ok: false, error: `Ce salon est déjà complet (${game.maxPlayers} joueurs).` });
      }
      return;
    }
    const seat = game.addBotPlayer();
    if (seat === -1) {
      if (typeof cb === 'function') cb({ ok: false, error: 'Aucune place libre.' });
      return;
    }
    if (typeof cb === 'function') cb({ ok: true, roomId: game.roomId, seat });
    broadcastState(game);
  });

  socket.on('start_game', () => {
    const game = rooms.getRoom(currentRoomId);
    if (!game) return;
    if (game.type === 'yams') {
      if (game.canStart()) {
        game.startGame();
        broadcastState(game);
      }
      return;
    }
    if (game.phase === PHASES.LOBBY && game.isFull()) {
      game.startNewHand();
      broadcastState(game);
    }
  });

  socket.on('next_hand', () => {
    const game = rooms.getRoom(currentRoomId);
    if (!game || game.type !== 'belote') return;
    if (game.phase === PHASES.HAND_END) {
      game.startNewHand();
      broadcastState(game);
    }
  });

  // --- Événements spécifiques au Yams ---------------------------------------

  socket.on('yams_roll', () => {
    const game = rooms.getRoom(currentRoomId);
    if (!game || game.type !== 'yams') return;
    const seat = game.seatOfSocket(socket.id);
    if (seat === -1) return;
    const result = game.rollDice(seat);
    if (!result.ok) {
      socket.emit('error_message', result.error);
      return;
    }
    broadcastState(game);
  });

  socket.on('yams_toggle_hold', ({ index } = {}) => {
    const game = rooms.getRoom(currentRoomId);
    if (!game || game.type !== 'yams') return;
    const seat = game.seatOfSocket(socket.id);
    if (seat === -1) return;
    const result = game.toggleHold(seat, index);
    if (!result.ok) {
      socket.emit('error_message', result.error);
      return;
    }
    broadcastState(game);
  });

  socket.on('yams_score', ({ category } = {}) => {
    const game = rooms.getRoom(currentRoomId);
    if (!game || game.type !== 'yams') return;
    const seat = game.seatOfSocket(socket.id);
    if (seat === -1) return;
    const result = game.scoreCategory(seat, category);
    if (!result.ok) {
      socket.emit('error_message', result.error);
      return;
    }
    broadcastState(game);
  });

  socket.on('bid', ({ action, suit } = {}) => {
    const game = rooms.getRoom(currentRoomId);
    if (!game || game.type !== 'belote') return;
    const seat = game.seatOfSocket(socket.id);
    if (seat === -1) return;
    const result = game.bid(seat, action, suit);
    if (!result.ok) {
      socket.emit('error_message', result.error);
      return;
    }
    broadcastState(game);
  });

  socket.on('play_card', ({ cardId } = {}) => {
    const game = rooms.getRoom(currentRoomId);
    if (!game || game.type !== 'belote') return;
    const seat = game.seatOfSocket(socket.id);
    if (seat === -1) return;
    const result = game.playCard(seat, cardId);
    if (!result.ok) {
      socket.emit('error_message', result.error);
      return;
    }
    broadcastState(game);
  });

  socket.on('disconnect', () => {
    const game = rooms.getRoom(currentRoomId);
    if (!game) return;
    game.removePlayerBySocket(socket.id);
    broadcastState(game);
  });
});

function getLocalNetworkIps() {
  const ips = [];
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name] || []) {
      if (iface.family === 'IPv4' && !iface.internal) {
        ips.push(iface.address);
      }
    }
  }
  return ips;
}

// Écoute sur toutes les interfaces (0.0.0.0) pour être joignable depuis d'autres
// appareils (téléphones) connectés au même réseau Wi-Fi, pas seulement en local.
server.listen(PORT, '0.0.0.0', () => {
  console.log(`\nBelote en ligne disponible sur http://localhost:${PORT}\n`);
  const ips = getLocalNetworkIps();
  if (ips.length > 0) {
    console.log('Pour y jouer depuis un téléphone sur le même Wi-Fi, ouvrez :');
    ips.forEach((ip) => console.log(`  → http://${ip}:${PORT}`));
    console.log('');
  } else {
    console.log('Aucune adresse réseau locale détectée (êtes-vous bien connecté à un réseau ?).\n');
  }
});
