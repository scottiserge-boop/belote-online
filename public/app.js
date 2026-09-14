'use strict';

const socket = io();

const SUIT_SYMBOLS = { C: '♣', D: '♦', H: '♥', S: '♠' };
const SUIT_LABELS = { C: 'Trèfle', D: 'Carreau', H: 'Cœur', S: 'Pique' };
const RED_SUITS = new Set(['D', 'H']);
const RANK_ORDER = ['7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
const SUIT_DISPLAY_ORDER = ['S', 'H', 'D', 'C'];

const el = (id) => document.getElementById(id);

let joined = false;
let mySeat = null;
let lastPhase = null;
let lastTrumpSuit = null;

// --- Écran d'accueil -------------------------------------------------------

el('btn-create').addEventListener('click', () => {
  const name = el('create-name').value.trim() || 'Joueur';
  const targetScore = parseInt(el('create-target').value, 10);
  socket.emit('create_room', { name, targetScore }, (res) => {
    if (!res.ok) {
      el('home-error').textContent = res.error || 'Erreur inconnue.';
      return;
    }
    mySeat = res.seat;
  });
});

el('btn-join').addEventListener('click', () => {
  const name = el('join-name').value.trim() || 'Joueur';
  const roomId = el('join-code').value.trim().toUpperCase();
  if (!roomId) {
    el('home-error').textContent = 'Merci de saisir un code de salon.';
    return;
  }
  socket.emit('join_room', { roomId, name }, (res) => {
    if (!res.ok) {
      el('home-error').textContent = res.error || 'Erreur inconnue.';
      return;
    }
    mySeat = res.seat;
  });
});

el('btn-join-ai').addEventListener('click', () => {
  const roomId = el('join-code').value.trim().toUpperCase();
  if (!roomId) {
    el('home-error').textContent = 'Merci de saisir le code du salon à compléter avec une IA.';
    return;
  }
  socket.emit('add_bot', { roomId }, (res) => {
    if (!res.ok) {
      el('home-error').textContent = res.error || 'Erreur inconnue.';
      return;
    }
  });
});

el('btn-start').addEventListener('click', () => socket.emit('start_game'));
el('btn-next-hand').addEventListener('click', () => socket.emit('next_hand'));

document.querySelectorAll('#round2-actions .suit-btn').forEach((btn) => {
  btn.addEventListener('click', () => socket.emit('bid', { action: 'call', suit: btn.dataset.suit }));
});
el('btn-take').addEventListener('click', () => socket.emit('bid', { action: 'take' }));
el('btn-pass-1').addEventListener('click', () => socket.emit('bid', { action: 'pass' }));
el('btn-pass-2').addEventListener('click', () => socket.emit('bid', { action: 'pass' }));

el('log-toggle').addEventListener('click', () => el('log-panel').classList.toggle('hidden'));

socket.on('error_message', (msg) => showToast(msg));

socket.on('state', (state) => {
  mySeat = state.mySeat;
  joined = true;
  renderState(state);
});

function showToast(text) {
  const toast = el('toast');
  toast.textContent = text;
  toast.classList.remove('hidden');
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => toast.classList.add('hidden'), 6000);
}

function showScreen(name) {
  ['screen-home', 'screen-lobby', 'screen-game'].forEach((id) => el(id).classList.toggle('hidden', id !== name));
}

// --- Rendu principal --------------------------------------------------------

function renderState(state) {
  if (state.phase === 'lobby') {
    showScreen('screen-lobby');
    renderLobby(state);
    return;
  }

  showScreen('screen-game');
  renderGameHeader(state);
  renderTable(state);
  renderBiddingPanel(state);
  renderHand(state);
  renderLog(state);
  renderHandEndOverlay(state);
  renderGameOverOverlay(state);

  if (state.phase !== lastPhase && state.phase === 'playing') {
    el('overlay-hand-end').classList.add('hidden');
  }
  lastPhase = state.phase;

  // Dès que l'atout vient d'être fixé (1er ou 2e tour d'enchères), on affiche
  // un message (6 secondes, voir showToast) annonçant qui a pris et à quelle
  // couleur, pour que toute la table le voie clairement.
  if (state.trumpSuit && state.trumpSuit !== lastTrumpSuit) {
    const taker = state.players[state.callerSeat];
    if (taker) {
      const suitLabel = SUIT_LABELS[state.trumpSuit] || state.trumpSuit;
      const suitSymbol = SUIT_SYMBOLS[state.trumpSuit] || '';
      showToast(`${taker.name} prend à ${suitLabel} ${suitSymbol}`);
    }
  }
  lastTrumpSuit = state.trumpSuit;
}

