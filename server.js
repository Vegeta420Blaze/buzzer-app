
// server.js
const path = require('path');
const os = require('os');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Serve static files
app.use(express.static(path.join(__dirname, 'public')));

// --- Rooms in memory ---
/*
room = {
  code: 'ABC123',
  roundActive: false,
  roundNumber: 0,
  queue: [],                 // array of socketIds in buzz order
  players: {
    socketId: { name, score, dqNextRound: false, dqThisRound: false }
  },
  hostSockets: new Set(),
  lastBuzzAt: { socketId: timestampMs },
  config: { pointsPerPart: 5 }
}
*/
const rooms = Object.create(null);

// --- LAN IP detection ---
function getLanIPv4() {
  const ifaces = os.networkInterfaces();
  for (const [name, addrs] of Object.entries(ifaces)) {
    for (const a of addrs || []) {
      // Prefer private IPv4 addresses
      if (a.family === 'IPv4' && !a.internal) {
        // Typical private ranges: 10.x.x.x, 172.16-31.x.x, 192.168.x.x
        const ip = a.address;
        if (
          ip.startsWith('10.') ||
          ip.startsWith('192.168.') ||
          (ip.startsWith('172.') && (() => {
            const secondOctet = Number(ip.split('.')[1]);
            return secondOctet >= 16 && secondOctet <= 31;
          })())
        ) {
          return ip;
        }
      }
    }
  }
  // Fallback: first non-internal IPv4 or localhost
  for (const addrs of Object.values(ifaces)) {
    for (const a of addrs || []) {
      if (a.family === 'IPv4' && !a.internal) return a.address;
    }
  }
  return '127.0.0.1';
}
const LAN_IP = getLanIPv4();

// --- Helpers ---
function generateRoomCode() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}
function getRoom(code) {
  if (!code) return null;
  const c = String(code).toUpperCase();
  return rooms[c] || null;
}
function ensureRoomConfig(room) {
  if (!room.config) room.config = { pointsPerPart: 5 };
  if (typeof room.config.pointsPerPart !== 'number') room.config.pointsPerPart = 5;
}
function validatePointsPerPart(val) {
  const n = Number(val);
  if (!Number.isFinite(n) || n < 0 || n > 100) return null;
  return Math.trunc(n);
}
function broadcastState(roomCode) {
  const room = getRoom(roomCode);
  if (!room) return;
  const state = {
    roomCode: room.code,
    roundActive: room.roundActive,
    roundNumber: room.roundNumber,
    queue: room.queue.map(id => {
      const p = room.players[id];
      return p ? { id, name: p.name } : { id, name: 'Unknown' };
    }),
    leaderboard: Object.entries(room.players)
      .map(([id, p]) => ({ id, name: p.name, score: p.score }))
      .sort((a, b) => b.score - a.score),
    config: { pointsPerPart: room.config.pointsPerPart }
  };
  io.to(`host:${room.code}`).emit('state:sync', state);
  io.to(`players:${room.code}`).emit('state:sync', state);
}

