'use strict';

// Test d'intégration bout-en-bout : démarre le vrai serveur (Express + Socket.io)
// sur un port dédié, connecte 4 clients socket.io-client, crée un salon,
// le remplit, démarre la partie et joue quelques enchères/coups pour vérifier
// que toute la chaîne (serveur, salons, moteur de jeu, diffusion d'état) fonctionne.

const { spawn } = require('child_process');
const path = require('path');
const { io } = require('socket.io-client');

const PORT = 3999;
const URL = `http://localhost:${PORT}`;

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const serverProcess = spawn('node', [path.join(__dirname, '..', 'server', 'server.js')], {
    env: { ...process.env, PORT: String(PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let serverReady = false;
  serverProcess.stdout.on('data', (d) => {
    if (d.toString().includes('disponible')) serverReady = true;
  });
  serverProcess.stderr.on('data', (d) => process.stderr.write(`[server] ${d}`));

  const started = Date.now();
  while (!serverReady) {
    if (Date.now() - started > 8000) throw new Error('Le serveur ne démarre pas.');
    await wait(100);
  }
  await wait(200);

  try {
    const sockets = [io(URL), io(URL), io(URL), io(URL)];
    const states = [null, null, null, null];

    sockets.forEach((s, i) => {
      s.on('state', (st) => {
        states[i] = st;
      });
      s.on('error_message', (m) => console.log(`[client ${i}] error_message:`, m));
    });

    await Promise.all(sockets.map((s) => new Promise((res) => s.on('connect', res))));
    console.log('✅ 4 clients connectés au serveur.');

    const createRes = await new Promise((resolve) =>
      sockets[0].emit('create_room', { name: 'Alice', targetScore: 501 }, resolve)
    );
    if (!createRes.ok) throw new Error('Échec création salon: ' + createRes.error);
    const roomId = createRes.roomId;
    console.log(`✅ Salon créé: ${roomId}`);

    for (let i = 1; i < 4; i++) {
      const joinRes = await new Promise((resolve) =>
        sockets[i].emit('join_room', { roomId, name: `Joueur${i + 1}` }, resolve)
      );
      if (!joinRes.ok) throw new Error(`Échec join joueur ${i}: ` + joinRes.error);
    }
    console.log('✅ 4 joueurs dans le salon.');

    await wait(300);
    if (!states[0] || states[0].phase !== 'lobby') throw new Error('État de lobby non reçu.');
    if (!states[0].players.every((p) => p !== null)) throw new Error('Le salon devrait être complet.');

    sockets[0].emit('start_game');
    await wait(400);
    if (states[0].phase !== 'bidding') throw new Error('La partie devrait être en phase d\'enchères, phase=' + states[0].phase);
    if (states[0].myHand.length !== 5) throw new Error('5 cartes attendues avant enchères, reçu ' + states[0].myHand.length);
    if (!states[0].retourneCard) throw new Error('La carte retournée devrait être visible au 1er tour.');
    console.log('✅ Partie démarrée, phase=bidding, 5 cartes par joueur, retourne =', states[0].retourneCard.rank + states[0].retourneCard.suit);

    // Jouer les enchères (tour 1 : prendre/passer, tour 2 : appeler/passer) jusqu'à ce que quelqu'un prenne.
    let safety = 0;
    while (true) {
      safety++;
      if (safety > 50) throw new Error('Boucle d\'enchères trop longue.');
      const biddingSeat = states[0].biddingTurnSeat;
      const st = states.find((s) => s && s.mySeat === biddingSeat);
      const sock = sockets[st.mySeat];
      if (states[0].biddingRound === 1) {
        if (safety % 4 === 0) {
          sock.emit('bid', { action: 'take' });
        } else {
          sock.emit('bid', { action: 'pass' });
        }
      } else {
        const suit = ['C', 'D', 'H', 'S'].find((s) => s !== states[0].refusedSuit);
        if (safety % 4 === 0) {
          sock.emit('bid', { action: 'call', suit });
        } else {
          sock.emit('bid', { action: 'pass' });
        }
      }
      await wait(150);
      if (states[0].phase === 'playing') break;
    }
    if (states[0].myHand.length !== 8) throw new Error('8 cartes attendues après enchères, reçu ' + states[0].myHand.length);
    console.log('✅ Enchères résolues, atout =', states[0].trumpSuit, ', phase =', states[0].phase, ', chaque joueur a 8 cartes.');

    // Jouer quelques cartes légales pour valider le cycle complet play_card -> state.
    for (let i = 0; i < 4; i++) {
      const turnSeat = states[0].currentTurnSeat;
      const st = states.find((s) => s && s.mySeat === turnSeat);
      const card = st.legalPlays[0];
      sockets[st.mySeat].emit('play_card', { cardId: card });
      await wait(150);
    }
    console.log('✅ 4 cartes jouées (un pli complet) sans erreur, phase =', states[0].phase);

    sockets.forEach((s) => s.close());
    console.log('\n🎉 Test d\'intégration réussi : serveur, salons, Socket.io et moteur de jeu fonctionnent ensemble.');
  } finally {
    serverProcess.kill();
  }
}

main().catch((err) => {
  console.error('❌ Échec du test d\'intégration:', err.message);
  process.exitCode = 1;
});
