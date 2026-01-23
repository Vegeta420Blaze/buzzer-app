
(() => {
  const socket = io();

  // UI elements
  const btnCreateRoom = document.getElementById('btnCreateRoom');
  const btnStartRound = document.getElementById('btnStartRound');
  const btnEndRound   = document.getElementById('btnEndRound');
  const btnNewGame    = document.getElementById('btnNewGame');
  const roomCodeEl    = document.getElementById('roomCode');

  const pointsPerPartEl = document.getElementById('pointsPerPart');
  const btnConfigSave   = document.getElementById('btnConfigSave');

  const queueList       = document.getElementById('queueList');
  const leaderboardList = document.getElementById('leaderboardList');

  const btnPartCorrect  = document.getElementById('btnPartCorrect');
  const btnFullCorrect  = document.getElementById('btnFullCorrect');
  const btnNext         = document.getElementById('btnNext');
  const btnDQNextRound  = document.getElementById('btnDQNextRound');

  const playerLinkEl    = document.getElementById('playerLink');
  const btnCopyLink     = document.getElementById('btnCopyLink');
  const qrCanvas        = document.getElementById('qrCanvas');

  const toastEl         = document.getElementById('toast');

  let roomCode = null;
  let qr = null;

  function showToast(kind, message) {
    toastEl.className = `toast ${kind}`;
    toastEl.textContent = message;
    toastEl.classList.remove('hidden');
    setTimeout(() => toastEl.classList.add('hidden'), 2500);
  }

  function setRoomCode(code) {
    roomCode = code;
    roomCodeEl.textContent = `Room: ${code || '—'}`;

    const origin = window.location.origin;
    const link = `${origin}/player.html${code ? `?room=${code}` : ''}`;
    if (playerLinkEl) playerLinkEl.value = link;

    if (qrCanvas && window.QRCode) {
      while (qrCanvas.firstChild) qrCanvas.removeChild(qrCanvas.firstChild);
      /* global QRCode */
      qr = new QRCode(qrCanvas, { text: link, width: 180, height: 180, correctLevel: QRCode.CorrectLevel.M });
    }
  }

  // Buttons
  btnCreateRoom?.addEventListener('click', () => socket.emit('host:createRoom'));
  btnStartRound?.addEventListener('click', () => { if (roomCode) socket.emit('host:startRound', { roomCode }); });
  btnEndRound?.addEventListener('click',   () => { if (roomCode) socket.emit('host:endRound',   { roomCode }); });

  // New Game (full reset)
  btnNewGame?.addEventListener('click', () => {
    if (!roomCode) return;
    const ok = window.confirm('New Game will clear scores, queue, and DQ flags. Continue?');
    if (!ok) return;
    socket.emit('host:newGame', { roomCode });
  });

  // Config
  btnConfigSave?.addEventListener('click', () => {
    if (!roomCode) return;
    const points = parseInt(pointsPerPartEl.value, 10) || 5;
    socket.emit('config:update', { roomCode, pointsPerPart: points });
  });

  // Action buttons
  btnPartCorrect?.addEventListener('click', () => { if (roomCode) socket.emit('host:actionPartCorrect', { roomCode }); });
  btnFullCorrect?.addEventListener('click', () => { if (roomCode) socket.emit('host:actionFullCorrect', { roomCode }); });
  btnNext?.addEventListener('click',        () => { if (roomCode) socket.emit('host:actionNext',        { roomCode }); });
  btnDQNextRound?.addEventListener('click', () => { if (roomCode) socket.emit('host:actionDQNextRound', { roomCode }); });

  btnCopyLink?.addEventListener('click', async () => {
    const link = playerLinkEl.value.trim();
    try {
      await navigator.clipboard.writeText(link);
      showToast('info', 'Player link copied to clipboard.');
    } catch {
      playerLinkEl.select();
      showToast('warning', 'Copy failed – link selected for manual copy.');
    }
  });

  // Socket events
  socket.on('host:roomCreated', ({ roomCode: code }) => {
    setRoomCode(code);
    if (btnStartRound) btnStartRound.disabled = false;
    if (btnEndRound)   btnEndRound.disabled   = true;
    showToast('info', `Room created: ${code}`);
  });

  socket.on('state:sync', (state) => {
    // Round buttons
    if (btnStartRound) btnStartRound.disabled = !!state.roundActive;
    if (btnEndRound)   btnEndRound.disabled   = !state.roundActive;

    // Room linkage
    if (state.roomCode && state.roomCode !== roomCode) setRoomCode(state.roomCode);

    // Config
    if (state.config && typeof state.config.pointsPerPart === 'number') {
      pointsPerPartEl.value = state.config.pointsPerPart;
    }

    // Queue (let <ol> number items)
    if (queueList) {
      queueList.innerHTML = '';
      (state.queue || []).forEach((item, idx) => {
        const li = document.createElement('li');
        li.className = `queue-item ${idx === 0 ? 'queue-head' : 'queue-rest'}`;
        li.textContent = item.name;
        queueList.appendChild(li);
      });
    }

    // Leaderboard (let <ol> number items)
    if (leaderboardList) {
      leaderboardList.innerHTML = '';
      (state.leaderboard || [])
        .sort((a, b) => b.score - a.score)
        .forEach((p) => {
          const li = document.createElement('li');
          li.textContent = `${p.name} — ${p.score}`;
          leaderboardList.appendChild(li);
        });
    }
  });

  socket.on('toast:info',    ({ message }) => showToast('info', message));
  socket.on('toast:warning', ({ message }) => showToast('warning', message));
  socket.on('toast:error',   ({ message }) => showToast('error', message));
})();