// --- Socket.IO ---
io.on('connection', (socket) => {
  // Provide LAN info to every connected client (host will use it)
  socket.emit('server:lanInfo', { lanIp: LAN_IP, port: (process.env.PORT || 3000) });

  // Host creates a room
  socket.on('host:createRoom', () => {
    const code = generateRoomCode();
    rooms[code] = {
      code,
      roundActive: false,
      roundNumber: 0,
      queue: [],
      players: {},
      hostSockets: new Set(),
      lastBuzzAt: {},
      config: { pointsPerPart: 5 }
    };
    socket.join(`host:${code}`);
    rooms[code].hostSockets.add(socket.id);

    socket.emit('host:roomCreated', { roomCode: code });
    console.log(`[HOST] createRoom ${code}`);
    broadcastState(code);
  });

  // Host joins an existing room
  socket.on('host:joinRoom', ({ roomCode }) => {
    const room = getRoom(roomCode);
    if (!room) {
      socket.emit('toast:error', { message: 'Room not found.' });
      return;
    }
    socket.join(`host:${room.code}`);
    room.hostSockets.add(socket.id);
    console.log(`[HOST] joinRoom ${room.code} ${socket.id}`);
    broadcastState(room.code);
  });

  // Player joins room
  socket.on('player:joinRoom', ({ roomCode, playerName }) => {
    const room = getRoom(roomCode);
    if (!room) {
      socket.emit('toast:error', { message: 'Room not found.' });
      return;
    }
    const name = String(playerName || '').trim();
    if (!name) {
      socket.emit('toast:error', { message: 'Please enter a name.' });
      return;
    }
    socket.join(`players:${room.code}`);
    room.players[socket.id] = room.players[socket.id] || {
      name,
      score: 0,
      dqNextRound: false,
      dqThisRound: false
    };
    room.players[socket.id].name = name;

    console.log(`[PLAYER] joinRoom ${room.code} ${name} ${socket.id}`);
    socket.emit('player:joined', { roomCode: room.code, name });
    broadcastState(room.code);
  });

  // Round controls
  socket.on('host:startRound', ({ roomCode }) => {
    const room = getRoom(roomCode);
    if (!room) return;
    room.roundActive = true;
    room.roundNumber += 1;
    room.queue = [];

    // Apply DQ flags for THIS round: move dqNextRound -> dqThisRound
    for (const pid of Object.keys(room.players)) {
      const p = room.players[pid];
      if (p.dqNextRound) {
        p.dqThisRound = true;
        p.dqNextRound = false;
      } else {
        p.dqThisRound = false;
      }
    }

    // Reset cooldown map at round start
    room.lastBuzzAt = {};

    console.log(`[HOST] startRound ${room.code}`);
    broadcastState(room.code);
    io.to(`players:${room.code}`).emit('round:start', { roomCode: room.code, roundNumber: room.roundNumber });
  });

  socket.on('host:endRound', ({ roomCode }) => {
    const room = getRoom(roomCode);
    if (!room) return;
    room.roundActive = false;
    room.queue = [];

    // Clear dqThisRound flags
    for (const pid of Object.keys(room.players)) {
      const p = room.players[pid];
      if (p.dqThisRound) p.dqThisRound = false;
    }

    console.log(`[HOST] endRound ${room.code}`);
    broadcastState(room.code);
    io.to(`players:${room.code}`).emit('round:end', { roomCode: room.code, roundNumber: room.roundNumber });
  });

  // Player buzz with 300 ms cooldown
  socket.on('player:buzz', ({ roomCode }) => {
    const room = getRoom(roomCode);
    if (!room) return;
    if (!room.roundActive) return;

    const player = room.players[socket.id];
    if (!player) return;

    // If DQ for this round, ignore
    if (player.dqThisRound) return;

    // Cooldown enforcement
    const now = Date.now();
    const last = room.lastBuzzAt[socket.id] || 0;
    if (now - last < 300) {
      socket.emit('player:cooldown', { msRemaining: Math.max(0, 300 - (now - last)) });
      return;
    }
    room.lastBuzzAt[socket.id] = now;

    // Prevent duplicates in queue
    if (!room.queue.includes(socket.id)) {
      room.queue.push(socket.id);
      console.log(`[PLAYER] buzz ${room.code} ${socket.id}`);
      broadcastState(room.code);
    }
  });

  // --- Scoring / Queue actions ---
  // +5, keep in queue (award one part)
  socket.on('host:actionPartCorrect', ({ roomCode }) => {
    const room = getRoom(roomCode);
    if (!room) return;
    ensureRoomConfig(room);
    const firstId = room.queue[0];
    if (!firstId) return;

    const player = room.players[firstId];
    if (!player) {
      room.queue.shift();
      broadcastState(room.code);
      return;
    }
    const add = Number(room.config.pointsPerPart) || 0;
    player.score += add;
    io.to(`players:${room.code}`).emit('toast:info', { message: `${player.name} +${add} (part)` });
    broadcastState(room.code);
  });

  // +10 (two parts), remove from queue
  socket.on('host:actionFullCorrect', ({ roomCode }) => {
    const room = getRoom(roomCode);
    if (!room) return;
    ensureRoomConfig(room);
    const firstId = room.queue[0];
    if (!firstId) return;

    const player = room.players[firstId];
    if (!player) {
      room.queue.shift();
      broadcastState(room.code);
      return;
    }
    const add = (Number(room.config.pointsPerPart) || 0) * 2;
    player.score += add;
    room.queue.shift();
    io.to(`players:${room.code}`).emit('toast:info', { message: `${player.name} +${add} (full)` });
    broadcastState(room.code);
  });

  // Next: remove from queue, no score
  socket.on('host:actionNext', ({ roomCode }) => {
    const room = getRoom(roomCode);
    if (!room) return;
    if (room.queue.length > 0) {
      const firstId = room.queue[0];
      const player = room.players[firstId];
      room.queue.shift();
      io.to(`players:${room.code}`).emit('toast:warning', { message: `${player ? player.name : 'Player'}: no score` });
      broadcastState(room.code);
    }
  });

  // DQ next round and pop queue
  socket.on('host:actionDQNextRound', ({ roomCode }) => {
    const room = getRoom(roomCode);
    if (!room) return;
    const firstId = room.queue[0];
    if (!firstId) return;

    const player = room.players[firstId];
    if (!player) {
      room.queue.shift();
      broadcastState(room.code);
      return;
    }
    player.dqNextRound = true;
    room.queue.shift();
    io.to(`players:${room.code}`).emit('toast:warning', { message: `${player.name} DQ next round` });
    broadcastState(room.code);
  });

  // Config update: points per part
  socket.on('config:update', ({ roomCode, pointsPerPart }) => {
    const room = getRoom(roomCode);
    if (!room) {
      socket.emit('toast:error', { message: 'Room not found for config update.' });
      return;
    }
    const p = validatePointsPerPart(pointsPerPart);
    if (p === null) {
      socket.emit('toast:error', { message: 'Points per part must be an integer between 0 and 100.' });
      return;
    }
    room.config.pointsPerPart = p;
    console.log(`[HOST] config:update ${room.code} pointsPerPart=${p}`);
    io.to(`host:${room.code}`).emit('config:sync', { roomCode: room.code, config: { pointsPerPart: p } });
    io.to(`players:${room.code}`).emit('config:sync', { roomCode: room.code, config: { pointsPerPart: p } });
    broadcastState(room.code);
  });

  // Disconnect cleanup
  socket.on('disconnect', () => {
    for (const code of Object.keys(rooms)) {
      const room = rooms[code];
      if (room.hostSockets.has(socket.id)) room.hostSockets.delete(socket.id);
      if (room.players[socket.id]) delete room.players[socket.id];
      const idx = room.queue.indexOf(socket.id);
      if (idx >= 0) room.queue.splice(idx, 1);

      if (room.hostSockets.size === 0 && Object.keys(room.players).length === 0) {
        delete rooms[code];
        console.log(`[SERVER] Deleted empty room ${code}`);
      } else {
        broadcastState(code);
      }
    }
  });
});

// Start server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Buzzer App server running on http://localhost:${PORT}`);
  console.log(`LAN IP detected: ${LAN_IP}:${PORT}`);
});
