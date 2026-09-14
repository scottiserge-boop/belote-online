'use strict';

const { createDeck, shuffle, SUITS } = require('./deck');
const { computeLegalPlays, trickWinnerSeat, trickPoints } = require('./rules');

const PHASES = {
  LOBBY: 'lobby',
  BIDDING: 'bidding',
  PLAYING: 'playing',
  HAND_END: 'hand_end',
  GAME_OVER: 'game_over',
};

const CAPOT_BONUS = 90; // bonus classique quand une équipe rafle les 8 plis

function teamOf(seat) {
  return seat % 2; // sièges 0 & 2 = équipe 0, sièges 1 & 3 = équipe 1
}

function nextSeat(seat) {
  return (seat + 1) % 4;
}

class Game {
  constructor(roomId, targetScore = 501) {
    this.type = 'belote'; // distingue ce salon d'un salon Yams pour le serveur et le client
    this.maxPlayers = 4;
    this.minPlayers = 4; // la Belote se joue toujours à 4 (2 équipes fixes)
    this.roomId = roomId;
    this.targetScore = targetScore;
    this.phase = PHASES.LOBBY;
    this.players = [null, null, null, null]; // { id, name, connected }
    this.dealer = 3; // sera incrémenté en début de manche -> premier donneur = siège 0
    this.matchScore = [0, 0];
    this.handNumber = 0;
    this.log = [];
    this._resetHandState();
  }

  _resetHandState() {
    this.hands = [[], [], [], []];
    this.trumpSuit = null;
    this.attackingTeam = null;
    this.callerSeat = null;
    this.biddingTurnSeat = null;
    this.biddingRound = 1; // 1 = prise à la retourne, 2 = enchère libre sur les 3 autres couleurs
    this.retourneCard = null; // carte retournée, visible pendant le 1er tour
    this.refusedSuit = null; // couleur de la retourne, exclue du 2e tour
    this.stock = []; // pioche restante à distribuer une fois l'atout choisi
    this.biddingPasses = 0;
    this.bidHistory = [];
    this.trick = [];
    this.tricksPlayed = 0;
    this.trickWins = []; // liste des { seat, points } par pli joué
    this.currentTurnSeat = null;
    this.teamCardPoints = [0, 0];
    this.beloteSeat = null; // siège possédant Roi+Dame d'atout
    this.beloteAnnouncedFor = null; // équipe ayant annoncé (une fois connu)
    this.lastTrick = null; // pour affichage bref après un pli complet
    this.handResult = null;
  }

  addLogEntry(text) {
    this.log.push(text);
    if (this.log.length > 200) this.log.shift();
  }

  // --- Gestion des joueurs -------------------------------------------------

