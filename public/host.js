(() => {
  const socket = io();
  
  // UI elements
  const btnCreateRoom = document.getElementById('btnCreateRoom');
  const btnStartRound = document.getElementById('btnStartRound');
  const btnEndRound = document.getElementById('btnEndRound');
  const btnResetGame = document.getElementById('btnResetGame'); // NEW: Reset button
  const roomCodeEl = document.getElementById('roomCode');
  const pointsPerPartEl = document.getElementById('pointsPerPart');
  const btnConfigSave = document.getElementById('btnConfigSave');
  const queueList = document.getElementById('queueList');
  const leaderboardList = document.getElementById('leaderboardList');
  const btnPartCorrect = document.getElementById('btnPartCorrect');
  const btnFullCorrect = document.getElementById('btnFullCorrect');
  const btnNext = document.getElementById('btnNext');
  const btnDQNextRound = document.getElementById('btnDQNextRound');
  const playerLinkEl = document.getElementById('playerLink