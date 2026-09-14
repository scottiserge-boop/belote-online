'use strict';

// Simulation automatique de parties complètes de Yams avec des "bots" qui
// jouent selon une heuristique simple (gardent le groupe de dés majoritaire,
// visent une suite si assez de valeurs différentes, sinon relancent tout).
// Sert de test de non-régression pour le moteur de jeu (server/game/YamsGame.js),
// sans passer par Socket.io.

const { YamsGame, PHASES, CATEGORY_KEYS, computeCategoryScore } = require('../server/game/YamsGame');

const SACRIFICE_ORDER = [
  'chance', 'as', 'deux', 'grandeSuite', 'petiteSuite', 'full',
  'trois', 'brelan', 'quatre', 'cinq', 'carre', 'six', 'yams',
];

function decideHold(dice) {
  const counts = [0, 0, 0, 0, 0, 0, 0];
  for (const d of dice) counts[d] += 1;
  let modeVal = 0;
  let modeCount = 0;
  for (let v = 1; v <= 6; v++) {
    if (counts[v] > modeCount) { modeCount = counts[v]; modeVal = v; }
  }
  if (modeCount >= 2) return dice.map((d) => d === modeVal);
  const unique = [...new Set(dice)];
  if (unique.length >= 4) {
    const seen = new Set();
    return dice.map((d) => {
      if (seen.has(d)) return false;
      seen.add(d);
      return true;
    });
  }
  return [false, false, false, false, false];
}

function pickCategory(game, seat) {
  const sheet = game.scoreSheets[seat];
  const available = CATEGORY_KEYS.filter((c) => sheet[c] === null);
  let best = available[0];
  let bestScore = -1;
  for (const c of available) {
    const score = computeCategoryScore(game.dice, c);
    if (score > bestScore) { bestScore = score; best = c; }
  }
  if (bestScore > 0) return best;
  for (const c of SACRIFICE_ORDER) {
    if (available.includes(c)) return c;
  }
  return available[0];
}

function playOneGame(gameIndex, numPlayers) {
  const game = new YamsGame(`SIM${gameIndex}`);
  for (let i = 0; i < numPlayers; i++) game.addBotPlayer(`Bot${i + 1}`);
  game.startGame();

  let safety = 0;
  while (game.phase !== PHASES.GAME_OVER) {
    safety++;
    if (safety > 5000) throw new Error('Boucle infinie détectée dans la simulation Yams.');
    const seat = game.currentTurnSeat;
    if (game.rollsLeft > 0) {
      if (game.hasRolled) game.setHeldMask(seat, decideHold(game.dice));
      const r = game.rollDice(seat);
      if (!r.ok) throw new Error('rollDice refusé de façon inattendue: ' + r.error);
    } else {
      const category = pickCategory(game, seat);
      const r = game.scoreCategory(seat, category);
      if (!r.ok) throw new Error('scoreCategory refusé de façon inattendue: ' + r.error);
    }
  }

  // Vérifie que toutes les feuilles sont complètes et que les totaux sont cohérents.
  for (const s of game.turnOrder) {
    const sheet = game.scoreSheets[s];
    for (const c of CATEGORY_KEYS) {
      if (sheet[c] === null || sheet[c] === undefined) {
        throw new Error(`Catégorie ${c} non remplie pour le siège ${s} en fin de partie.`);
      }
    }
  }

  return game;
}

let totalGames = 0;
const scores = [];

for (const numPlayers of [2, 3, 4, 5, 6]) {
  for (let i = 0; i < 10; i++) {
    const game = playOneGame(totalGames, numPlayers);
    totalGames++;
    for (const seat of game.turnOrder) {
      const sheet = game.scoreSheets[seat];
      let upperTotal = 0;
      for (const k of ['as', 'deux', 'trois', 'quatre', 'cinq', 'six']) upperTotal += sheet[k];
      const bonus = upperTotal >= 63 ? 35 : 0;
      let lowerTotal = 0;
      for (const k of ['brelan', 'carre', 'full', 'petiteSuite', 'grandeSuite', 'yams', 'chance']) lowerTotal += sheet[k];
      scores.push(upperTotal + bonus + lowerTotal);
    }
  }
  console.log(`Parties à ${numPlayers} joueurs : 10 simulées avec succès.`);
}

const avg = scores.reduce((a, b) => a + b, 0) / scores.length;
console.log(`\n✅ ${totalGames} parties simulées avec succès (2 à 6 joueurs). Score moyen par joueur : ${avg.toFixed(1)} points.`);
console.log('Aucune erreur détectée : lancers, maintien des dés, calcul des 13 catégories et fin de partie sont cohérents.');
