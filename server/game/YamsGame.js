'use strict';

// Moteur du jeu de Yams (Yahtzee à la française), indépendant du moteur de
// Belote (Game.js) mais suivant les mêmes conventions (phases, getStateFor,
// gestion des joueurs/bots) pour que server.js puisse traiter les deux jeux
// de façon symétrique.

const PHASES = {
  LOBBY: 'lobby',
  PLAYING: 'playing',
  GAME_OVER: 'game_over',
};

// Ordre d'affichage classique de la feuille de score.
const CATEGORY_DEFS = [
  { key: 'as', label: 'As', section: 'upper' },
  { key: 'deux', label: 'Deux', section: 'upper' },
  { key: 'trois', label: 'Trois', section: 'upper' },
  { key: 'quatre', label: 'Quatre', section: 'upper' },
  { key: 'cinq', label: 'Cinq', section: 'upper' },
  { key: 'six', label: 'Six', section: 'upper' },
  { key: 'brelan', label: 'Brelan', section: 'lower' },
  { key: 'carre', label: 'Carré', section: 'lower' },
  { key: 'full', label: 'Full', section: 'lower' },
  { key: 'petiteSuite', label: 'Petite suite', section: 'lower' },
  { key: 'grandeSuite', label: 'Grande suite', section: 'lower' },
  { key: 'yams', label: 'Yams', section: 'lower' },
  { key: 'chance', label: 'Chance', section: 'lower' },
];
const CATEGORY_KEYS = CATEGORY_DEFS.map((c) => c.key);
const UPPER_KEYS = CATEGORY_DEFS.filter((c) => c.section === 'upper').map((c) => c.key);
const LOWER_KEYS = CATEGORY_DEFS.filter((c) => c.section === 'lower').map((c) => c.key);
const UPPER_BONUS_THRESHOLD = 63;
const UPPER_BONUS = 35;

const UPPER_VALUE = { as: 1, deux: 2, trois: 3, quatre: 4, cinq: 5, six: 6 };

function sum(dice) {
  return dice.reduce((a, b) => a + b, 0);
}

function diceCounts(dice) {
  const c = [0, 0, 0, 0, 0, 0, 0]; // index 1..6 utilisés
  for (const d of dice) c[d] += 1;
  return c;
}

function hasConsecutiveRun(uniqueSortedValues, length) {
  for (let start = 1; start <= 6 - length + 1; start++) {
    let ok = true;
    for (let k = 0; k < length; k++) {
      if (!uniqueSortedValues.includes(start + k)) {
        ok = false;
        break;
      }
    }
    if (ok) return true;
  }
  return false;
}

// Calcule le score qu'obtiendrait une combinaison de dés donnée dans une
// catégorie donnée (indépendant de l'état de la partie — utile aussi côté
// client pour l'aperçu avant de valider un choix).
function computeCategoryScore(dice, category) {
  if (!dice || dice.some((d) => !d)) return 0; // dés pas encore lancés
  const counts = diceCounts(dice);
  const maxCount = Math.max(...counts.slice(1));
  const uniqueSorted = [...new Set(dice)].sort((a, b) => a - b);

  if (UPPER_VALUE[category]) {
    const v = UPPER_VALUE[category];
    return counts[v] * v;
  }

  switch (category) {
    case 'brelan':
      return maxCount >= 3 ? sum(dice) : 0;
    case 'carre':
      return maxCount >= 4 ? sum(dice) : 0;
    case 'full': {
      const groups = counts.slice(1).filter((n) => n > 0);
      const isFull = groups.length === 2 && groups.includes(3) && groups.includes(2);
      return isFull ? 25 : 0;
    }
    case 'petiteSuite':
      return hasConsecutiveRun(uniqueSorted, 4) ? 30 : 0;
    case 'grandeSuite':
      return hasConsecutiveRun(uniqueSorted, 5) ? 40 : 0;
    case 'yams':
      return maxCount === 5 ? 50 : 0;
    case 'chance':
      return sum(dice);
    default:
      return 0;
  }
}

function emptyScoreSheet() {
  const sheet = {};
  for (const key of CATEGORY_KEYS) sheet[key] = null;
  return sheet;
}

function computeTotals(sheet) {
  let upperTotal = 0;
  for (const key of UPPER_KEYS) {
    if (sheet[key] !== null && sheet[key] !== undefined) upperTotal += sheet[key];
  }
  const bonus = upperTotal >= UPPER_BONUS_THRESHOLD ? UPPER_BONUS : 0;
  let lowerTotal = 0;
  for (const key of LOWER_KEYS) {
    if (sheet[key] !== null && sheet[key] !== undefined) lowerTotal += sheet[key];
  }
  return { upperTotal, bonus, lowerTotal, grandTotal: upperTotal + bonus + lowerTotal };
}

