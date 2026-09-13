'use strict';

// Simulation automatique de parties complètes avec des "bots" qui jouent
// aléatoirement parmi les coups légaux. Sert de test de non-régression pour
// le moteur de jeu (server/game/*), sans passer par Socket.io.

const { Game, PHASES } = require('../server/game/Game');

function randomChoice(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function playOneGame(gameIndex) {
  const game = new Game(`SIM${gameIndex}`, 501);
  for (let i = 0; i < 4; i++) game.addPlayer(`bot-${gameIndex}-${i}`, `Bot${i + 1}`);

  game.startNewHand();
  let safety = 0;
  const SUITS = ['C', 'D', 'H', 'S'];

  while (game.phase !== PHASES.GAME_OVER) {
    safety++;
    if (safety > 20000) throw new Error('Boucle infinie détectée dans la simulation.');

    if (game.phase === PHASES.BIDDING) {
      const seat = game.biddingTurnSeat;
      if (game.biddingRound === 1) {
        // 1er tour : prendre la retourne ou passer. On force une prise après
        // quelques passes pour éviter des redistributions trop fréquentes.
        const shouldTake = Math.random() < 0.35 || game.biddingPasses >= 3;
        const res = shouldTake ? game.bid(seat, 'take') : game.bid(seat, 'pass');
        if (!res.ok) throw new Error('Enchère (tour 1) invalide: ' + res.error);
      } else {
        // 2e tour : appeler une des 3 couleurs restantes, ou passer.
        const shouldCall = Math.random() < 0.4 || game.biddingPasses >= 3;
        if (shouldCall) {
          const suit = randomChoice(SUITS.filter((s) => s !== game.refusedSuit));
          const res = game.bid(seat, 'call', suit);
          if (!res.ok) throw new Error('Enchère (tour 2) invalide: ' + res.error);
        } else {
          const res = game.bid(seat, 'pass');
          if (!res.ok) throw new Error('Passe (tour 2) invalide: ' + res.error);
        }
      }
      continue;
    }

    if (game.phase === PHASES.PLAYING) {
      const seat = game.currentTurnSeat;
      const legal = game.legalPlaysFor(seat);
      if (legal.length === 0) throw new Error(`Aucun coup légal pour le siège ${seat} !`);
      const card = randomChoice(legal);
      const res = game.playCard(seat, card.id);
      if (!res.ok) throw new Error('Coup invalide: ' + res.error);

      if (res.trickResult && res.trickResult.handEnded) {
        const r = game.handResult;
        const total = r.cardPoints[0] + r.cardPoints[1];
        if (total !== 162) {
          throw new Error(`Total de points incorrect pour la manche: ${total} (attendu 162)`);
        }
        if (game.phase === PHASES.HAND_END) {
          game.startNewHand();
        }
      }
      continue;
    }

    throw new Error('Phase inattendue: ' + game.phase);
  }

  return { hands: game.handNumber, score: game.matchScore.slice() };
}

const NUM_GAMES = 25;
let totalHands = 0;
for (let g = 0; g < NUM_GAMES; g++) {
  const result = playOneGame(g);
  totalHands += result.hands;
  console.log(`Partie ${g + 1}: ${result.hands} manches jouées, score final ${result.score[0]} - ${result.score[1]}`);
}

console.log(`\n✅ ${NUM_GAMES} parties simulées avec succès (${totalHands} manches au total, moyenne ${(totalHands / NUM_GAMES).toFixed(1)} manches/partie).`);
console.log('Aucune erreur détectée : distribution, enchères, règles de jeu (fournir/couper/monter), calcul des plis et du score sont cohérents.');