function renderLobby(state) {
  el('lobby-code').textContent = state.roomId;
  const list = el('lobby-seats');
  list.innerHTML = '';
  state.players.forEach((p, seat) => {
    const li = document.createElement('li');
    const team = seat % 2 === 0 ? 'Équipe A' : 'Équipe B';
    if (p) {
      const botTag = p.isBot ? ' 🤖' : '';
      li.innerHTML = `<span>${escapeHtml(p.name)}${botTag}${seat === state.mySeat ? ' (vous)' : ''}</span><span class="team-tag">${team}</span>`;
    } else {
      li.innerHTML = `<span class="empty">Place libre — siège ${seat + 1}</span><span class="team-tag">${team}</span>`;
    }
    list.appendChild(li);
  });
  const full = state.players.every((p) => p !== null);
  const startBtn = el('btn-start');
  startBtn.disabled = !full;
  startBtn.textContent = full ? 'Démarrer la partie' : 'En attente des 4 joueurs…';
}

function renderGameHeader(state) {
  el('game-code').textContent = state.roomId;
  el('score-a').textContent = state.matchScore[0];
  el('score-b').textContent = state.matchScore[1];
  el('score-target').textContent = state.targetScore;
  el('hand-number').textContent = state.handNumber;
  el('trump-indicator').textContent = state.trumpSuit ? SUIT_SYMBOLS[state.trumpSuit] : '—';
  el('trump-indicator').style.color = state.trumpSuit && RED_SUITS.has(state.trumpSuit) ? '#ff6f6f' : '#f1f1f1';

  // Sous-total de la manche en cours (points de cartes remportés jusqu'ici
  // dans les plis déjà joués), distinct du score total de la partie.
  const subtotalWrap = el('hand-subtotal-wrap');
  const showSubtotal = state.phase === 'playing' || state.phase === 'hand_end';
  subtotalWrap.classList.toggle('hidden', !showSubtotal);
  if (showSubtotal) {
    el('subtotal-a').textContent = state.teamCardPoints[0];
    el('subtotal-b').textContent = state.teamCardPoints[1];
  }
}

function seatLabel(state, seat) {
  const p = state.players[seat];
  if (!p) return null;
  return p;
}

function renderSeat(containerId, state, seat) {
  const container = el(containerId);
  container.innerHTML = '';
  const p = seatLabel(state, seat);

  const nameEl = document.createElement('div');
  nameEl.className = 'seat-name';
  const isTurn =
    (state.phase === 'bidding' && state.biddingTurnSeat === seat) ||
    (state.phase === 'playing' && state.currentTurnSeat === seat);
  if (isTurn) nameEl.classList.add('turn');
  if (state.dealer === seat) nameEl.classList.add('seat-dealer');

  if (p) {
    nameEl.textContent = p.name + (p.isBot ? ' 🤖' : '') + (seat === state.mySeat ? ' (vous)' : '');
    if (!p.connected) nameEl.classList.add('disconnected');
  } else {
    nameEl.textContent = 'En attente…';
  }
  if (isTurn) {
    const star = document.createElement('span');
    star.className = 'turn-star';
    star.textContent = ' ⭐';
    nameEl.appendChild(star);
  }
  container.appendChild(nameEl);

  const teamTag = document.createElement('div');
  teamTag.style.fontSize = '0.72rem';
  teamTag.style.color = seat % 2 === 0 ? '#6fc9ff' : '#ff9e6f';
  teamTag.textContent = seat % 2 === 0 ? 'Équipe A' : 'Équipe B';
  container.appendChild(teamTag);

  if (p) {
    const mini = document.createElement('div');
    mini.className = 'mini-cards';
    const count = seat === state.mySeat ? 0 : p.cardCount; // ma propre main est affichée en bas
    for (let i = 0; i < count; i++) {
      const c = document.createElement('div');
      c.className = 'mini-card';
      mini.appendChild(c);
    }
    container.appendChild(mini);
  }
}

function renderTable(state) {
  // Disposition dans le sens des aiguilles d'une montre : depuis "moi" en
  // bas, le joueur suivant (ordre de jeu = siège + 1) est placé à gauche,
  // puis en haut, puis à droite, avant de revenir à moi — comme sur une
  // horloge où 6h (bas) -> 9h (gauche) -> 12h (haut) -> 3h (droite).
  const bottom = state.mySeat >= 0 ? state.mySeat : 0;
  const left = (bottom + 1) % 4;
  const top = (bottom + 2) % 4;
  const right = (bottom + 3) % 4;

  renderSeat('seat-bottom', state, bottom);
  renderSeat('seat-right', state, right);
  renderSeat('seat-top', state, top);
  renderSeat('seat-left', state, left);

  renderTrick(state, bottom);
  renderLastTrick(state);
}

