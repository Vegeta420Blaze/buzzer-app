
(() => {
  const socket = io();

  const pageTitle = document.getElementById('pageTitle');
  const roomCodeEl = document.getElementById('roomCode');
  const playerNameEl = document.getElementById('playerName');
  const btnJoin = document.getElementById('btnJoin');
  const btnBuzz = document.getElementById('btnBuzz');
  const dqBadge = document.getElementById('dqBadge');
  const buzzHint = document.getElementById('buzzHint');
  const queueList = document.getElementById('queueListPlayer');
  const leaderboardList = document.getElementById('leaderboardListPlayer');
  const toastEl = document.getElementById('toast');

  const params = new URLSearchParams(window.location.search);
  const prefillRoom = params.get('room');
  if (prefillRoom) roomCodeEl.value = prefillRoom;

  let joinedRoom = null;
  let roundActive = false;
  let dqThisRound = false;
  let myId = null;
  let myName = 'Player';
  let latestQueue = [];

  socket.on('connect', () => { myId = socket.id; });
  socket.on('reconnect', () => { myId = socket.id; });

  function showToast(kind, message) {
    toastEl.className = `toast ${kind}`;
    toastEl.textContent = message;
    toastEl.classList.remove('hidden');
    setTimeout(() => toastEl.classList.add('hidden'), 2500);
  }

  function renderQueue(queue) {
    queueList.innerHTML = '';
    (queue || []).forEach((item, idx) => {
      const li = document.createElement('li');
      li.className = `queue-item ${idx === 0 ? 'queue-head' : 'queue-rest'}`;
      li.textContent = item.name; // let <ol> number; DO NOT prefix numbers
      if (item.id === myId) {
        const you = document.createElement('span');
        you.className = 'you-label';
        you.textContent = ' (You)';
        li.appendChild(you);
      }
      queueList.appendChild(li);
    });
  }

  function renderLeaderboard(list) {
    leaderboardList.innerHTML = '';
    (list || [])
      .sort((a, b) => b.score - a.score)
      .forEach((p) => {
        const li = document.createElement('li');
        li.textContent = `${p.name} — ${p.score}`;
        leaderboardList.appendChild(li);
      });
  }

  function updateBuzzState() {
    const ids = latestQueue.map(q => q.id);
    const inQueue = ids.includes(myId);
    const isHead = ids[0] === myId;

    btnBuzz.classList.remove('buzz-green', 'buzz-red');

    if (!joinedRoom || !roundActive || dqThisRound) {
      btnBuzz.disabled = true;
      buzzHint.textContent = dqThisRound
        ? 'You are DQ this round.'
        : 'Buzz is enabled only during an active round.';
    } else if (isHead) {
      btnBuzz.disabled = true;
      btnBuzz.classList.add('buzz-green');
      buzzHint.textContent = 'You are FIRST in the queue.';
    } else if (inQueue) {
      btnBuzz.disabled = true;
      btnBuzz.classList.add('buzz-red');
      const pos = ids.indexOf(myId) + 1;
      buzzHint.textContent = `Queued at position ${pos}.`;
    } else {
      btnBuzz.disabled = false;
      buzzHint.textContent = 'Ready to buzz!';
    }
    dqBadge.classList.toggle('hidden', !dqThisRound);
  }

  btnJoin.addEventListener('click', () => {
    const code = roomCodeEl.value.trim().toUpperCase();
    const name = playerNameEl.value.trim() || 'Player';

    if (!code || code.length < 4) {
      showToast('warning', 'Enter a valid room code.');
      return;
    }

    joinedRoom = code;
    myName = name;

    // Keep header as requested: “RiBo Buzzer — {playerName}”
    pageTitle.textContent = `RiBo Buzzer — ${myName}`;

    socket.emit('player:joinRoom', { roomCode: code, playerName: name });
    showToast('info', 'Joined. Wait for the round to start.');
    updateBuzzState();
  });

  btnBuzz.addEventListener('click', () => {
    if (!joinedRoom) return;
    socket.emit('player:buzz', { roomCode: joinedRoom });
  });

  socket.on('state:sync', (state) => {
    roundActive = !!state.roundActive;
    latestQueue = state.queue || [];
    renderQueue(latestQueue);
    renderLeaderboard(state.leaderboard || []);
    updateBuzzState();
  });

  socket.on('round:start', () => {
    roundActive = true;
    updateBuzzState();
    showToast('info', 'Round started!');
  });

  socket.on('round:end', () => {
    roundActive = false;
    latestQueue = [];
    renderQueue(latestQueue);
    updateBuzzState();
    showToast('warning', 'Round ended.');
  });

  socket.on('player:status', ({ dqThisRound: dq }) => {
    dqThisRound = !!dq;
    updateBuzzState();
  });

  socket.on('player:cooldown', ({ msRemaining }) => {
    showToast('warning', `Cooldown: ${Math.ceil(msRemaining)} ms`);
  });

  socket.on('toast:info', ({ message }) => showToast('info', message));
  socket.on('toast:warning', ({ message }) => showToast('warning', message));
  socket.on('toast:error', ({ message }) => showToast('error', message));
})();
