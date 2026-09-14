'use strict';

// Test d'intégration bout-en-bout pour le Yams : démarre le vrai serveur
// (Express + Socket.io) sur un port dédié, connecte 3 clients socket.io-client,
// crée un salon Yams, le remplit, démarre la partie, joue un tour complet
// (lancer, garder un dé, relancer, marquer une catégorie) et vérifie que le
// tour passe bien au joueur suivant avec un état cohérent.

const { spawn } = require('child_process');
const path = require('path');
const { io } = require('socket.io-client');

const PORT = 3998;
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
    const sockets = [io(URL), io(URL), io(URL)];
    const states = [null, null, null];

    sockets.forEach((s, i) => {
      s.on('state', (st) => { states[i] = st; });
      s.on('error_message', (m) => console.log(`[client ${i}] error_message:`, m));
    });

    await Promise.all(sockets.map((s) => new Promise((res) => s.on('connect', res))));
    console.log('✅ 3 clients connectés au serveur.');

    const createRes = await new Promise((resolve) =>
      sockets[0].emit('create_room', { name: 'Alice', gameType: 'yams' }, resolve)
    );
    if (!createRes.ok) throw new Error('Échec création salon Yams: ' + createRes.error);
    const roomId = createRes.roomId;
    console.log(`✅ Salon Yams créé: ${roomId}`);

    for (let i = 1; i < 3; i++) {
      const joinRes = await new Promise((resolve) =>
        sockets[i].emit('join_room', { roomId, name: `Joueur${i + 1}` }, resolve)
      );
      if (!joinRes.ok) throw new Error(`Échec join joueur ${i}: ` + joinRes.error);
    }
    console.log('✅ 3 joueurs dans le salon.');

    await wait(300);
    if (!states[0] || states[0].phase !== 'lobby') throw new Error('État de lobby non reçu.');
    if (states[0].type !== 'yams') throw new Error('Le salon devrait être de type "yams", reçu ' + states[0].type);
    if (!states[0].canStart) throw new Error('canStart devrait être vrai avec 3 joueurs (min 2).');

    sockets[0].emit('start_game');
    await wait(400);
    if (states[0].phase !== 'playing') throw new Error('La partie devrait être en cours, phase=' + states[0].phase);
    if (states[0].rollsLeft !== 3) throw new Error('3 lancers attendus au début du tour, reçu ' + states[0].rollsLeft);
    console.log('✅ Partie Yams démarrée, phase=playing, 3 lancers disponibles.');

    // Le premier joueur (siège 0, Alice) doit être le premier à jouer.
    const firstTurnSeat = states[0].currentTurnSeat;
    const activeSocket = sockets[states.findIndex((s) => s && s.mySeat === firstTurnSeat)];

    activeSocket.emit('yams_roll');
    await wait(200);
    if (!states[0].hasRolled) throw new Error('hasRolled devrait être vrai après le 1er lancer.');
    if (states[0].rollsLeft !== 2) throw new Error('2 lancers restants attendus, reçu ' + states[0].rollsLeft);
    if (states[0].dice.some((d) => d < 1 || d > 6)) throw new Error('Dés invalides après lancer: ' + JSON.stringify(states[0].dice));
    console.log('✅ 1er lancer effectué, dés =', states[0].dice.join(','));

    activeSocket.emit('yams_toggle_hold', { index: 0 });
    await wait(150);
    if (!states[0].held[0]) throw new Error('Le dé 0 devrait être maintenu après yams_toggle_hold.');
    const keptDie = states[0].dice[0];

    activeSocket.emit('yams_roll');
    await wait(200);
    if (states[0].rollsLeft !== 1) throw new Error('1 lancer restant attendu, reçu ' + states[0].rollsLeft);
    if (states[0].dice[0] !== keptDie) throw new Error('Le dé maintenu ne devrait pas changer de valeur.');
    console.log('✅ 2e lancer effectué en gardant le dé maintenu (valeur inchangée =', keptDie, ').');

    activeSocket.emit('yams_roll');
    await wait(200);
    if (states[0].rollsLeft !== 0) throw new Error('0 lancer restant attendu après le 3e lancer, reçu ' + states[0].rollsLeft);
    console.log('✅ 3e (dernier) lancer effectué, rollsLeft=0.');

    activeSocket.emit('yams_score', { category: 'chance' });
    await wait(250);
    const mySheet = states[0].scoreSheets[firstTurnSeat];
    if (!mySheet || mySheet.chance === null || mySheet.chance === undefined) {
      throw new Error('La catégorie "chance" devrait être remplie après yams_score.');
    }
    if (states[0].currentTurnSeat === firstTurnSeat) {
      throw new Error('Le tour devrait être passé au joueur suivant après avoir marqué.');
    }
    if (states[0].rollsLeft !== 3 || states[0].hasRolled) {
      throw new Error('Le nouveau tour devrait repartir avec 3 lancers et hasRolled=false.');
    }
    console.log(
      '✅ Catégorie "chance" marquée (' + mySheet.chance + ' pts), tour passé au siège',
      states[0].currentTurnSeat,
      '.'
    );

    sockets.forEach((s) => s.close());
    console.log('\n🎉 Test d\'intégration Yams réussi : salons, tours, lancers/maintien de dés et score fonctionnent ensemble.');
  } finally {
    serverProcess.kill();
  }
}

main().catch((err) => {
  console.error('❌ Échec du test d\'intégration Yams:', err.message);
  process.exitCode = 1;
});