// Même logique horaire pour placer les cartes jouées dans la zone de pli :
// relSeat 0=moi(bas), 1=joueur suivant(gauche), 2=en face(haut), 3=avant moi(droite).
const SLOT_CLASSES = ['pos-bottom', 'pos-left', 'pos-top', 'pos-right'];

function renderTrick(state, bottom) {
  const trickArea = el('trick-area');
  trickArea.innerHTML = '';
  const banner = el('trick-winner-banner');

  const trickJustCompleted = state.trick.length === 0 && state.lastTrick;
  const cardsToShow = state.trick.length > 0 ? state.trick : (state.lastTrick ? state.lastTrick.cards : []);
  const winnerSeat = trickJustCompleted ? state.lastTrick.winnerSeat : null;

  // Pendant les enchères (aucune carte jouée), on réduit la zone de pli à rien
  // pour laisser plus de place au panneau d'enchères sur les petits écrans.
  trickArea.classList.toggle('empty', cardsToShow.length === 0);

  cardsToShow.forEach((play) => {
    const relSeat = (play.seat - bottom + 4) % 4; // 0=bas, 1=droite, 2=haut, 3=gauche
    const slot = document.createElement('div');
    slot.className = `trick-slot ${SLOT_CLASSES[relSeat]}`;

    const cardEl = buildCardEl(play.card, state.trumpSuit);
    cardEl.classList.add('trick-card');
    const isWinner = winnerSeat !== null && play.seat === winnerSeat;
    if (isWinner) cardEl.classList.add('winner');
    slot.appendChild(cardEl);

    const from = document.createElement('div');
    from.className = 'from' + (isWinner ? ' winner-name' : '');
    const p = state.players[play.seat];
    from.textContent = (p ? p.name : '') + (isWinner ? ' 🏆' : '');
    slot.appendChild(from);

    trickArea.appendChild(slot);
  });

  if (trickJustCompleted) {
    const winnerPlayer = state.players[winnerSeat];
    const winnerTeam = winnerSeat % 2 === 0 ? 'Équipe A' : 'Équipe B';
    banner.textContent = `Pli remporté par ${winnerPlayer ? winnerPlayer.name : '?'} (${winnerTeam})`;
    banner.classList.remove('hidden');
  } else {
    banner.classList.add('hidden');
  }
}

// Panneau persistant montrant le dernier pli complété (visible même une
// fois que le pli suivant a commencé), pour qu'on puisse toujours vérifier
// qui a gagné le coup précédent.
function renderLastTrick(state) {
  const panel = el('last-trick-panel');
  if (!state.lastTrick) {
    panel.classList.add('hidden');
    return;
  }
  panel.classList.remove('hidden');
  const container = el('last-trick-cards');
  container.innerHTML = '';
  state.lastTrick.cards.forEach(({ seat, card }) => {
    const mini = document.createElement('div');
    mini.className = 'last-trick-mini';
    if (RED_SUITS.has(card.suit)) mini.classList.add('red');
    if (seat === state.lastTrick.winnerSeat) mini.classList.add('winner');
    mini.textContent = `${card.rank}${SUIT_SYMBOLS[card.suit]}`;
    const p = state.players[seat];
    mini.title = (p ? p.name : '') + (seat === state.lastTrick.winnerSeat ? ' (gagnant)' : '');
    container.appendChild(mini);
  });
}

function buildCardEl(card, trumpSuit) {
  const div = document.createElement('div');
  div.className = 'card';
  if (RED_SUITS.has(card.suit)) div.classList.add('red');
  if (trumpSuit && card.suit === trumpSuit) div.style.borderColor = '#d4af37';
  const rank = document.createElement('div');
  rank.textContent = card.rank;
  const suit = document.createElement('div');
  suit.className = 'suit';
  suit.textContent = SUIT_SYMBOLS[card.suit];
  div.appendChild(rank);
  div.appendChild(suit);
  div.dataset.cardId = card.id;
  return div;
}

