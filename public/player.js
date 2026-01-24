
(() => {
  const socket = io();

  // ----- DOM -----
  const pageTitle       = document.getElementById('pageTitle');
  const roomCodeEl      = document.getElementById('roomCode');
  const playerNameEl    = document.getElementById('playerName');
  const btnJoin         = document.getElementById('btnJoin');
  const btnBuzz         = document.getElementById('btnBuzz');
  const dqBadge         = document.getElementById('dqBadge');
  const buzzHint        = document.getElementById('buzzHint');
  const queueList       = document.getElementById('queueListPlayer');
  const leaderboardList = document.getElementById('leaderboardListPlayer');
  const toastEl         = document.getElementById('toast');

  const toggleSound     = document.getElementById('toggleSound');
  const toggleHaptics   = document.getElementById('toggleHaptics');

  // ----- URL prefill -----
  const params = new URLSearchParams(window.location.search);
  const prefillRoom = params.get('room');
  if (prefillRoom) roomCodeEl.value = prefillRoom;

  // ----- State -----
  let joinedRoom = null;
  let roundActive = false;
  let dqThisRound = false;
  let myId = null;
  let myName = 'Player';
  let latestQueue = [];
  let wasHead = false;             // track transition to head for feedback

  // Preferences (persisted)
  const SOUND_KEY   = 'ribo_sound_muted';
  const HAPTIC_KEY  = 'ribo_haptics_enabled';
  let soundMuted    = JSON.parse(localStorage.getItem(SOUND_KEY)  ?? 'true');  // default OFF
  let hapticsEnabled= JSON.parse(localStorage.getItem(HAPTIC_KEY) ?? 'true');  // default ON

  // Apply initial toggle UI
  if (toggleSound)   toggleSound.checked   = !soundMuted;
  if (toggleHaptics) toggleHaptics.checked = !!hapticsEnabled;

  // ----- Audio (Web Audio API) -----
  let audioCtx = null;
  let audioUnlocked = false;

  function ensureAudio() {
    if (audioUnlocked) return;
    try {
      if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      // On iOS, resume after user gesture
      if (audioCtx.state === 'suspended') audioCtx.resume();
      audioUnlocked = true;
    } catch {
      // no-op; we’ll try again on next user gesture
    }
  }

  function playTone({ freq = 440, type = 'sine', ms = 120, gain = 0.05 }) {
    if (soundMuted) return;
    if (!audioUnlocked) return; // must be after user gesture
    try {
      const ctx = audioCtx;
      const osc = ctx.createOscillator();
      const g = ctx.createGain();
      osc.type = type;
      osc.frequency.setValueAtTime(freq, ctx.currentTime);
      g.gain.setValueAtTime(0, ctx.currentTime);
      g.gain.linearRampToValueAtTime(gain, ctx.currentTime + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + ms / 1000);
      osc.connect(g).connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + ms / 1000 + 0.02);
    } catch {
      // ignore audio failures
    }
  }

  function playTick() {
    // a short high tick
    playTone({ freq: 1200, type: 'square', ms: 50, gain: 0.03 });
  }

  function playBuzzer() {
    // layered quick buzzer (saw + square) with slight detune
    playTone({ freq: 330, type: 'sawtooth', ms: 220, gain: 0.06 });
    setTimeout(() => playTone({ freq: 220, type: 'square', ms: 180, gain: 0.05 }), 10);
  }

  // ----- Haptics -----
  function vibrate(pattern) {
    if (!hapticsEnabled) return;
    if (navigator.vibrate) {
      try { navigator.vibrate(pattern); } catch {}
    }
  }

  // ----- UI helpers -----
  function showToast(kind, message) {
    toastEl.className = `toast ${kind}`;
    toastEl.textContent = message;
    toastEl.classList.remove('hidden');
    setTimeout(() => toastEl.classList.add('hidden'), 2000);
  }

  function renderQueue(queue) {
    queueList.innerHTML = '';
    (queue || []).forEach((item, idx) => {
      const li = document.createElement('li');
      li.className = `queue-item ${idx === 0 ? 'queue-head' : 'queue-rest'}`;
      li.textContent = item.name;
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

    // color states
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

    // Transition: not head -> head -> feedback
    if (!wasHead && isHead) {
      vibrate([25]);
      playBuzzer();
    }
    wasHead = isHead;
  }

  // ----- Socket identity -----
  socket.on('connect', () => { myId = socket.id; });
  socket.on('reconnect', () => { myId = socket.id; });

  // ----- Events -----
  btnJoin.addEventListener('click', () => {
    ensureAudio(); // unlock audio on user gesture
    const code = (roomCodeEl.value || '').trim().toUpperCase();
    const name = (playerNameEl.value || 'Player').trim();
    if (!code || code.length < 4) {
      showToast('warning', 'Enter a valid room code.');
      return;
    }
    joinedRoom = code;
    myName = name;
    pageTitle.textContent = `RiBo Buzzer — ${myName}`;
    socket.emit('player:joinRoom', { roomCode: code, playerName: name });
    showToast('info', 'Joined. Wait for the round to start.');
    updateBuzzState();
  });

  btnBuzz.addEventListener('touchstart', () => { ensureAudio(); playTick(); }, { passive: true });
  btnBuzz.addEventListener('mousedown',   () => { ensureAudio(); playTick(); });
  btnBuzz.addEventListener('click', () => {
    if (!joinedRoom) return;
    socket.emit('player:buzz', { roomCode: joinedRoom });
  });

  // Toggles
  toggleSound?.addEventListener('change', () => {
    soundMuted = !toggleSound.checked;
    localStorage.setItem(SOUND_KEY, JSON.stringify(soundMuted));
    if (!soundMuted) ensureAudio();
  });

  toggleHaptics?.addEventListener('change', () => {
    hapticsEnabled = !!toggleHaptics.checked;
    localStorage.setItem(HAPTIC_KEY, JSON.stringify(hapticsEnabled));
  });

  // Socket listeners
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

  socket.on('toast:info',    ({ message }) => showToast('info', message));
  socket.on('toast:warning', ({ message }) => showToast('warning', message));
  socket.on('toast:error',   ({ message }) => showToast('error', message));
})();
