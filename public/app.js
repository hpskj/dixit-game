window.socket = io();
const socket = window.socket;

let code = '';
let state = null;
let myHand = [];
let myId = null;
let timerInterval = null;

const $ = id => document.getElementById(id);

// ===== أصوات =====
function playTone(freq = 440, duration = 0.12, type = 'sine') {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = type;
    osc.frequency.value = freq;
    gain.gain.value = 0.08;
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + duration);
    osc.stop(ctx.currentTime + duration);
  } catch (e) {}
}

function selectSound() {
  playTone(620, 0.08, 'triangle');
}

function winSound() {
  [523, 659, 784, 1046].forEach((f, i) =>
    setTimeout(() => playTone(f, 0.18), i * 150)
  );
}

// ===== Toast =====
function toast(msg) {
  const t = $('toast');
  if (!t) return;
  t.textContent = msg;
  t.style.display = 'block';
  setTimeout(() => (t.style.display = 'none'), 2000);
}

// ===== إنشاء غرفة =====
$('createBtn').onclick = () => {
  const name = $('nameInput').value.trim() || 'لاعب';
  socket.emit('createRoom', name);
};

// ===== دخول غرفة =====
$('joinBtn').onclick = () => {
  const name = $('nameInput').value.trim() || 'لاعب';
  const code = $('codeInput').value.trim().toUpperCase(); // ✅ تم الإصلاح هنا
  socket.emit('joinRoom', { code, name });
};

// ===== Socket =====
socket.on('connect', () => {
  myId = socket.id;
});

socket.on('roomCreated', c => {
  code = c;
  $('codeInput').value = c;
  toast('تم إنشاء الغرفة');
});

socket.on('errorMessage', toast);

socket.on('roomState', s => {
  state = s;
  code = s.code;

  $('joinBox')?.classList.add('hidden');
  $('gameBox')?.classList.remove('hidden');

  render();
});

// ===== Render =====
function render() {
  if (!state) return;

  const playersDiv = $('players');
  if (playersDiv) {
    playersDiv.innerHTML = state.players
      .map(p => `<div>${p.name} - ${p.score}</div>`)
      .join('');
  }
}

// ===== نسخ رابط الدعوة =====
window.copyInvite = function () {
  const url = window.location.origin + '?code=' + code;
  navigator.clipboard.writeText(url);
  toast('تم نسخ رابط الدعوة');
};

// ===== Timer =====
function startTimer() {
  clearInterval(timerInterval);
  const el = $('timerText');
  let time = 30;

  timerInterval = setInterval(() => {
    if (el) el.textContent = time;
    time--;
    if (time < 0) clearInterval(timerInterval);
  }, 1000);
}
