
"use strict";
/**
 * Buzzer App — server.js (Render-ready, CommonJS)
 * - Express serves /public (host.html, player.html, JS, CSS)
 * - Socket.IO implements host/player event contract
 * - In-memory rooms (no persistence; fresh on restart)
 * - Listens on process.env.PORT (fallback 3000)
 */

const path = require("path");
const express = require("express");
const app = express();

// Serve static files from /public
app.use(express.static(path.join(__dirname, "public")));

// Simple health check (optional: set Health Check Path=/healthz in Render)
app.get("/healthz", (_req, res) => res.status(200).json({ ok: true }));

const http = require("http");
const httpServer = http.createServer(app);

// Socket.IO on the same HTTP server/port (single public port)
const { Server } = require("socket.io");
const io = new Server(httpServer, {
  cors: { origin: "*", methods: ["GET", "POST"] }
});

// ─────────── Data model ───────────
/**
 * rooms: Map<roomCode, {
 *   code: string,
 *   roundActive: boolean,
 *   roundNumber: number,
 *   queue: string[],       // socketIds in buzz order
 *   players: { [socketId]: { name, score, dqNextRound, dqThisRound } },
 *   hostSockets: Set<string>,
 *   lastBuzzAt: { [socketId]: number }, // ms timestamps for server cooldown
 *   config: { pointsPerPart: number }   // default 5
 * }>
 */
const rooms = new Map();

const CODE_LEN = 6;
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // skip 0/1/I/O
const SERVER_COOLDOWN_MS = 300;
const DEFAULT_POINTS_PER_PART = 5;
const MAX_POINTS = 100;

// ─────────── Helpers ───────────
function generateRoomCode() {
  let code = "";
  for (let i = 0; i < CODE_LEN; i++) {
    code += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
  }
  return code;
}

function ensureRoom(roomCode) {
  let room = rooms.get(roomCode);
  if (!room) {
    room = {
      code: roomCode,
      roundActive: false,
      roundNumber: 0,
      queue: [],
      players: {},
      hostSockets: new Set(),
      lastBuzzAt: {},
      config: { pointsPerPart: DEFAULT_POINTS_PER_PART }
    };
    rooms.set(roomCode, room);
  }
  return room;
}

function sanitizeName(name) {
  const s = String(name ?? "").trim();
  return s.slice(0, 32) || "Player";
}

function toPublicQueue(room) {
  return room.queue
    .filter(id => room.players[id])
    .map(id => ({ id, name: room.players[id].name }));
}

function toLeaderboard(room) {
  return Object.entries(room.players)
    .map(([id, p]) => ({ id, name: p.name, score: p.score ?? 0 }))
    .sort((a, b) => (b.score - a.score) || a.name.localeCompare(b.name));
}

function broadcastState(room) {
  io.to(room.code).emit("state:sync", {
    roomCode: room.code,
    roundActive: room.roundActive,
    roundNumber: room.roundNumber,
    queue: toPublicQueue(room),
    leaderboard: toLeaderboard(room),
    config: { pointsPerPart: room.config.pointsPerPart }
  });
}

function toast(target, level, message) {
  const evt =
    level === "error" ? "toast:error" :
    level === "warning" ? "toast:warning" :
    "toast:info";
  if (typeof target === "string") {
    io.to(target).emit(evt, { message });
  } else if (target && target.emit) {
    target.emit(evt, { message });
  }
}

function popFirst(room) {
  const first = room.queue.shift();
  return first ?? null;
}

function removeFromQueue(room, id) {
  const idx = room.queue.indexOf(id);
  if (idx >= 0) room.queue.splice(idx, 1);
}

// ─────────── Round lifecycle ───────────
function startRound(room) {
  room.roundActive = true;
  room.roundNumber += 1;
  room.queue = [];
  // dqNextRound → dqThisRound; clear dqNextRound
  for (const [, p] of Object.entries(room.players)) {
    p.dqThisRound = !!p.dqNextRound;
    p.dqNextRound = false;
  }
  room.lastBuzzAt = {};
  io.to(room.code).emit("round:start", {
    roomCode: room.code,
    roundNumber: room.roundNumber
  });
  broadcastState(room);
}

function endRound(room) {
  room.roundActive = false;
  room.queue = [];
  for (const [, p] of Object.entries(room.players)) {
    p.dqThisRound = false;
  }
  io.to(room.code).emit("round:end", {
    roomCode: room.code,
    roundNumber: room.roundNumber
  });
  broadcastState(room);
}