function renderBiddingPanel(state) {
  const panel = el('bidding-panel');
  if (state.phase !== 'bidding') {
    panel.classList.add('hidden');
    return;
  }
  panel.classList.remove('hidden');
  const myTurn = state.biddingTurnSeat === state.mySeat;
  const bidderName = state.players[state.biddingTurnSeat] ? state.players[state.biddingTurnSeat].name : '?';

  const retourneDisplay = el('retourne-display');
  const round1Actions = el('round1-actions');
  const round2Actions = el('round2-actions');

  if (state.biddingRound === 1) {
    retourneDisplay.classList.remove('hidden');
    round1Actions.classList.remove('hidden');
    round2Actions.classList.add('hidden');

    const retourneCardEl = el('retourne-card');
    retourneCardEl.innerHTML = '';
    if (state.retourneCard) {
      const built = buildCardEl(state.retourneCard, null);
      retourneCardEl.className = built.className;
      retourneCardEl.innerHTML = built.innerHTML;
    }

    el('bidding-status').textContent = myTurn
      ? `À vous : prenez à ${SUIT_SYMBOLS[state.retourneCard.suit]} ou passez.`
      : `En attente de la décision de ${bidderName} (1er tour)…`;
    el('btn-take').disabled = !myTurn;
    el('btn-pass-1').disabled = !myTurn;
  } else {
    retourneDisplay.classList.add('hidden');
    round1Actions.classList.add('hidden');
    round2Actions.classList.remove('hidden');

    el('bidding-status').textContent = myTurn
      ? 'À vous : appelez une couleur (autre que la retourne refusée) ou passez.'
      : `En attente de l'enchère de ${bidderName} (2e tour)…`;
    document.querySelectorAll('#round2-actions .suit-btn').forEach((btn) => {
      btn.disabled = !myTurn || btn.dataset.suit === state.refusedSuit;
    });
    el('btn-pass-2').disabled = !myTurn;
  }
}

// Taille de carte courante selon la largeur d'écran (doit rester alignée
// avec les points de rupture définis dans style.css pour .card).
function currentCardSize() {
  const w = window.innerWidth;
  if (w <= 400) return { w: 54, h: 81 };
  if (w <= 640) return { w: 66, h: 99 };
  return { w: 84, h: 126 };
}

// Ordre d'affichage des couleurs dans la main : l'atout toujours à gauche
// (quand il est connu et présent en main), puis les couleurs suivantes en
// alternant rouge/noir. Le calcul se base sur les couleurs réellement
// présentes dans la main : sans cela, une couleur absente (0 carte) peut
// laisser deux groupes de même teinte se retrouver côte à côte (ex : atout
// carreau + cœur adjacents, tous deux rouges) si on se contentait de filtrer
// un ordre figé.
function suitDisplayOrder(trumpSuit, suitCounts) {
  const colorOf = (s) => (RED_SUITS.has(s) ? 'red' : 'black');
  const present = SUIT_DISPLAY_ORDER.filter((s) => !suitCounts || suitCounts[s] > 0);
  const pool = present.length ? present.slice() : SUIT_DISPLAY_ORDER.slice();

  const order = [];
  let startSuit = null;
  if (trumpSuit && pool.includes(trumpSuit)) {
    startSuit = trumpSuit;
  } else if (pool.length) {
    startSuit = pool[0];
  }
  if (startSuit) {
    order.push(startSuit);
    pool.splice(pool.indexOf(startSuit), 1);
  }
  while (pool.length) {
    const lastColor = order.length ? colorOf(order[order.length - 1]) : null;
    let idx = pool.findIndex((s) => colorOf(s) !== lastColor);
    if (idx === -1) idx = 0;
    order.push(pool[idx]);
    pool.splice(idx, 1);
  }
  // Complète avec les couleurs totalement absentes de la main (peu importe où,
  // puisqu'aucune carte ne s'y trouve) pour que le comparateur indexOf() reste valide.
  for (const s of SUIT_DISPLAY_ORDER) {
    if (!order.includes(s)) order.push(s);
  }
  return order;
}