  addPlayer(socketId, name) {
    const existing = this.players.findIndex((p) => p && p.id === socketId);
    if (existing !== -1) {
      this.players[existing].connected = true;
      return existing;
    }

    // Reprise de partie : si un siège porte déjà exactement le même pseudo et
    // est actuellement déconnecté (onglet fermé par erreur, perte de réseau...),
    // on redonne ce siège (et donc sa main en cours) à ce joueur plutôt que
    // de lui en attribuer un nouveau.
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

  // Remplace un siège libre par un joueur IA : il n'a pas de socket réel, mais
  // se comporte comme un joueur connecté en permanence (voir server.js pour la
  // logique de jeu automatique).
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

  // Condition pour activer le bouton "Démarrer" côté client : pour la Belote,
  // il faut impérativement les 4 sièges (2 équipes fixes de 2).
  canStart() {
    return this.phase === PHASES.LOBBY && this.isFull();
  }

  connectedCount() {
    return this.players.filter((p) => p && p.connected).length;
  }

  seatOfSocket(socketId) {
    return this.players.findIndex((p) => p && p.id === socketId);
  }

  // --- Distribution & enchères ---------------------------------------------

  startNewHand() {
    this.handNumber += 1;
    this.dealer = nextSeat(this.dealer);
    this._resetHandState();

    const deck = shuffle(createDeck());
    for (let seat = 0; seat < 4; seat++) {
      this.hands[seat] = deck.slice(seat * 5, seat * 5 + 5);
    }
    this.retourneCard = deck[20]; // 21ème carte, retournée pour proposer l'atout
    this.stock = deck.slice(21); // les 11 cartes restantes seront distribuées après l'enchère

    this.phase = PHASES.BIDDING;
    this.biddingRound = 1;
    this.biddingTurnSeat = nextSeat(this.dealer);
    this.addLogEntry(
      `Manche ${this.handNumber} — donneur : ${this.players[this.dealer].name}. Retourne : ${this.retourneCard.rank}${this.retourneCard.suit}.`
    );
  }

  currentBidder() {
    return this.biddingTurnSeat;
  }

  // Distribue les cartes restantes de la pioche pour amener toutes les mains à 8 cartes.
  _completeDeal() {
    const order = [0, 1, 2, 3].map((i) => (this.dealer + 1 + i) % 4);
    let idx = 0;
    for (const seat of order) {
      const need = 8 - this.hands[seat].length;
      for (let k = 0; k < need; k++) {
        this.hands[seat].push(this.stock[idx]);
        idx += 1;
      }
    }
    this.stock = [];
  }

  _setTrumpAndStartPlay(seat, suit) {
    this.trumpSuit = suit;
    this.callerSeat = seat;
    this.attackingTeam = teamOf(seat);
    this._completeDeal();
    this._detectBelote();
    this._beginPlayPhase();
  }

  bid(seat, action, suit) {
    if (this.phase !== PHASES.BIDDING || seat !== this.biddingTurnSeat) {
      return { ok: false, error: 'Ce n\'est pas votre tour d\'enchérir.' };
    }

    if (this.biddingRound === 1) {
      if (action === 'pass') {
        this.bidHistory.push({ seat, action: 'pass', round: 1 });
        this.biddingPasses += 1;
        this.addLogEntry(`${this.players[seat].name} passe (1er tour).`);
        if (this.biddingPasses >= 4) {
          // Personne ne prend la retourne au 1er tour : elle reste "en jeu" (on ne
          // la donne pas encore au donneur). C'est le premier joueur qui annonce
          // une couleur au 2e tour qui la ramassera dans sa main (voir plus bas).
          this.refusedSuit = this.retourneCard.suit;
          this.biddingRound = 2;
          this.biddingPasses = 0;
          this.biddingTurnSeat = nextSeat(this.dealer);
          this.addLogEntry('Personne ne prend, deuxième tour d\'enchères (couleur de la retourne exclue).');
          return { ok: true };
        }
        this.biddingTurnSeat = nextSeat(this.biddingTurnSeat);
        return { ok: true };
      }

      if (action === 'take') {
        const takenSuit = this.retourneCard.suit;
        this.hands[seat].push(this.retourneCard);
        this.retourneCard = null;
        this.bidHistory.push({ seat, action: 'take', suit: takenSuit, round: 1 });
        this.addLogEntry(`${this.players[seat].name} prend à ${takenSuit}.`);
        this._setTrumpAndStartPlay(seat, takenSuit);
        return { ok: true };
      }

      return { ok: false, error: 'Au premier tour, vous devez "prendre" la retourne ou "passer".' };
    }

    // Deuxième tour : enchère libre sur les 3 couleurs restantes.
    if (action === 'pass') {
      this.bidHistory.push({ seat, action: 'pass', round: 2 });
      this.biddingPasses += 1;
      this.addLogEntry(`${this.players[seat].name} passe (2e tour).`);
      if (this.biddingPasses >= 4) {
        this.addLogEntry('Tout le monde a passé aux deux tours, redistribution.');
        this.startNewHand();
        return { ok: true, redealt: true };
      }
      this.biddingTurnSeat = nextSeat(this.biddingTurnSeat);
      return { ok: true };
    }

    if (action === 'call') {
      if (!SUITS.includes(suit)) return { ok: false, error: 'Couleur invalide.' };
      if (suit === this.refusedSuit) {
        return { ok: false, error: 'Vous ne pouvez pas rappeler la couleur refusée au premier tour.' };
      }
      this.bidHistory.push({ seat, action: 'call', suit, round: 2 });
      // Le premier joueur à annoncer une couleur au 2e tour ramasse la carte
      // retournée dans sa main (elle n'a jamais été donnée au donneur).
      this.hands[seat].push(this.retourneCard);
      this.retourneCard = null;
      this.addLogEntry(`${this.players[seat].name} prend à ${suit} (2e tour) et ramasse la carte retournée.`);
      this._setTrumpAndStartPlay(seat, suit);
      return { ok: true };
    }

    return { ok: false, error: 'Au deuxième tour, vous devez "appeler" une couleur ou "passer".' };
  }

  _detectBelote() {
    for (let seat = 0; seat < 4; seat++) {
      const hasKing = this.hands[seat].some((c) => c.suit === this.trumpSuit && c.rank === 'K');
      const hasQueen = this.hands[seat].some((c) => c.suit === this.trumpSuit && c.rank === 'Q');
      if (hasKing && hasQueen) {
        this.beloteSeat = seat;
        break;
      }
    }
  }

  _beginPlayPhase() {
    this.phase = PHASES.PLAYING;
    this.currentTurnSeat = nextSeat(this.dealer);
    this.trick = [];
  }

  // --- Phase de jeu ---------------------------------------------------------

  legalPlaysFor(seat) {
    if (this.phase !== PHASES.PLAYING) return [];
    return computeLegalPlays(this.hands[seat], this.trick, this.trumpSuit, seat, teamOf);
  }

  playCard(seat, cardId) {
    if (this.phase !== PHASES.PLAYING || seat !== this.currentTurnSeat) {
      return { ok: false, error: 'Ce n\'est pas votre tour de jouer.' };
    }
    const hand = this.hands[seat];
    const cardIndex = hand.findIndex((c) => c.id === cardId);
    if (cardIndex === -1) return { ok: false, error: 'Carte inconnue.' };
    const card = hand[cardIndex];

    const legal = this.legalPlaysFor(seat);
    if (!legal.some((c) => c.id === cardId)) {
      return { ok: false, error: 'Coup non autorisé (fournir/couper/monter obligatoire).' };
    }

    hand.splice(cardIndex, 1);
    this.trick.push({ seat, card });

    let beloteEvent = null;
    if (this.beloteSeat === seat && card.suit === this.trumpSuit && (card.rank === 'K' || card.rank === 'Q')) {
      beloteEvent = { seat, team: teamOf(seat) };
    }

    let trickResult = null;
    if (this.trick.length === 4) {
      trickResult = this._resolveTrick();
    } else {
      this.currentTurnSeat = nextSeat(this.currentTurnSeat);
    }

    return { ok: true, beloteEvent, trickResult };
  }

  _resolveTrick() {
    const winnerSeat = trickWinnerSeat(this.trick, this.trumpSuit);
    const points = trickPoints(this.trick, this.trumpSuit);
    const team = teamOf(winnerSeat);
    this.teamCardPoints[team] += points;
    this.tricksPlayed += 1;
    this.trickWins.push({ seat: winnerSeat, points });

    const isLastTrick = this.tricksPlayed === 8;
    if (isLastTrick) {
      this.teamCardPoints[team] += 10; // dix de der
    }

    this.lastTrick = { cards: this.trick.slice(), winnerSeat };
    this.trick = [];
    this.currentTurnSeat = winnerSeat;

    let handEnded = false;
    if (isLastTrick) {
      this._scoreHand();
      handEnded = true;
    }

    return { winnerSeat, points, isLastTrick, handEnded };
  }

  _scoreHand() {
    const attacking = this.attackingTeam;
    const defending = 1 - attacking;
    const attackingTricks = this.trickWins.filter((t) => teamOf(t.seat) === attacking).length;
    const defendingTricks = 8 - attackingTricks;

    const beloteTeam = this.beloteSeat !== null ? teamOf(this.beloteSeat) : null;
    const beloteBonus = [0, 0];
    if (beloteTeam !== null) beloteBonus[beloteTeam] = 20;

    let handScore = [0, 0];
    let outcome;

    if (attackingTricks === 8) {
      handScore[attacking] = 162 + CAPOT_BONUS;
      handScore[defending] = 0;
      outcome = 'capot_attaque';
    } else if (defendingTricks === 8) {
      handScore[defending] = 162 + CAPOT_BONUS;
      handScore[attacking] = 0;
      outcome = 'capot_defense';
    } else if (this.teamCardPoints[attacking] >= 82) {
      handScore[attacking] = this.teamCardPoints[attacking];
      handScore[defending] = this.teamCardPoints[defending];
      outcome = 'reussi';
    } else {
      handScore[attacking] = 0;
      handScore[defending] = 162;
      outcome = 'chute';
    }

    handScore[0] += beloteBonus[0];
    handScore[1] += beloteBonus[1];

    this.matchScore[0] += handScore[0];
    this.matchScore[1] += handScore[1];

    this.handResult = {
      outcome,
      attackingTeam: attacking,
      trumpSuit: this.trumpSuit,
      callerSeat: this.callerSeat,
      cardPoints: this.teamCardPoints.slice(),
      handScore,
      beloteTeam,
      matchScoreAfter: this.matchScore.slice(),
    };

    this.addLogEntry(
      `Fin de manche ${this.handNumber} : ${outcome} — équipe A ${handScore[0]} pts, équipe B ${handScore[1]} pts (total ${this.matchScore[0]}-${this.matchScore[1]}).`
    );

    if (this.matchScore[0] >= this.targetScore || this.matchScore[1] >= this.targetScore) {
      this.phase = PHASES.GAME_OVER;
    } else {
      this.phase = PHASES.HAND_END;
    }
  }

  // --- Rendu de l'état pour un siège donné ---------------------------------

  getStateFor(seat) {
    const players = this.players.map((p, i) =>
      p
        ? { seat: i, name: p.name, connected: p.connected, isBot: !!p.isBot, cardCount: this.hands[i].length }
        : null
    );

    return {
      type: this.type,
      maxPlayers: this.maxPlayers,
      minPlayers: this.minPlayers,
      canStart: this.canStart(),
      roomId: this.roomId,
      phase: this.phase,
      players,
      dealer: this.dealer,
      handNumber: this.handNumber,
      matchScore: this.matchScore,
      targetScore: this.targetScore,
      trumpSuit: this.trumpSuit,
      callerSeat: this.callerSeat,
      attackingTeam: this.attackingTeam,
      biddingTurnSeat: this.biddingTurnSeat,
      biddingRound: this.biddingRound,
      retourneCard: this.retourneCard,
      refusedSuit: this.refusedSuit,
      bidHistory: this.bidHistory,
      currentTurnSeat: this.currentTurnSeat,
      trick: this.trick,
      lastTrick: this.lastTrick,
      teamCardPoints: this.teamCardPoints,
      handResult: this.handResult,
      mySeat: seat,
      myHand: seat !== null && seat >= 0 ? this.hands[seat] : [],
      legalPlays: seat !== null && seat >= 0 ? this.legalPlaysFor(seat).map((c) => c.id) : [],
      log: this.log.slice(-15),
    };
  }
}

module.exports = { Game, PHASES, teamOf };