// ─────────── Socket.IO wiring ───────────
io.on("connection", (socket) => {
  let joinedRoom = null;
  let isHost = false;

  // Host events
  socket.on("host:createRoom", () => {
    let code;
    do { code = generateRoomCode(); } while (rooms.has(code));
    const room = ensureRoom(code);
    room.hostSockets.add(socket.id);
    joinedRoom = code;
    isHost = true;
    socket.join(code);
    socket.emit("host:roomCreated", { roomCode: code });
    toast(socket, "info", `Room ${code} created.`);
    broadcastState(room);
  });

  socket.on("host:joinRoom", ({ roomCode }) => {
    const code = String(roomCode ?? "").trim().toUpperCase();
    if (!rooms.has(code)) {
      toast(socket, "error", `Room ${code} does not exist.`);
      return;
    }
    const room = ensureRoom(code);
    room.hostSockets.add(socket.id);
    if (joinedRoom && joinedRoom !== code) socket.leave(joinedRoom);
    joinedRoom = code;
    isHost = true;
    socket.join(code);
    toast(socket, "info", `Joined Host for room ${code}.`);
    broadcastState(room);
  });

  socket.on("host:startRound", ({ roomCode }) => {
    const room = rooms.get(String(roomCode ?? "").toUpperCase());
    if (!room) return;
    startRound(room);
  });

  socket.on("host:endRound", ({ roomCode }) => {
    const room = rooms.get(String(roomCode ?? "").toUpperCase());
    if (!room) return;
    endRound(room);
  });

  socket.on("host:actionPartCorrect", ({ roomCode }) => {
    const room = rooms.get(String(roomCode ?? "").toUpperCase());
    if (!room || !room.queue.length) return;
    const firstId = room.queue[0];
    const p = room.players[firstId];
    if (p) {
      const inc = room.config.pointsPerPart ?? DEFAULT_POINTS_PER_PART;
      p.score = (p.score ?? 0) + inc;
    }
    broadcastState(room); // stays at front for part 2
  });

  socket.on("host:actionFullCorrect", ({ roomCode }) => {
    const room = rooms.get(String(roomCode ?? "").toUpperCase());
    if (!room || !room.queue.length) return;
    const firstId = popFirst(room);
    const p = room.players[firstId];
    if (p) {
      const inc = (room.config.pointsPerPart ?? DEFAULT_POINTS_PER_PART) * 2;
      p.score = (p.score ?? 0) + inc;
    }
    broadcastState(room);
  });

  socket.on("host:actionNext", ({ roomCode }) => {
    const room = rooms.get(String(roomCode ?? "").toUpperCase());
    if (!room || !room.queue.length) return;
    popFirst(room); // no score change
    broadcastState(room);
  });

  socket.on("host:actionDQNextRound", ({ roomCode }) => {
    const room = rooms.get(String(roomCode ?? "").toUpperCase());
    if (!room || !room.queue.length) return;
    const firstId = popFirst(room);
    const p = room.players[firstId];
    if (p) p.dqNextRound = true;
    broadcastState(room);
  });

  socket.on("config:update", ({ roomCode, pointsPerPart }) => {
    const room = rooms.get(String(roomCode ?? "").toUpperCase());
    if (!room) return;
    const val = Number(pointsPerPart);
    if (Number.isFinite(val) && val >= 0 && val <= MAX_POINTS) {
      room.config.pointsPerPart = Math.round(val);
      io.to(room.code).emit("config:sync", {
        roomCode: room.code,
        config: { pointsPerPart: room.config.pointsPerPart }
      });
      toast(room.code, "info", `Points per part: ${room.config.pointsPerPart}`);
      broadcastState(room);
    } else {
      toast(socket, "warning", "pointsPerPart must be between 0 and 100.");
    }
  });

  // Player events
  socket.on("player:joinRoom", ({ roomCode, playerName }) => {
    const code = String(roomCode ?? "").trim().toUpperCase();
    if (!rooms.has(code)) {
      toast(socket, "error", `Room ${code} does not exist.`);
      return;
    }
    const room = ensureRoom(code);
    const name = sanitizeName(playerName);
    if (joinedRoom && joinedRoom !== code) socket.leave(joinedRoom);
    joinedRoom = code;
    isHost = false;
    socket.join(code);

    room.players[socket.id] = room.players[socket.id] ?? {
      name, score: 0, dqNextRound: false, dqThisRound: false
    };
    room.players[socket.id].name = name;

    toast(socket, "info", `Joined room ${code} as ${name}`);
    broadcastState(room);
  });

  socket.on("player:buzz", ({ roomCode }) => {
    const code = String(roomCode ?? "").trim().toUpperCase();
    const room = rooms.get(code);
    if (!room) return;
    if (!room.players[socket.id]) return;   // must be a known player
    if (!room.roundActive) return;          // round must be active

    const p = room.players[socket.id];
    if (p?.dqThisRound) return;             // disabled for this round

    // Server-side cooldown
    const now = Date.now();
    const last = room.lastBuzzAt[socket.id] ?? 0;
    const delta = now - last;
    if (delta < SERVER_COOLDOWN_MS) {
      socket.emit("player:cooldown", { msRemaining: SERVER_COOLDOWN_MS - delta });
      return;
    }

    // Only one entry per player in queue
    if (!room.queue.includes(socket.id)) {
      room.queue.push(socket.id);
      room.lastBuzzAt[socket.id] = now;
      broadcastState(room);
    }
  });

  // Disconnect
  socket.on("disconnect", () => {
    if (joinedRoom && rooms.has(joinedRoom)) {
      const room = rooms.get(joinedRoom);
      if (isHost) room.hostSockets.delete(socket.id);

      removeFromQueue(room, socket.id);
      if (room.players[socket.id]) {
        delete room.players[socket.id];
      }

      const playersCount = Object.keys(room.players).length;
      if (playersCount === 0 && room.hostSockets.size === 0) {
        rooms.delete(joinedRoom);
      } else {
        broadcastState(room);
      }
    }
  });
});

// Start server (Render injects PORT; fallback 3000 for local)
const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
``
