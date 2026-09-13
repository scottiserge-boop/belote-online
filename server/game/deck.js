'use strict';

const SUITS = ['C', 'D', 'H', 'S']; // Trèfle, Carreau, Cœur, Pique
const RANKS = ['7', '8', '9', '10', 'J', 'Q', 'K', 'A'];

const SUIT_LABELS = { C: 'Trèfle', D: 'Carreau', H: 'Cœur', S: 'Pique' };
const SUIT_SYMBOLS = { C: '♣', D: '♦', H: '♥', S: '♠' };

// Ordre de force (index croissant = carte plus forte) et valeurs en points.
const NONTRUMP_ORDER = ['7', '8', '9', 'J', 'Q', 'K', '10', 'A'];
const TRUMP_ORDER = ['7', '8', 'Q', 'K', '10', 'A', '9', 'J'];

const NONTRUMP_POINTS = { 7: 0, 8: 0, 9: 0, J: 2, Q: 3, K: 4, 10: 10, A: 11 };
const TRUMP_POINTS = { 7: 0, 8: 0, Q: 3, K: 4, 10: 10, A: 11, 9: 14, J: 20 };

function cardId(suit, rank) {
  return `${suit}-${rank}`;
}

function createDeck() {
  const deck = [];
  for (const suit of SUITS) {
    for (const rank of RANKS) {
      deck.push({ suit, rank, id: cardId(suit, rank) });
    }
  }
  return deck;
}

function shuffle(array) {
  const a = array.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function cardOrderIndex(card, trumpSuit) {
  return card.suit === trumpSuit
    ? TRUMP_ORDER.indexOf(card.rank)
    : NONTRUMP_ORDER.indexOf(card.rank);
}

function cardPoints(card, trumpSuit) {
  return card.suit === trumpSuit ? TRUMP_POINTS[card.rank] : NONTRUMP_POINTS[card.rank];
}

module.exports = {
  SUITS,
  RANKS,
  SUIT_LABELS,
  SUIT_SYMBOLS,
  NONTRUMP_ORDER,
  TRUMP_ORDER,
  NONTRUMP_POINTS,
  TRUMP_POINTS,
  cardId,
  createDeck,
  shuffle,
  cardOrderIndex,
  cardPoints,
};
