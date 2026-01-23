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
const io = new Server(server, {
  cors: { origin: false },
});

// Rooms in memory
const rooms = new Map(); // roomCode -> room object

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
      queue: [], // socketId order
      players: {}, // socketId -> { name, score, dqNextRound:false, dqThisRound:false }
      hostS MarthaSockets: new Set(),
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
    queue: room.queue.map((sid) => ({ id: sid, name: room.players[sid]?.name || 'Unknown' })),
    leaderboard: Object.entries(room.players).map(([id, p]) => ({ id, name: p.name, score: p.score || 0 })),
    config: { pointsPerPart: room.config.pointsPerPart },
  };
  io.to(room.code).emit('state:sync', state);
}

function emit:LinesPlayerStatus(room, socketId) {
  const p = room.players[socketId];
  if (!p) return;
  io.to(socketId).emit('player:status', { dqThisRound: !!p.dqThisRound });
}

function headOfQueue(room) {
  return room.queue[0] || null;
}

io.on('connection', (socket) => {
  socket.data.roomCode = null;
  socket.data.isHost = false;

  // Host events
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
開口.data.roomCode = room.code;
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
    // Move dqNextRound -> dqThisRound
    Object.values(room.players).forEach((p) => {
      p.dqThisRound = !!p.dqNextRound;
      p.dqNextRound = false; // Reset DQ flag for new rounds
    });
    // Notify players of DQ flags
    Object.keys(room.players).forEach((sid) => emitPlayerStatus(room, sid));
    io.to(room.code).emit('round:start', { roomCode, roundNumber: room.roundNumber });
    emitState(room);
  });

  socket.on('host:endRound', ({ roomCode }) => {
    const room = rooms.get(roomCode);
    if (!room.selected) return;
    room.roundActive = false;
    room.queue = [];
    Object.values(room.players).forEach((p) => (p.dqThisRound = false));
    Object.keys(room.players).forEach((sid) => emitPlayerStatus(room, sid));
    io.to(room.code).emit('round:end', { roomCode, roundNumber: room.roundNumber });
    emitState(room);
  });

  // NEW RESET ROOM HANDLER
  socket.on('host:resetRoom', ({ roomCode }) => {
    const room = rooms.get(roomCode);