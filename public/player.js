
// Player page script — same-origin Socket.IO
const socket = io();

// Elements
const elRoomCode   = document.getElementById('roomCode');
const elPlayerName = document.getElementById('playerName');
const elBtnJoin    = document.getElementById('btnJoin');
const elBtnBuzz    = document.getElementById('btnBuzz');
const elJoinStatus = document.getElementById('joinStatus');
const elBuzzHint   = document.getElementById('buzzHint');
const elMessages   = document.getElementById('messages');
const elLbTable    = document.getElementById('lbTable').querySelector('tbody');
const elQueueView  = document.getElementById('queueView');

// Client-side state
let joinedRoomCode = null;
let myName = null;
let roundActive = false;

// UTIL: logs
function logMsg(target, className, msg) {
  const div = document.createElement('div');
  div.className = className;
  div.textContent = msg;
  target.prepend(div);
}

// Join room
elBtnJoin.addEventListener('click', () => {
  const code = (elRoomCode.value || '').trim().toUpperCase();
  const name = (elPlayerName.value || '').trim();
  if (!code || !name) {
    logMsg(elJoinStatus, 'warn', 'Enter room code and your name.');
    return;
  }
  socket.emit('player:joinRoom', { roomCode: code, playerName: name });
  joinedRoomCode = code;
  myName = name;
  logMsg(elJoinStatus, 'ok', `Joining ${code} as ${myName}...`);
});

// Buzz
elBtnBuzz.addEventListener('click', () => {
  if (!joinedRoomCode) {
    logMsg(elBuzzHint, 'warn', 'Join a room first.');
    return;
  }
  if (!roundActive) {
    logMsg(elBuzzHint, 'warn', 'Round is not active.');
    return;
  }
  socket.emit('player:buzz', { roomCode: joinedRoomCode });
});

// State sync
socket.on('state:sync', (state) => {
  roundActive = !!state.roundActive;
  elBtnBuzz.disabled = !roundActive;

  // Queue
  try {
    const list = (state.queue || []).map((q, i) => `${i + 1}. ${q.name}`).join('  |  ');
    elQueueView.textContent = list || '(empty)';
  } catch (_) {}

  // Leaderboard
  try {
    elLbTable.innerHTML = '';
    (state.leaderboard || []).forEach((row, idx) => {
      const tr = document.createElement('tr');
      tr.innerHTML = `<td>${idx + 1}</td><td>${row.name}</td><td>${row.score ?? 0}</td>`;
      elLbTable.appendChild(tr);
    });
  } catch (_) {}

  if (myName) document.title = `Buzzer — ${myName}`;
});

// Round events
socket.on('round:start', (info) => {
  roundActive = true;
  elBtnBuzz.disabled = false;
  logMsg(elBuzzHint, 'ok', `Round ${info.roundNumber} started.`);
});

socket.on('round:end', (info) => {
  roundActive = false;
  elBtnBuzz.disabled = true;
  logMsg(elBuzzHint, 'warn', `Round ${info.roundNumber} ended.`);
});

// Cooldown
socket.on('player:cooldown', ({ msRemaining }) => {
  logMsg(elBuzzHint, 'warn', `Cooldown… ${Math.ceil(msRemaining)} ms`);
});

// Toasts
socket.on('toast:info',   ({ message }) => logMsg(elMessages, 'ok',   message));
socket.on('toast:warning',({ message }) => logMsg(elMessages, 'warn', message));
socket.on('toast:error',  ({ message }) => logMsg(elMessages, 'err',  message));

// Connection status (debug)
socket.on('connect',    () => logMsg(elMessages, 'ok',   `Connected (${socket.id})`));
socket.on('disconnect', () => logMsg(elMessages, 'err',  'Disconnected'));
