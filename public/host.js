
/* Host page logic */
(() => {
  const socket = io();

  // UI elements
  const btnCreateRoom = document.getElementById('btnCreateRoom');
  const btnStartRound = document.getElementById('btnStartRound');
  const btnEndRound = document.getElementById('btnEndRound');
  const roomCodeEl = document.getElementById('roomCode');

  const pointsPerPartEl = document.getElementById('pointsPerPart');
  const btnConfigSave = document.getElementById('btnConfigSave');

  const queueList = document.getElementById('queueList');
  const leaderboardList = document.getElementById('leaderboardList');

  const playerLinkEl = document.getElementById('playerLink');
  const btnCopyLink = document.getElementById('btnCopyLink');
  const qrCanvas = document.getElementById('qrCanvas');

  const toastEl = document.getElementById('toast');

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

    // Set player link and QR
    const origin = window.location.origin;
    const link = `${origin}/player.html${code ? `?room=${code}` : ''}`;
    if (playerLinkEl) playerLinkEl.value = link;

    // Generate QR
    if (qrCanvas && window.QRCode) {
      while (qrCanvas.firstChild) qrCanvas.removeChild(qrCanvas.firstChild);
      // eslint-disable-next-line no-undef
      qr = new QRCode(qrCanvas, {
        text: link, width: 180, height: 180, correctLevel: QRCode.CorrectLevel.M,
      });
    }
  }

  // Buttons
  btnCreateRoom?.addEventListener('click', () => {
    socket.emit('host:createRoom');
  });
  btnStartRound?.addEventListener('click', () => {
    if (!roomCode) return;
    socket.emit('host:startRound', { roomCode });
  });
  btnEndRound?.addEventListener('click', () => {
    if (!roomCode) return;
    socket.emit('host:endRound', { roomCode });
  });
  btnConfigSave?.addEventListener('click', () => {
    if (!roomCode) return;
    const points = parseInt(pointsPerPartEl.value, 10) || 5;
    socket.emit('config:update', { roomCode, pointsPerPart: points });
  });
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
    if (btnEndRound) btnEndRound.disabled = true;
    showToast('info', `Room created: ${code}`);
  });

  socket.on('state:sync', (state) => {
    // state: { roomCode, roundActive, roundNumber, queue[{id,name}], leaderboard[{id,name,score}], config{pointsPerPart} }
    if (state.roomCode && state.roomCode !== roomCode) {
      setRoomCode(state.roomCode);
    }

    // Round buttons
    if (btnStartRound) btnStartRound.disabled = !!state.roundActive === true;
    if (btnEndRound) btnEndRound.disabled = !!state.roundActive === false;

    // Config
    if (state.config && typeof state.config.pointsPerPart === 'number') {
      pointsPerPartEl.value = state.config.pointsPerPart;
    }

    // Queue (with coloring)
    if (queueList) {
      queueList.innerHTML = '';
      (state.queue || []).forEach((item, idx) => {
        const li = document.createElement('li');
        li.className = `queue-item ${idx === 0 ? 'queue-head' : 'queue-rest'}`;
        li.textContent = `${idx + 1}. ${item.name}`;
        queueList.appendChild(li);
      });
    }

    // Leaderboard
    if (leaderboardList) {
      leaderboardList.innerHTML = '';
      (state.leaderboard || [])
        .sort((a, b) => b.score - a.score)
        .forEach((p, idx) => {
          const li = document.createElement('li');
          li.textContent = `${idx + 1}. ${p.name} — ${p.score}`;
          leaderboardList.appendChild(li);
        });
    }
  });

  socket.on('toast:info', ({ message }) => showToast('info', message));
  socket.on('toast:warning', ({ message }) => showToast('warning', message));
  socket.on('toast:error', ({ message }) => showToast('error', message));
})();
