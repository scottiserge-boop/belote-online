'use strict';

const path = require('path');
const os = require('os');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');

const { RoomManager } = require('./rooms');
const { PHASES } = require('./game/Game');

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

function pickRandomLegalCard(game, seat) {
  const legal = game.legalPlaysFor(seat);
  if (legal.length === 0) return null;
  return legal[Math.floor(Math.random() * legal.length)];
}

const BOT_SUITS = ['C', 'D', 'H', 'S'];

// Décision d'enchère très simple pour un siège IA (même logique que les bots
// utilisés par test/simulate.js) : prend/appelle une couleur avec une
// certaine probabilité, en forçant une prise après quelques passes pour
// éviter des redistributions trop fréquentes.
function botBid(game, seat) {
  if (game.biddingRound === 1) {
    const shouldTake = Math.random() < 0.35 || game.biddingPasses >= 3;
    game.bid(seat, shouldTake ? 'take' : 'pass');
  } else {
    const shouldCall = Math.random() < 0.4 || game.biddingPasses >= 3;
    if (shouldCall) {
      const options = BOT_SUITS.filter((s) => s !== game.refusedSuit);
      const suit = options[Math.floor(Math.random() * options.length)];
      game.bid(seat, 'call', suit);
    } else {
      game.bid(seat, 'pass');
    }
  }
}

function autoplayTick() {
  for (const game of rooms.rooms.values()) {
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
        const card = pickRandomLegalCard(game, seat);
        if (card) {
          game.playCard(seat, card.id);
          broadcastState(game);
        }
      } else if (player && !player.connected) {
        markAndMaybeAct(game, seat, () => {
          const card = pickRandomLegalCard(game, seat);
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

  socket.on('create_room', ({ name, targetScore } = {}, cb) => {
    const game = rooms.createRoom(targetScore && targetScore > 0 ? targetScore : 501);
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
    // doit être acceptée même si le salon affiche déjà 4 sièges occupés.
    const isReconnect =
      !alreadySeated &&
      cleanName &&
      game.players.some((p) => p && !p.connected && !p.isBot && p.name === cleanName);
    if (!alreadySeated && !isReconnect && game.isFull()) {
      if (typeof cb === 'function') cb({ ok: false, error: 'Ce salon est déjà complet (4 joueurs).' });
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
      if (typeof cb === 'function') cb({ ok: false, error: 'Ce salon est déjà complet (4 joueurs).' });
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
    if (game.phase === PHASES.LOBBY && game.isFull()) {
      game.startNewHand();
      broadcastState(game);
    }
  });

  socket.on('next_hand', () => {
    const game = rooms.getRoom(currentRoomId);
    if (!game) return;
    if (game.phase === PHASES.HAND_END) {
      game.startNewHand();
      broadcastState(game);
    }
  });

  socket.on('bid', ({ action, suit } = {}) => {
    const game = rooms.getRoom(currentRoomId);
    if (!game) return;
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
    if (!game) return;
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
