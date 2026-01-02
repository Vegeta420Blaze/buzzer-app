
// RiBo Buzzer — server.js
// Express + Socket.IO single service (static + sockets), in-memory rooms.

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
app.use(express.static(path.join(__dirname, 'public')));

// Health check
app.get('/healthz', (req, res) => res.status(200).send('OK'));

// HTTP + Socket.IO
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: false } });

// ---------------- In-Memory Rooms ----------------
/**
 * room = {
 *   code,
 *   roundActive: boolean,
 *   roundNumber: number,
 *   queue: [socketId, ...],
 *   players: { [socketId]: { name, score, dqNextRound, dqThisRound } },
 *   hostSockets: Set<string>,
 *   lastBuzzAt: { [socketId]: timestampMs },
 *   config: { pointsPerPart: number }
 * }
 */
const rooms = new Map(); // code -> room

function createRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // exclude 1,0,O,I
  let code = '';
  for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

function getOrCreateRoom(code) {
  if (!code) code = createRoomCode();
  if (!rooms.has(code)) {
    rooms.set(code, {
      code,
      roundActive: false,
      roundNumber: 0,
      queue: [],
      players: {},
      hostSockets: new Set(),
      lastBuzzAt: {},
      config: { pointsPerPart: 5 },
    });
  }
  return rooms.get(code);
}

function emitState(room) {
  const state = {
    roomCode: room.code,
    roundActive: room.roundActive,
    roundNumber: room.roundNumber,
    queue: room.queue.map(sid => ({ id: sid, name: room.players[sid]?.name || 'Unknown' })),
    leaderboard: Object.entries(room.players).map(([id, p]) => ({
      id, name: p.name, score: p.score || 0,
    })),
    config: { pointsPerPart: room.config.pointsPerPart },
  };
  io.to(room.code).emit('state:sync', state);
}

function emitPlayerStatus(room, socketId) {
  const p = room.players[socketId];
  if (!p) return;
  io.to(socketId).emit('player:status', { dqThisRound: !!p.dqThisRound });
}

function headOfQueue(room) {
  return room.queue[0] || null;
}

// ---------------- Socket.IO ----------------
io.on('connection', (socket) => {
  socket.data.roomCode = null;
  socket.data.isHost = false;

  // ---- Host events ----
  socket.on('host:createRoom', () => {
    const room = getOrCreateRoom(null);
    room.hostSockets.add(socket.id);
    socket.join(room.code);
    socket.data.roomCode = room.code;
    socket.data.isHost = true;
    socket.emit('host:roomCreated', { roomCode: room.code });
    emitState(room);
  });

  socket.on('host:joinRoom', ({ roomCode }) => {
    const room = getOrCreateRoom(roomCode);
    room.hostSockets.add(socket.id);
    socket.join(room.code);
    socket.data.roomCode = room.code;
    socket.data.isHost = true;
    socket.emit('host:roomCreated', { roomCode: room.code });
    emitState(room);
  });

  socket.on('host:startRound', ({ roomCode }) => {
    const room = rooms.get(roomCode);
    if (!room) return;

    room.roundActive = true;
    room.roundNumber += 1;
    room.queue = [];
    room.lastBuzzAt = {};

    // Current behavior: DQ persists across rounds (dqNextRound stays set).
    Object.values(room.players).forEach(p => {
      p.dqThisRound = !!p.dqNextRound;
      p.dqNextRound = !!p.dqNextRound;
    });

    Object.keys(room.players).forEach(sid => emitPlayerStatus(room, sid));
    io.to(room.code).emit('round:start', { roomCode, roundNumber: room.roundNumber });
    emitState(room);
  });

  socket.on('host:endRound', ({ roomCode }) => {
    const room = rooms.get(roomCode);
    if (!room) return;

    room.roundActive = false;
    room.queue = [];
    Object.values(room.players).forEach(p => { p.dqThisRound = false; });
    Object.keys(room.players).forEach(sid => emitPlayerStatus(room, sid));

    io.to(room.code).emit('round:end', { roomCode, roundNumber: room.roundNumber });
    emitState(room);
  });

  socket.on('host:actionPartCorrect', ({ roomCode }) => {
    const room = rooms.get(roomCode);
    if (!room || !room.roundActive) return;

    const sid = headOfQueue(room);
    if (!sid) return;
    const p = room.players[sid];
    if (!p) return;

    p.score = (p.score || 0) + (room.config.pointsPerPart || 5);
    emitState(room);
  });

  socket.on('host:actionFullCorrect', ({ roomCode }) => {
    const room = rooms.get(roomCode);
    if (!room || !room.roundActive) return;

    const sid = headOfQueue(room);
    if (!sid) return;
    const p = room.players[sid];
    if (!p) return;

    p.score = (p.score || 0) + 2 * (room.config.pointsPerPart || 5);
    room.queue.shift();
    emitState(room);
  });

  socket.on('host:actionNext', ({ roomCode }) => {
    const room = rooms.get(roomCode);
    if (!room || !room.roundActive) return;
    room.queue.shift();
    emitState(room);
  });

  socket.on('host:actionDQNextRound', ({ roomCode }) => {
    const room = rooms.get(roomCode);
    if (!room || !room.roundActive) return;

    const sid = headOfQueue(room);
    if (!sid) return;
    const p = room.players[sid];
    if (!p) return;

    p.dqNextRound = true;
    room.queue.shift();
    io.to(sid).emit('toast:warning', { message: 'DQ applied for next round.' });
    emitState(room);
  });

  socket.on('config:update', ({ roomCode, pointsPerPart }) => {
    const room = rooms.get(roomCode);
    if (!room) return;
    const value = Number(pointsPerPart) || 5;
    room.config.pointsPerPart = Math.max(1, Math.floor(value));
    io.to(room.code).emit('config:sync', {
      roomCode,
      config: { pointsPerPart: room.config.pointsPerPart },
    });
    emitState(room);
  });

  // ---- Player events ----
  socket.on('player:joinRoom', ({ roomCode, playerName }) => {
    const room = getOrCreateRoom(roomCode);
    socket.join(room.code);
    socket.data.roomCode = room.code;
    socket.data.isHost = false;

    room.players[socket.id] = room.players[socket.id] || {
      name: (playerName || 'Player').trim().slice(0, 24),
      score: 0,
      dqNextRound: false,
      dqThisRound: false,
    };

    emitPlayerStatus(room, socket.id);
    io.to(room.code).emit('toast:info', { message: `${room.players[socket.id].name} joined.` });
    emitState(room);
  });

  socket.on('player:buzz', ({ roomCode }) => {
    const room = rooms.get(roomCode);
    if (!room || !room.roundActive) return;

    const now = Date.now();
    const p = room.players[socket.id];
    if (!p) return;

    if (p.dqThisRound) {
      io.to(socket.id).emit('toast:error', { message: 'DQ this round — cannot buzz.' });
      return;
    }

    const last = room.lastBuzzAt[socket.id] || 0;
    const cd = 300; // ms cooldown
    const remaining = last + cd - now;
    if (remaining > 0) {
      io.to(socket.id).emit('player:cooldown', { msRemaining: remaining });
      return;
    }

    room.lastBuzzAt[socket.id] = now;
    if (!room.queue.includes(socket.id)) {
      room.queue.push(socket.id);
      emitState(room);
    }
  });

  socket.on('disconnect', () => {
    const roomCode = socket.data.roomCode;
    if (!roomCode) return;
    const room = rooms.get(roomCode);
