
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

// -------------------------------
// In-memory rooms
// -------------------------------
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
      queue: [],                              // socketId order
      players: {},                            // socketId -> { name, score, dqNextRound, dqThisRound }
      hostSockets: new Set(),                 // <— fixed name
      lastBuzzAt: {},                         // per-player cooldown timestamps
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

function emitPlayerStatus(room, socketId) {
  const p = room.players[socketId];
  if (!p) return;
  io.to(socketId).emit('player:status', { dqThisRound: !!p.dqThisRound });
}

function headOfQueue(room) {
  return room.queue[0] || null;
}

// -------------------------------
// Socket handlers
// -------------------------------
io.on('connection', (socket) => {
  socket.data.roomCode = null;
  socket.data.isHost = false;

  // -------- Host events --------
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
    socket.data.roomCode = room.code;   // <— fixed garbled characters
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

    // Apply one-round DQ: dqNextRound -> dqThisRound, then clear dqNextRound
    Object.values(room.players).forEach((p) => {
      p.dqThisRound = !!p.dqNextRound;
      p.dqNextRound = false; // one-time penalty
    });

    // Notify each player of their DQ flag
    Object.keys(room.players).forEach((sid) => emitPlayerStatus(room, sid));

    io.to(room.code).emit('round:start', { roomCode, roundNumber: room.roundNumber });
    emitState(room);
  });

  socket.on('host:endRound', ({ roomCode }) => {
    const room = rooms.get(roomCode);
    if (!room) return;                 // <— fixed .selected bug
    room.roundActive = false;
    room.queue = [];
    Object.values(room.players).forEach((p) => (p.dqThisRound = false));
    Object.keys(room.players).forEach((sid) => emitPlayerStatus(room, sid));
    io.to(room.code).emit('round:end', { roomCode, roundNumber: room.roundNumber });
    emitState(room);
  });

  // --- New Game / Reset room (full reset) ---
  // Preferred event:
  socket.on('host:newGame', ({ roomCode }) => {
    const room = rooms.get(roomCode);
    if (!room) return;

    room.roundActive = false;
    room.roundNumber = 0;   // reset round counter to 0
    room.queue = [];
    room.lastBuzzAt = {};
    Object.values(room.players).forEach((p) => {
      p.score = 0;
      p.dqNextRound = false;
      p.dqThisRound = false;
    });
    // Config: preserve current pointsPerPart (safer). Change next line to reset if desired.
    // room.config.pointsPerPart = 5;

    io.to(room.code).emit('toast:info', { message: 'New game created. Scores and queue reset.' });
    emitState(room);
  });

  // Backward-compatible alias if earlier code used 'host:resetRoom'
  socket.on('host:resetRoom', (payload) => {
    socket.emit('toast:warning', { message: 'host:resetRoom is deprecated; using host:newGame.' });
    io.emit('toast:warning', { message: 'Room reset requested by host.' });
    io.emit('noop'); // harmless event to flush ordering
    socket.emit('host:newGame', payload);
  });

  // Scoring actions
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
    io.to(room.code).emit('config:sync', { roomCode, config: { pointsPerPart: room.config.pointsPerPart } });
    emitState(room);
  });

  // -------- Player events --------
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
    const cd = 300;
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
    if (!room) return;

    room.hostSockets.delete(socket.id);
    delete room.players[socket.id];
    room.queue = room.queue.filter((sid) => sid !== socket.id);
    emitState(room);
  });
});

// -------------------------------
const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;
server.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