class YamsGame {
  constructor(roomId) {
    this.type = 'yams';
    this.roomId = roomId;
    this.maxPlayers = 6;
    this.minPlayers = 2;
    this.players = new Array(this.maxPlayers).fill(null); // { id, name, connected, isBot }
    this.phase = PHASES.LOBBY;
    this.log = [];
    this._resetGameState();
  }

  _resetGameState() {
    this.turnOrder = [];
    this.turnIndex = 0;
    this.currentTurnSeat = null;
    this.scoreSheets = {}; // seat -> { catégorie: score|null }
    this.lastScoreEvent = null;
    this._resetTurnState();
  }

  _resetTurnState() {
    this.dice = [0, 0, 0, 0, 0];
    this.held = [false, false, false, false, false];
    this.rollsLeft = 3;
    this.hasRolled = false;
  }

  addLogEntry(text) {
    this.log.push(text);
    if (this.log.length > 200) this.log.shift();
  }

  // --- Gestion des joueurs (même logique de reprise de partie que Game.js) -

  addPlayer(socketId, name) {
    const existing = this.players.findIndex((p) => p && p.id === socketId);
    if (existing !== -1) {
      this.players[existing].connected = true;
      return existing;
    }

    const cleanName = (name || '').trim();
    if (cleanName) {
      const reconnectSeat = this.players.findIndex(
        (p) => p && !p.connected && !p.isBot && p.name === cleanName
      );
      if (reconnectSeat !== -1) {
        this.players[reconnectSeat].id = socketId;
        this.players[reconnectSeat].connected = true;
        this.addLogEntry(`${cleanName} reprend sa place (siège ${reconnectSeat + 1}).`);
        return reconnectSeat;
      }
    }

    const freeSeat = this.players.findIndex((p) => p === null);
    if (freeSeat === -1) return -1;
    this.players[freeSeat] = { id: socketId, name: cleanName || `Joueur ${freeSeat + 1}`, connected: true };
    this.addLogEntry(`${this.players[freeSeat].name} rejoint la table (siège ${freeSeat + 1}).`);
    return freeSeat;
  }

  addBotPlayer(name) {
    const freeSeat = this.players.findIndex((p) => p === null);
    if (freeSeat === -1) return -1;
    const botId = `bot-${this.roomId}-${freeSeat}-${Math.random().toString(36).slice(2, 8)}`;
    this.players[freeSeat] = {
      id: botId,
      name: name || `Robot ${freeSeat + 1}`,
      connected: true,
      isBot: true,
    };
    this.addLogEntry(`${this.players[freeSeat].name} (IA) rejoint la table (siège ${freeSeat + 1}).`);
    return freeSeat;
  }

  removePlayerBySocket(socketId) {
    const seat = this.players.findIndex((p) => p && p.id === socketId);
    if (seat === -1) return -1;
    this.players[seat].connected = false;
    this.addLogEntry(`${this.players[seat].name} s'est déconnecté.`);
    return seat;
  }

  isFull() {
    return this.players.every((p) => p !== null);
  }

  connectedCount() {
    return this.players.filter((p) => p && p.connected).length;
  }

  seatOfSocket(socketId) {
    return this.players.findIndex((p) => p && p.id === socketId);
  }

  canStart() {
    return this.phase === PHASES.LOBBY && this.players.filter((p) => p !== null).length >= this.minPlayers;
  }

  // --- Déroulement de la partie ---------------------------------------------

  startGame() {
    const seats = [];
    for (let i = 0; i < this.maxPlayers; i++) {
      if (this.players[i]) seats.push(i);
    }
    this.turnOrder = seats;
    this.turnIndex = 0;
    this.currentTurnSeat = this.turnOrder[0];
    this.scoreSheets = {};
    for (const s of seats) this.scoreSheets[s] = emptyScoreSheet();
    this.phase = PHASES.PLAYING;
    this._resetTurnState();
    this.lastScoreEvent = null;
    this.addLogEntry(`La partie commence — ${this.players[this.currentTurnSeat].name} joue en premier.`);
  }

  legalToAct(seat) {
    return this.phase === PHASES.PLAYING && seat === this.currentTurnSeat;
  }

