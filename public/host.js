
// public/host.js
(() => {
  const socket = io();

  // Elements
  const btnCreateRoom = document.getElementById('btnCreateRoom');
  const btnJoinRoom   = document.getElementById('btnJoinRoom');
  const inpRoomCode   = document.getElementById('inpRoomCode');

  const lblRoomCode   = document.getElementById('lblRoomCode');
  const lblRound      = document.getElementById('lblRound');
  const lblPlayers    = document.getElementById('lblPlayers');

  const inpPointsPerPart = document.getElementById('inpPointsPerPart');
  const btnApplyConfig   = document.getElementById('btnApplyConfig');
  const configStatus     = document.getElementById('configStatus');

  const btnStartRound = document.getElementById('btnStartRound');
  const btnEndRound   = document.getElementById('btnEndRound');

  const queueList        = document.getElementById('queueList');
  const btnAwardPart     = document.getElementById('btnAwardPart');
  const btnAwardFull     = document.getElementById('btnAwardFull');
  const btnNext          = document.getElementById('btnNext');
  const btnDQNextRound   = document.getElementById('btnDQNextRound');

  const btnShowQr  = document.getElementById('btnShowQr');
  const btnHideQr  = document.getElementById('btnHideQr');
  const qrSection  = document.getElementById('qrSection');
  const qrCanvas   = document.getElementById('qrCanvas');
  const qrUrl      = document.getElementById('qrUrl');

  const toastContainer = document.getElementById('toastContainer');

  // State
  let currentRoomCode = null;
  let lanIp = '127.0.0.1';
  let port  = 3000;

  // Toasts
  function showToast(type, message){
    const div = document.createElement('div');
    div.className = `toast toast-${type}`;
    div.textContent = message;
    toastContainer.appendChild(div);
    setTimeout(() => div.classList.add('show'), 10);
    setTimeout(() => {
      div.classList.remove('show');
      setTimeout(() => div.remove(), 280);
    }, 2600);
  }

  // Buttons
  btnCreateRoom.addEventListener('click', () => socket.emit('host:createRoom'));

  btnJoinRoom.addEventListener('click', () => {
    const code = (inpRoomCode.value || '').trim().toUpperCase();
    if (!/^[A-Z2-9]{6}$/.test(code)) {
      showToast('error','Enter a valid 6-char room code (A–Z, 2–9).');
      return;
    }
    socket.emit('host:joinRoom', { roomCode: code });
  });

  btnStartRound.addEventListener('click', () => {
    if (!currentRoomCode) return;
    socket.emit('host:startRound', { roomCode: currentRoomCode });
  });

  btnEndRound.addEventListener('click', () => {
    if (!currentRoomCode) return;
    socket.emit('host:endRound', { roomCode: currentRoomCode });
  });

  btnApplyConfig.addEventListener('click', () => {
    if (!currentRoomCode) {
      showToast('error','Join or create a room first.');
      return;
    }
    const pointsPerPart = Number(inpPointsPerPart.value);
    socket.emit('config:update', { roomCode: currentRoomCode, pointsPerPart });
  });

  btnAwardPart.addEventListener('click', () => {
    if (!currentRoomCode) return;
    socket.emit('host:actionPartCorrect', { roomCode: currentRoomCode });
  });

  btnAwardFull.addEventListener('click', () => {
    if (!currentRoomCode) return;
    socket.emit('host:actionFullCorrect', { roomCode: currentRoomCode });
  });

  btnNext.addEventListener('click', () => {
    if (!currentRoomCode) return;
    socket.emit('host:actionNext', { roomCode: currentRoomCode });
  });

  btnDQNextRound.addEventListener('click', () => {
    if (!currentRoomCode) return;
    socket.emit('host:actionDQNextRound', { roomCode: currentRoomCode });
  });

  // QR Show/Hide
  btnShowQr.addEventListener('click', () => {
    const url = `http://${lanIp}:${port}/player.html`;
    qrUrl.textContent = url;
    qrSection.style.display = 'block';
    try{
      if (window.__miniQR && typeof window.__miniQR.makeQR === 'function') {
        window.__miniQR.makeQR(qrCanvas, url, 220); // stub draws URL text
      } else {
        const ctx = qrCanvas.getContext('2d');
        ctx.fillStyle = '#fff'; ctx.fillRect(0,0,qrCanvas.width,qrCanvas.height);
        ctx.fillStyle = '#000'; ctx.font = '14px sans-serif';
        ctx.fillText(url,10,20);
      }
      showToast('info','Player link ready.');
    }catch(e){
      console.error(e);
      showToast('error','Failed to render QR.');
    }
  });
  btnHideQr.addEventListener('click', () => { qrSection.style.display = 'none'; });

  // Socket events
  socket.on('server:lanInfo', ({ lanIp: ip, port: p }) => {
    if (ip) lanIp = ip;
    if (p)   port = p;
  });

  socket.on('host:roomCreated', ({ roomCode }) => {
    currentRoomCode = roomCode;
    lblRoomCode.textContent = `Room: ${roomCode}`;
    inpRoomCode.value = roomCode;
    showToast('info',`Room created: ${roomCode}`);
  });

  socket.on('state:sync', (state) => {
    if (!state || !state.roomCode) return;
    currentRoomCode = state.roomCode;
    lblRoomCode.textContent = `Room: ${state.roomCode}`;
    lblRound.textContent    = `Round: ${state.roundNumber || 0}`;
    lblPlayers.textContent  = `Players: ${state.leaderboard ? state.leaderboard.length : 0}`;

    // Queue — highlight first item
    queueList.innerHTML = '';
    (state.queue || []).forEach((q, idx) => {
      const li = document.createElement('li');
      li.textContent = `${idx + 1}. ${q.name}`;
      if (idx === 0) li.classList.add('first');
      queueList.appendChild(li);
    });

    // Leaderboard
    const tbody = document.getElementById('leaderboardBody');
    tbody.innerHTML = '';
    (state.leaderboard || []).forEach((p, idx) => {
      const tr = document.createElement('tr');
      tr.innerHTML = `<td>${idx + 1}</td><td>${p.name}</td><td>${p.score}</td>`;
      tbody.appendChild(tr);
    });

    // Config
    if (state.config && typeof state.config.pointsPerPart === 'number') {
      inpPointsPerPart.value = state.config.pointsPerPart;
      configStatus.textContent = `Points per part: ${state.config.pointsPerPart}`;
      setTimeout(() => (configStatus.textContent = ''), 3000);
    }
  });

  socket.on('config:sync', ({ config }) => {
    if (!config) return;
    if (typeof config.pointsPerPart === 'number') {
      inpPointsPerPart.value = config.pointsPerPart;
      configStatus.textContent = `Config updated: points per part = ${config.pointsPerPart}`;
      setTimeout(() => (configStatus.textContent = ''), 3000);
    }
  });

  socket.on('toast:error',   ({ message }) => showToast('error',   message));
  socket.on('toast:info',    ({ message }) => showToast('info',    message));
  socket.on('toast:warning', ({ message }) => showToast('warning', message));
})();
