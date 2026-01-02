
"use strict";

/**
 * Buzzer App — server.js (Render-ready)
 * ---------------------------------------------------------
 * - Node + Express static server for /public
 * - Socket.IO real-time for host & players
 * - In-memory rooms, no persistence (fresh start on reboot)
 * - Listens on process.env.PORT (required by Render)
 *
 * Event Contract (from handover):
 * Host → Server:
 *   host:createRoom
 *   host:joinRoom { roomCode }
 *   host:startRound { roomCode }
 *   host:endRound { roomCode }
 *   host:actionPartCorrect { roomCode }
 *   host:actionFullCorrect { roomCode }
 *   host:actionNext { roomCode }
 *   host:actionDQNextRound { roomCode }
 *   config:update { roomCode, pointsPerPart }
 *
 * Player → Server:
 *   player:joinRoom { roomCode, playerName }
 *   player:buzz { roomCode }
 *
 * Server → All in room (hosts & players unless specified):
 *   host:roomCreated { roomCode } (to the host that created)
 *   state:sync {
 *      roomCode, roundActive, roundNumber,
 *      queue: [{ id, name }],
 *      leaderboard: [{ id, name, score }],
 *      config: { pointsPerPart }
 *   }
 *   round:start { roomCode, roundNumber }
 *   round:end { roomCode, roundNumber }
 *   config:sync { roomCode, config: { pointsPerPart } }
 *   player:cooldown { msRemaining } (to a specific player)
 *   toast:info|toast:warning|toast:error { message }
 */

const path = require("path");
const express = require("express");
const app = express();

// Serve static files from /public
app.use(express.static(path.join(__dirname, "public")));

const http = require("http");
const httpServer = http.createServer(app);

// Socket.IO (CORS relaxed; on Render same-origin is typical, but this is safe)
const { Server } = require("socket.io");
const io = new Server(httpServer, {
  cors: { origin: "*", methods: ["GET", "POST"] }
});

// ----------------------------------------------------------------------------
// In‑memory store (per room)
// ----------------------------------------------------------------------------
/**
 * rooms: Map<roomCode, {
 *   code: string
 *   roundActive: boolean
 *   roundNumber: number
 *   queue: string[]                 // socketIds, order = buzz order
 *   players: { [socketId]: {
 *       name: string,
 *       score: number,
 *       dqNextRound: boolean,
 *       dqThisRound: boolean
 *   }}
 *   hostSockets: Set<string>
 *   lastBuzzAt: { [socketId]: number }  // ms timestamps (server cooldown)
 *   config: { pointsPerPart: number }   // default 5
 * }>
 */
const rooms = new Map();

// constants
const CODE_LEN = 6;
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // A–Z, 2–9 (skip 0/1/I/O)
const SERVER_COOLDOWN_MS = 300;
const MAX_POINTS = 100;
const DEFAULT_POINTS_PER_PART = 5;

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------
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
  const s = String(name || "").trim();
  return s.slice(0, 32) || "Player";
}

function toPublicQueue(room) {
  return room.queue
    .filter((id) => room.players[id])
    .map((id) => ({ id, name: room.players[id].name }));
}

function toLeaderboard(room) {
  // sort by score desc, then name asc
  return Object.entries(room.players)
    .map(([id, p]) => ({ id, name: p.name, score: p.score || 0 }))
    .sort((a, b) => (b.score - a.score) || a.name.localeCompare(b.name));
}

function broadcastState(room) {
  const payload = {
    roomCode: room.code,
    roundActive: room.roundActive,
    roundNumber: room.roundNumber,
    queue: toPublicQueue(room),
    leaderboard: toLeaderboard(room),
    config: { pointsPerPart: room.config.pointsPerPart }
  };
  io.to(room.code).emit("state:sync", payload);
}

function toast(socketOrRoom, level, message) {
  const event = level === "error" ? "toast:error"
    : level === "warning" ? "toast:warning"
    : "toast:info";
  if (typeof socketOrRoom === "string") {
    io.to(socketOrRoom).emit(event, { message });
  } else if (socketOrRoom && socketOrRoom.emit) {
    socketOrRoom.emit(event, { message });
  }
}