  rollDice(seat) {
    if (this.phase !== PHASES.PLAYING) return { ok: false, error: 'La partie n\'est pas en cours.' };
    if (seat !== this.currentTurnSeat) return { ok: false, error: 'Ce n\'est pas votre tour.' };
    if (this.rollsLeft <= 0) {
      return { ok: false, error: 'Plus de lancer disponible : choisissez une catégorie.' };
    }
    for (let i = 0; i < 5; i++) {
      if (!this.held[i]) this.dice[i] = 1 + Math.floor(Math.random() * 6);
    }
    this.hasRolled = true;
    this.rollsLeft -= 1;
    return { ok: true };
  }

  toggleHold(seat, index) {
    if (this.phase !== PHASES.PLAYING) return { ok: false, error: 'La partie n\'est pas en cours.' };
    if (seat !== this.currentTurnSeat) return { ok: false, error: 'Ce n\'est pas votre tour.' };
    if (!this.hasRolled) return { ok: false, error: 'Lancez d\'abord les dés.' };
    if (this.rollsLeft <= 0) return { ok: false, error: 'Plus de lancer possible ce tour-ci.' };
    if (!Number.isInteger(index) || index < 0 || index > 4) return { ok: false, error: 'Dé invalide.' };
    this.held[index] = !this.held[index];
    return { ok: true };
  }

  // Utilisé par l'IA pour fixer directement l'ensemble des dés à garder,
  // plutôt que de basculer un par un.
  setHeldMask(seat, mask) {
    if (this.phase !== PHASES.PLAYING || seat !== this.currentTurnSeat) return { ok: false };
    this.held = [0, 1, 2, 3, 4].map((i) => !!mask[i]);
    return { ok: true };
  }

  scoreCategory(seat, category) {
    if (this.phase !== PHASES.PLAYING) return { ok: false, error: 'La partie n\'est pas en cours.' };
    if (seat !== this.currentTurnSeat) return { ok: false, error: 'Ce n\'est pas votre tour.' };
    if (!this.hasRolled) return { ok: false, error: 'Lancez d\'abord les dés.' };
    if (!CATEGORY_KEYS.includes(category)) return { ok: false, error: 'Catégorie invalide.' };
    const sheet = this.scoreSheets[seat];
    if (!sheet || sheet[category] !== null) return { ok: false, error: 'Cette catégorie est déjà remplie.' };

    const score = computeCategoryScore(this.dice, category);
    sheet[category] = score;
    const label = (CATEGORY_DEFS.find((c) => c.key === category) || {}).label || category;
    this.lastScoreEvent = { seat, category, score, playerName: this.players[seat].name, at: Date.now() };
    this.addLogEntry(`${this.players[seat].name} marque ${score} pt(s) en ${label}.`);

    this._advanceTurn();
    return { ok: true };
  }

  _advanceTurn() {
    const allDone = this.turnOrder.every((s) =>
      CATEGORY_KEYS.every((c) => this.scoreSheets[s][c] !== null)
    );
    if (allDone) {
      this.phase = PHASES.GAME_OVER;
      this.currentTurnSeat = null;
      this.addLogEntry('Partie terminée !');
      return;
    }
    let idx = this.turnIndex;
    for (let step = 0; step < this.turnOrder.length; step++) {
      idx = (idx + 1) % this.turnOrder.length;
      const s = this.turnOrder[idx];
      const hasRemaining = CATEGORY_KEYS.some((c) => this.scoreSheets[s][c] === null);
      if (hasRemaining) {
        this.turnIndex = idx;
        this.currentTurnSeat = s;
        break;
      }
    }
    this._resetTurnState();
  }

  // --- Rendu de l'état pour un siège donné -----------------------------------

  getStateFor(seat) {
    const players = this.players.map((p, i) =>
      p ? { seat: i, name: p.name, connected: p.connected, isBot: !!p.isBot } : null
    );
    const totals = {};
    for (const [s, sheet] of Object.entries(this.scoreSheets)) {
      totals[s] = computeTotals(sheet);
    }

    return {
      type: this.type,
      maxPlayers: this.maxPlayers,
      minPlayers: this.minPlayers,
      canStart: this.canStart(),
      roomId: this.roomId,
      phase: this.phase,
      players,
      currentTurnSeat: this.currentTurnSeat,
      dice: this.dice,
      held: this.held,
      rollsLeft: this.rollsLeft,
      hasRolled: this.hasRolled,
      scoreSheets: this.scoreSheets,
      totals,
      lastScoreEvent: this.lastScoreEvent,
      mySeat: seat,
      log: this.log.slice(-15),
    };
  }
}

module.exports = {
  YamsGame,
  PHASES,
  CATEGORY_DEFS,
  CATEGORY_KEYS,
  UPPER_KEYS,
  LOWER_KEYS,
  UPPER_BONUS_THRESHOLD,
  UPPER_BONUS,
  computeCategoryScore,
  computeTotals,
  emptyScoreSheet,
};
