'use strict';

const { Game } = require('./game/Game');

const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // sans caractères ambigus

class RoomManager {
  constructor() {
    this.rooms = new Map(); // roomId -> Game
  }

  generateRoomId() {
    let code;
    do {
      code = Array.from({ length: 4 }, () => CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]).join('');
    } while (this.rooms.has(code));
    return code;
  }

  createRoom(targetScore) {
    const roomId = this.generateRoomId();
    const game = new Game(roomId, targetScore);
    this.rooms.set(roomId, game);
    return game;
  }

  getRoom(roomId) {
    return this.rooms.get((roomId || '').toUpperCase());
  }

  deleteRoom(roomId) {
    this.rooms.delete(roomId);
  }

  // Nettoie les salons vides depuis longtemps (aucun joueur connecté).
  pruneEmptyRooms() {
    for (const [roomId, game] of this.rooms.entries()) {
      if (game.connectedCount() === 0) {
        this.rooms.delete(roomId);
      }
    }
  }
}

module.exports = { RoomManager };
