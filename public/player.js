
/* Player page logic: join room, buzz, status indicator, public queue.
   Assumes Socket.IO server emits:
     - state:sync { roomCode, roundActive, roundNumber, queue: [{id,name}], leaderboard, config }
     - round:start { roomCode, roundNumber }
     - round:end   { roomCode, roundNumber }
     - player:cooldown { msRemaining }  (to specific player)
   And accepts:
     - player:joinRoom { roomCode, playerName }
     - player:buzz     { roomCode }
*/

// Socket
const socket = window.socket || io();

// DOM refs
const titleEl       = document.getElementById('title');
const roomCodeEl    = document.getElementById('room-code');
const playerNameEl  = document.getElementById('player-name');
const btnJoin       = document.getElementById('btn-join');
const joinStatusEl  = document.getElementById('join-status');

const btnBuzz       = document.getElementById('btn-buzz');
const buzzMsgEl     = document.getElementById('buzz-msg');

const buzzIcon      = document.getElementById('buzz-icon');
const buzzText      = document.getElementById('buzz-text');

const queueList     = document.getElementById('player-queue');

// Local state
let myId = null;
let joined = false;
let joinedRoomCode = '';
let myName = '';
let roundActive = false;

// Local cooldown (client-side UX) in ms
const LOCAL_COOLDOWN_MS = 300;
let localCooldownUntil = 0;

// Utilities
function setBuzzEnabled(enabled) {
  btnBuzz.disabled = !enabled;
  btnBuzz.classList.toggle('disabled', !enabled);
}

function showBuzzMessage(msg) {
  buzzMsgEl.textContent = msg || '';
}

function vibrate(ms) {
  try { if (navigator.vibrate) navigator.vibrate(ms); } catch (_) {}
}

function updateTitleWithName() {
  if (joined && myName) titleEl.textContent = myName;
  else titleEl.textContent = 'Player';
}

function uppercaseCode(s) {
  return (s || '').trim().toUpperCase();
}

// --- Socket basics ---
socket.on('connect', () => {
  myId = socket.id;
});

// --- Join flow ---
btnJoin?.addEventListener('click', () => {
  const code = uppercaseCode(roomCodeEl?.value);
  const name = (playerNameEl?.value || '').trim();

  if (!code || code.length !== 6) {
    joinStatusEl.textContent = 'Room code must be 6 characters.';
    window.toast?.warning?.('Room code must be 6 characters.');
    return;
  }
  if (!name) {
    joinStatusEl.textContent = 'Please enter a name.';
    window.toast?.warning?.('Please enter a name.');
    return;
  }

  joinedRoomCode = code;
  myName = name;

  socket.emit('player:joinRoom', { roomCode: joinedRoomCode, playerName: myName });
  joined = true;
  updateTitleWithName();
  joinStatusEl.textContent = `Joined room ${joinedRoomCode}.`;
  window.toast?.info?.(`Joined room ${joinedRoomCode} as ${myName}`);
});

// --- Buzz button ---
btnBuzz?.addEventListener('click', () => {
  // Local UX cooldown
  const now = Date.now();
  if (now < localCooldownUntil) {
    const remaining = localCooldownUntil - now;
    showBuzzMessage(`Cooldown… (${Math.ceil(remaining / 100)}0ms)`);
    return;
  }
  localCooldownUntil = now + LOCAL_COOLDOWN_MS;

  if (!roundActive) {
    showBuzzMessage('Round inactive');
    window.toast?.warning?.('Round inactive');
    return;
  }
  if (!joinedRoomCode) {
    showBuzzMessage('Join a room first');
    window.toast?.warning?.('Join a room first');
    return;
  }

  vibrate(20);
  socket.emit('player:buzz', { roomCode: joinedRoomCode });
  showBuzzMessage('Buzzed!');
});

// Server-side cooldown notice (per player)
socket.on('player:cooldown', (payload) => {
  const ms = payload?.msRemaining ?? 0;
  if (ms > 0) {
    showBuzzMessage(`Cooldown… (${ms}ms)`);
    vibrate(10);
    window.toast?.info?.('Server cooldown');
  }
});

// --- Round lifecycle ---
socket.on('round:start', () => {
  roundActive = true;
  setBuzzEnabled(true);
  updateBuzzStatus([], roundActive);
  showBuzzMessage('');
});

socket.on('round:end', () => {
  roundActive = false;
  setBuzzEnabled(false);
  clearQueue();
  updateBuzzStatus([], roundActive);
  showBuzzMessage('Round ended');
});

// --- State sync (queue + active flag) ---
socket.on('state:sync', (state) => {
  roundActive = !!state?.roundActive;
  setBuzzEnabled(roundActive);

  const queue = Array.isArray(state?.queue) ? state.queue : [];
  renderQueue(queue);
  updateBuzzStatus(queue, roundActive);
});

// --- Render queue for players (read-only) ---
function renderQueue(queue) {
  if (!queueList) return;
  queueList.innerHTML = '';

  queue.forEach((entry, idx) => {
    const li = document.createElement('li');
    li.className = 'queue-item ' + (idx === 0 ? 'first' : 'waiting');
    // IMPORTANT: <ol> auto-numbers, so do NOT prefix with `${idx + 1}. `
    li.textContent = entry.name;
    queueList.appendChild(li);
  });
}

function clearQueue() {
  if (queueList) queueList.innerHTML = '';
}

// --- First/queued/idle indicator ---
function updateBuzzStatus(queue, isActive) {
  if (!buzzIcon || !buzzText) return;

  const myPos = queue.findIndex((e) => e.id === myId);

  buzzIcon.classList.remove('first', 'queued', 'idle', 'inactive');
  if (!isActive) {
    buzzIcon.classList.add('inactive');
    buzzText.textContent = 'Round inactive';
    return;
  }

  if (myPos === 0) {
    buzzIcon.classList.add('first');
    buzzText.textContent = 'You are FIRST';
  } else if (myPos > 0) {
    buzzIcon.classList.add('queued');
    buzzText.textContent = `You are queued (position ${myPos + 1})`;
  } else {
    buzzIcon.classList.add('idle');
    buzzText.textContent = 'Not buzzed';
  }
}

// Initial UI
document.addEventListener('DOMContentLoaded', () => {
  updateTitleWithName();
  setBuzzEnabled(false); // until round is active
});