function popFirst(room) {
  const firstId = room.queue.shift();
  return firstId || null;
}

function removeFromQueue(room, socketId) {
  const idx = room.queue.indexOf(socketId);
  if (idx >= 0) room.queue.splice(idx, 1);
}

// ----------------------------------------------------------------------------
// Round lifecycle
// ----------------------------------------------------------------------------
function startRound(room) {
  room.roundActive = true;
  room.roundNumber += 1;
  room.queue = [];

  // apply DQ flags: dqNextRound -> dqThisRound, then clear dqNextRound
  for (const [id, p] of Object.entries(room.players)) {
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
  for (const [_, p] of Object.entries(room.players)) {
    p.dqThisRound = false;
  }
  io.to(room.code).emit("round:end", {
    roomCode: room.code,
    roundNumber: room.roundNumber
  });
  broadcastState(room);
}

// ----------------------------------------------------------------------------
// Socket.IO wiring
// ----------------------------------------------------------------------------
io.on("connection", (socket) => {
  // Track which room this socket joined (for cleanup)
  let joinedRoom = null;
  let isHost = false;

  // ----------------------------- HOST EVENTS ------------------------------
  socket.on("host:createRoom", () => {
    // create a unique room code
    let code;
    do { code = generateRoomCode(); } while (rooms.has(code));
    const room = ensureRoom(code);

    // mark this socket as a host of that room
    room.hostSockets.add(socket.id);
    joinedRoom = code;
    isHost = true;
    socket.join(code);

    socket.emit("host:roomCreated", { roomCode: code });
    toast(socket, "info", `Room ${code} created.`);
    broadcastState(room);
  });

  socket.on("host:joinRoom", ({ roomCode }) => {
    const code = String(roomCode || "").trim().toUpperCase();
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
    const room = rooms.get(String(roomCode || "").toUpperCase());
    if (!room) return;
    startRound(room);
  });

  socket.on("host:endRound", ({ roomCode }) => {
    const room = rooms.get(String(roomCode || "").toUpperCase());
    if (!room) return;
    endRound(room);
  });

  socket.on("host:actionPartCorrect", ({ roomCode }) => {
    const room = rooms.get(String(roomCode || "").toUpperCase());
    if (!room) return;
    if (!room.queue.length) return;

    const firstId = room.queue[0];
    const p = room.players[firstId];
    if (p) {
      p.score = (p.score || 0) + (room.config.pointsPerPart || DEFAULT_POINTS_PER_PART);
    }
    // player remains at front
    broadcastState(room);
  });

  socket.on("host:actionFullCorrect", ({ roomCode }) => {
    const room = rooms.get(String(roomCode || "").toUpperCase());
    if (!room) return;
    if (!room.queue.length) return;

    const firstId = popFirst(room);
    const p = room.players[firstId];
    if (p) {
      const inc = (room.config.pointsPerPart || DEFAULT_POINTS_PER_PART) * 2;
      p.score = (p.score || 0) + inc;
    }
    broadcastState(room);
  });

  socket.on("host:actionNext", ({ roomCode }) => {
    const room = rooms.get(String(roomCode || "").toUpperCase());
    if (!room) return;
    if (!room.queue.length) return;
    popFirst(room); // no score change
    broadcastState(room);
  });

  socket.on("host:actionDQNextRound", ({ roomCode }) => {
    const room = rooms.get(String(roomCode || "").toUpperCase());
    if (!room) return;
    if (!room.queue.length) return;

    const firstId = popFirst(room);
    const p = room.players[firstId];
    if (p) p.dqNextRound = true;
    broadcastState(room);
  });

  socket.on("config:update", ({ roomCode, pointsPerPart }) => {
    const room = rooms.get(String(roomCode || "").toUpperCase());
    if (!room) return;

    const val = Number(pointsPerPart);
    if (Number.isFinite(val) && val >= 0 && val <= MAX_POINTS) {
