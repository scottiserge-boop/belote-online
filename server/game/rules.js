'use strict';

const { cardOrderIndex, cardPoints } = require('./deck');

/**
 * Détermine, parmi les cartes jouées dans le pli en cours, laquelle est
 * actuellement "gagnante" compte tenu de l'atout et de la couleur demandée.
 * `trick` = tableau de { seat, card } dans l'ordre où elles ont été jouées.
 */
function currentBestPlay(trick, trumpSuit) {
  const ledSuit = trick[0].card.suit;
  let best = null;
  for (const play of trick) {
    const { card } = play;
    const isTrump = card.suit === trumpSuit;
    const followsLed = card.suit === ledSuit;
    if (!isTrump && !followsLed) continue; // ne peut pas gagner le pli
    const rank = isTrump ? 1000 + cardOrderIndex(card, trumpSuit) : cardOrderIndex(card, trumpSuit);
    if (!best || rank > best.rank) {
      best = { ...play, rank, isTrump };
    }
  }
  return best;
}

/**
 * Calcule les cartes jouables légalement pour un joueur, selon les règles
 * classiques de la belote (obligation de fournir, de couper et de surcouper).
 * `teamOf(seat)` renvoie l'identifiant d'équipe d'un siège donné.
 */
function computeLegalPlays(hand, trick, trumpSuit, mySeat, teamOf) {
  if (trick.length === 0) return hand.slice();

  const ledSuit = trick[0].card.suit;
  const best = currentBestPlay(trick, trumpSuit);
  const partnerIsWinning = !!best && teamOf(best.seat) === teamOf(mySeat) && best.seat !== mySeat;

  const sameSuitCards = hand.filter((c) => c.suit === ledSuit);
  const trumpCards = hand.filter((c) => c.suit === trumpSuit);

  if (ledSuit === trumpSuit) {
    if (sameSuitCards.length > 0) {
      if (partnerIsWinning) return sameSuitCards;
      const bestRank = best.rank - 1000;
      const higher = sameSuitCards.filter((c) => cardOrderIndex(c, trumpSuit) > bestRank);
      return higher.length > 0 ? higher : sameSuitCards;
    }
    return hand.slice();
  }

  if (sameSuitCards.length > 0) return sameSuitCards;

  if (trumpCards.length > 0) {
    if (partnerIsWinning) return hand.slice();
    if (best && best.isTrump) {
      const bestRank = best.rank - 1000;
      const higher = trumpCards.filter((c) => cardOrderIndex(c, trumpSuit) > bestRank);
      return higher.length > 0 ? higher : trumpCards;
    }
    return trumpCards;
  }

  return hand.slice();
}

function trickWinnerSeat(trick, trumpSuit) {
  const best = currentBestPlay(trick, trumpSuit);
  return best ? best.seat : trick[0].seat;
}

function trickPoints(trick, trumpSuit) {
  return trick.reduce((sum, play) => sum + cardPoints(play.card, trumpSuit), 0);
}

module.exports = {
  currentBestPlay,
  computeLegalPlays,
  trickWinnerSeat,
  trickPoints,
};