function renderHand(state) {
  const container = el('my-hand');
  container.innerHTML = '';
  const canPlay = state.phase === 'playing' && state.currentTurnSeat === state.mySeat;
  const legalSet = new Set(state.legalPlays || []);

  const suitCounts = {};
  (state.myHand || []).forEach((c) => { suitCounts[c.suit] = (suitCounts[c.suit] || 0) + 1; });
  const order = suitDisplayOrder(state.trumpSuit, suitCounts);
  const sorted = (state.myHand || []).slice().sort((a, b) => {
    const suitDiff = order.indexOf(a.suit) - order.indexOf(b.suit);
    if (suitDiff !== 0) return suitDiff;
    return RANK_ORDER.indexOf(a.rank) - RANK_ORDER.indexOf(b.rank);
  });

  const n = sorted.length;
  const { w: cardW, h: cardH } = currentCardSize();

  // Éventail : les cartes se chevauchent et pivotent légèrement autour d'un
  // point de pivot sous la main, comme un vrai jeu de cartes tenu en main.
  const maxAnglePerCard = 6.5; // degrés
  const maxTotalAngle = 42;
  const totalAngle = n > 1 ? Math.min(maxAnglePerCard * (n - 1), maxTotalAngle) : 0;
  const angleStep = n > 1 ? totalAngle / (n - 1) : 0;

  const maxContainerWidth = Math.min(window.innerWidth - 24, 640);
  const desiredStep = cardW * 0.58;
  const overlapStep = n > 1 ? Math.min(desiredStep, (maxContainerWidth - cardW) / (n - 1)) : 0;
  const arcHeight = cardW <= 54 ? 13 : cardW <= 66 ? 17 : 23;

  const centerIndex = (n - 1) / 2;

  container.style.height = `${cardH + arcHeight + 22}px`;

  sorted.forEach((card, i) => {
    const offset = i - centerIndex;
    const angle = offset * angleStep;
    const x = offset * overlapStep;
    const arcY = centerIndex > 0 ? arcHeight * Math.pow(offset / centerIndex, 2) : 0;

    const slot = document.createElement('div');
    slot.className = 'hand-slot';
    slot.style.zIndex = String(i);
    slot.style.transform = `translateX(calc(-50% + ${x}px)) rotate(${angle}deg) translateY(${arcY}px)`;

    const cardEl = buildCardEl(card, state.trumpSuit);
    const isLegal = canPlay && legalSet.has(card.id);
    if (!canPlay || (state.phase === 'playing' && !legalSet.has(card.id))) {
      cardEl.classList.add('disabled');
    }
    if (isLegal) cardEl.classList.add('playable');
    cardEl.addEventListener('click', () => {
      if (!canPlay) {
        showToast('Ce n\'est pas votre tour.');
        return;
      }
      if (!legalSet.has(card.id)) {
        showToast('Coup non autorisé : vous devez fournir, couper ou monter.');
        return;
      }
      socket.emit('play_card', { cardId: card.id });
    });

    slot.appendChild(cardEl);
    container.appendChild(slot);
  });
}

// Un redimensionnement (rotation d'écran, changement de fenêtre) doit
// recalculer l'éventail : on ré-affiche simplement le dernier état connu.
let lastRenderedState = null;
window.addEventListener('resize', () => {
  if (lastRenderedState) renderHand(lastRenderedState);
});

function renderLog(state) {
  const panel = el('log-panel');
  panel.innerHTML = '';
  (state.log || []).forEach((line) => {
    const d = document.createElement('div');
    d.textContent = line;
    panel.appendChild(d);
  });
  panel.scrollTop = panel.scrollHeight;
}

const OUTCOME_LABELS = {
  reussi: 'Contrat réussi ✅',
  chute: 'Chute ! ❌',
  capot_attaque: 'Capot pour l\'équipe attaquante ! 🏆',
  capot_defense: 'Capot défense ! 🛡️',
};

function renderHandEndOverlay(state) {
  const overlay = el('overlay-hand-end');
  if (state.phase !== 'hand_end' || !state.handResult) {
    overlay.classList.add('hidden');
    return;
  }
  overlay.classList.remove('hidden');
  const r = state.handResult;
  el('hand-end-title').textContent = OUTCOME_LABELS[r.outcome] || r.outcome;
  const attackTeam = r.attackingTeam === 0 ? 'Équipe A' : 'Équipe B';
  el('hand-end-detail').textContent = `${attackTeam} avait pris à ${SUIT_SYMBOLS[r.trumpSuit]} — ${r.cardPoints[0]} / ${r.cardPoints[1]} points de cartes.`;
  el('hand-end-score').textContent = `Manche : Équipe A +${r.handScore[0]}, Équipe B +${r.handScore[1]} · Total ${r.matchScoreAfter[0]} - ${r.matchScoreAfter[1]}`;
}

function renderGameOverOverlay(state) {
  const overlay = el('overlay-game-over');
  if (state.phase !== 'game_over') {
    overlay.classList.add('hidden');
    return;
  }
  overlay.classList.remove('hidden');
  const winner = state.matchScore[0] > state.matchScore[1] ? 'Équipe A' : 'Équipe B';
  el('game-over-title').textContent = `🏆 ${winner} remporte la partie !`;
  el('game-over-score').textContent = `Score final : ${state.matchScore[0]} - ${state.matchScore[1]}`;
}

function escapeHtml(str) {
  return str.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
