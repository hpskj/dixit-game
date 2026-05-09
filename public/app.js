window.socket = io();
const socket = window.socket;

let code = '';
let state = null;
let myHand = [];
let myId = null;
let timerInterval = null;
let currentUser = null;
let roomTemplates = [];
const LAST_ROOM_KEY = 'dixitq8_last_room_code';


const $ = id => document.getElementById(id);

function toast(msg) {
  const t = $('toast');
  if (!t) return alert(msg);
  t.textContent = msg;
  t.style.display = 'block';
  setTimeout(() => {
    t.style.display = 'none';
  }, 2500);
}

function phaseName(p) {
  return {
    lobby: 'الانتظار',
    story: 'اختيار الراوي',
    submit: 'اختيار الكروت',
    voting: 'التصويت',
    results: 'النتائج',
    ended: 'انتهت اللعبة'
  }[p] || p;
}

function playTone(freq = 440, duration = 0.12, type = 'sine') {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = type;
    osc.frequency.value = freq;
    gain.gain.value = 0.07;
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

function inviteLink() {
  if (!code) return location.origin;
  return location.origin + '/invite/' + code;
}

async function copyInviteLink() {
  if (!code) return toast('أنشئ غرفة أولاً');
  const link = inviteLink();
  try {
    await navigator.clipboard.writeText(link);
    toast('تم نسخ رابط الدعوة');
  } catch {
    prompt('انسخ رابط الدعوة:', link);
  }
}

window.copyInviteLink = copyInviteLink;
window.copyInvite = copyInviteLink;

function cardHtml(card, onClick, extra = '') {
  if (!card) return '';
  const image = card.image || '';
  return `
    <button class="card ${extra}" data-card="${card.id}" ${onClick ? `onclick="${onClick}"` : ''}>
      <img src="${image}" alt="" loading="lazy">
    </button>
  `;
}

function setHidden(id, hidden) {
  const el = $(id);
  if (!el) return;
  el.classList.toggle('hidden', hidden);
}

function renderPlayers() {
  const players = $('players');
  if (!players || !state) return;

  players.innerHTML = (state.players || []).map(p => {
    const you = p.id === myId ? ' أنت' : '';
    const host = p.id === state.hostId ? ' 👑' : '';
    const storyteller = p.id === state.storytellerId ? ' 🎙️' : '';
    const off = p.connected ? '' : ' غير متصل';
    const safePlayerName = encodeURIComponent(p.name || 'لاعب');
    const kickBtn = (myId === state.hostId && p.id !== myId)
      ? `<button class="kickBtn" type="button" onclick="kickPlayer('${p.id}', decodeURIComponent('${safePlayerName}'))">طرد</button>`
      : '';
    return `
      <div class="player ${p.connected ? '' : 'muted'}">
        <b>${p.name || 'لاعب'}${you}${host}${storyteller}</b>
        <span>${p.score || 0} نقطة${off}</span>
        ${kickBtn}
      </div>
    `;
  }).join('');
}

function renderActions() {
  const actions = $('actions');
  if (!actions || !state) return;

  actions.innerHTML = '';

  if (state.phase === 'lobby') {
    if (myId === state.hostId) {
      actions.innerHTML = `
        <div class="actionBox">
          <p>كود الغرفة: <b>${state.code}</b></p>
          <button onclick="copyInviteLink()">🔗 نسخ رابط الدعوة</button>
          <button onclick="socket.emit('startGame', '${state.code}')">ابدأ اللعبة</button>
        </div>
      `;
    } else {
      actions.innerHTML = `<p class="muted">بانتظار صاحب الغرفة يبدأ اللعبة...</p>`;
    }
    return;
  }

  if (state.phase === 'story') {
    if (myId === state.storytellerId) {
      actions.innerHTML = `
        <div class="actionBox">
          <p>أنت الراوي. اختر كرتاً واكتب تلميحاً.</p>
          <input id="hintInput" placeholder="اكتب التلميح هنا">
        </div>
      `;
    } else {
      const st = (state.players || []).find(p => p.id === state.storytellerId);
      actions.innerHTML = `<p>الراوي الآن: <b>${st?.name || 'لاعب'}</b> — انتظر التلميح.</p>`;
    }
    return;
  }

  if (state.phase === 'submit') {
    actions.innerHTML = `
      <div class="actionBox">
        <p>التلميح: <b>${state.hint || ''}</b></p>
        ${myId === state.storytellerId ? '<p>انتظر اللاعبين يختارون كروتهم.</p>' : '<p>اختر كرتاً يناسب التلميح.</p>'}
      </div>
    `;
    return;
  }

  if (state.phase === 'voting') {
    actions.innerHTML = `
      <div class="actionBox">
        <p>التلميح: <b>${state.hint || ''}</b></p>
        ${myId === state.storytellerId ? '<p>أنت الراوي، لا تصوّت.</p>' : '<p>صوّت للكرت الذي تعتقد أنه كرت الراوي.</p>'}
      </div>
    `;
    return;
  }

  if (state.phase === 'results') {
    if (myId === state.hostId) {
      actions.innerHTML = `<button onclick="socket.emit('nextRound', '${state.code}')">الجولة التالية</button>`;
    } else {
      actions.innerHTML = `<p class="muted">بانتظار صاحب الغرفة يبدأ الجولة التالية...</p>`;
    }
    return;
  }

  if (state.phase === 'ended') {
    actions.innerHTML = `
      <div class="actionBox">
        <h2>🏆 الفائز: ${state.lastWinner?.name || 'لاعب'}</h2>
        <p>${state.lastWinner?.score || 0} نقطة</p>
      </div>
    `;
  }
}

function renderHand() {
  const hand = $('hand');
  if (!hand || !state) return;

  if (!myHand.length) {
    hand.innerHTML = '<p class="muted">لا توجد كروت حالياً</p>';
    return;
  }

  if (state.phase === 'story' && myId === state.storytellerId) {
    hand.innerHTML = myHand.map(card => cardHtml(card, `submitStoryCard('${card.id}')`)).join('');
    return;
  }

  if (state.phase === 'submit' && myId !== state.storytellerId) {
    hand.innerHTML = myHand.map(card => cardHtml(card, `submitPlayerCard('${card.id}')`)).join('');
    return;
  }

  hand.innerHTML = myHand.map(card => cardHtml(card, '')).join('');
}

function renderTable() {
  const table = $('table');
  if (!table || !state) return;

  const cards = state.tableCards || [];
  if (!cards.length) {
    table.innerHTML = '<p class="muted">لا توجد كروت على الطاولة</p>';
    return;
  }

  if (['results', 'ended'].includes(state.phase)) {
    const roundSummary = (state.roundGained || []).length
      ? `<div class="roundPointsSummary">
          <h3>نقاط هذه الجولة</h3>
          <div class="roundPointsList">
            ${(state.roundGained || []).map(p => `<span>${p.name}: <b>+${p.points || 0}</b></span>`).join('')}
          </div>
        </div>`
      : '';

    table.innerHTML = `
      ${roundSummary}
      <div class="roundResultsList">
        ${cards.map((card, index) => {
          const voters = (card.voterDetails || []).length
            ? card.voterDetails.map(v => `<span>${v.name}</span>`).join('')
            : '<em>لم يختره أحد</em>';
          const story = card.isStorytellerCard ? '<span class="storyBadge">🎙️ كرت الراوي الصحيح</span>' : '';
          return `
            <article class="roundResultCard ${card.isStorytellerCard ? 'storyCard' : ''}">
              <div class="roundCardImage">
                <img src="${card.image}" alt="" loading="lazy">
              </div>
              <div class="roundCardInfo">
                <div class="roundCardHeader">
                  <b>الكرت ${index + 1}</b>
                  ${story}
                </div>
                <p>صاحب الكرت: <strong>${card.ownerName || 'لاعب'}</strong></p>
                <p>اللاعبون الذين اختاروا هذا الكرت:</p>
                <div class="votersList">${voters}</div>
                <p class="roundGain">نقاط صاحب الكرت في هذه الجولة: <strong>+${card.ownerRoundPoints || 0}</strong></p>
              </div>
            </article>
          `;
        }).join('')}
      </div>
    `;
    return;
  }

  table.innerHTML = cards.map(card => {
    const canVote = state.phase === 'voting' && myId !== state.storytellerId;
    return `
      <button class="card tableCard" ${canVote ? `onclick="voteCard('${card.id}')"` : ''}>
        <img src="${card.image}" alt="" loading="lazy">
      </button>
    `;
  }).join('');
}

function renderHint() {
  const h = $('hintTitle');
  if (!h || !state) return;
  h.textContent = `${phaseName(state.phase)} ${state.hint ? '— ' + state.hint : ''}`;
}

function startTimer() {
  clearInterval(timerInterval);
  const topEl = $('timerText');
  const playBox = $('playTimerBox');
  const playEl = $('playTimerText');
  const muted = document.querySelector('.muted');

  function formatTime(totalSeconds) {
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${minutes}:${String(seconds).padStart(2, '0')}`;
  }

  function tick() {
    const activePhase = ['story','submit','voting'].includes(state?.phase);
    if (!state?.timerEndsAt || !activePhase) {
      if (topEl) topEl.textContent = '';
      if (playEl) playEl.textContent = '--';
      if (playBox) playBox.classList.add('hidden');
      return;
    }

    const left = Math.max(0, Math.ceil((state.timerEndsAt - Date.now()) / 1000));
    const formatted = formatTime(left);

    if (topEl) topEl.textContent = `⏱️ ${formatted}`;
    if (playEl) playEl.textContent = formatted;
    if (playBox) {
      playBox.classList.remove('hidden');
      playBox.classList.toggle('warning', left <= 10);
    }
    if (muted && activePhase) {
      muted.textContent = `الوقت: ${left} ثانية`;
    }
  }

  tick();
  timerInterval = setInterval(tick, 1000);
}

function render() {
  if (!state) return;

  setHidden('roomsBox', true);
  setHidden('gameBox', false);
  const rt = $('roomTitle');
  if (rt && state) rt.textContent = `🏠 ${state.roomName || 'غرفة'}${state.roomCategory ? ' — ' + state.roomCategory : ''}`;

  renderHint();
  renderPlayers();
  renderActions();
  renderHand();
  renderTable();
  startTimer();
}

window.submitStoryCard = function(cardId) {
  if (!state) return;
  const hint = ($('hintInput')?.value || '').trim();
  if (!hint) return toast('اكتب التلميح أولاً');
  selectSound();
  socket.emit('storySubmit', { code: state.code, cardId, hint });
};

window.submitPlayerCard = function(cardId) {
  if (!state) return;
  selectSound();
  socket.emit('submitCard', { code: state.code, cardId });
};

window.voteCard = function(tableId) {
  if (!state) return;
  selectSound();
  socket.emit('vote', { code: state.code, tableId });
};


window.kickPlayer = function(playerId, playerName = 'لاعب') {
  if (!state || myId !== state.hostId) return;
  if (!playerId || playerId === myId) return;
  if (!confirm(`هل تريد طرد ${playerName} من الغرفة؟`)) return;
  socket.emit('kickPlayer', { code: state.code, playerId });
};


function saveLastRoom(roomCode) {
  if (!roomCode) return;
  try { localStorage.setItem(LAST_ROOM_KEY, String(roomCode).toUpperCase()); } catch (e) {}
}

function getLastRoom() {
  try { return localStorage.getItem(LAST_ROOM_KEY) || ''; } catch (e) { return ''; }
}

function clearLastRoom() {
  try { localStorage.removeItem(LAST_ROOM_KEY); } catch (e) {}
}

async function loadResumeRooms() {
  const box = $('resumeBox');
  if (!box || !currentUser) return;

  const savedCode = getLastRoom();
  let activeRooms = [];
  try {
    const res = await fetch('/api/my-active-rooms').then(r => r.json());
    if (res.ok) activeRooms = res.rooms || [];
  } catch (e) {}

  if (savedCode && !activeRooms.some(r => r.code === savedCode)) {
    activeRooms.unshift({ code: savedCode, roomName: 'آخر لعبة', phase: 'غير معروف', round: 0, score: 0, playersCount: 0 });
  }

  activeRooms = activeRooms.filter(r => r && r.code).slice(0, 3);
  if (!activeRooms.length) {
    box.classList.add('hidden');
    box.innerHTML = '';
    return;
  }

  box.classList.remove('hidden');
  box.innerHTML = `
    <h3>🔄 الرجوع للعبة السابقة</h3>
    <p class="muted smallHint">إذا انقطع اتصالك أو خرجت من الصفحة، يمكنك الرجوع ومتابعة نفس المباراة.</p>
    <div class="resumeList">
      ${activeRooms.map(r => `
        <div class="resumeCard">
          <div>
            <b>${r.roomName || 'غرفة'}</b>
            <small>الكود: ${r.code} — ${phaseName(r.phase)} — الجولة ${r.round || 0}</small>
          </div>
          <button type="button" onclick="resumeRoom('${r.code}')">رجوع للعبة</button>
        </div>
      `).join('')}
    </div>
  `;
}

window.resumeRoom = function(roomCode) {
  if (!roomCode) return toast('لا يوجد كود لعبة محفوظ');
  saveLastRoom(roomCode);
  if ($('codeInput')) $('codeInput').value = roomCode;
  socket.emit('reconnectRoom', { code: roomCode });
};

function roomCardHtml(room) {
  const cover = room.cover ? `<img src="${room.cover}" alt="${room.name}">` : '<div class="roomCoverEmpty">🎴</div>';
  return `
    <article class="roomCard">
      <div class="roomCover">${cover}</div>
      <div class="roomInfo">
        <b>${room.name}</b>
        <span>${room.category || 'فئة عامة'}</span>
        <small>${room.cardCount || 0} صورة</small>
        ${room.description ? `<p>${room.description}</p>` : ''}
        <button onclick="createGameFromTemplate('${room.id}')" ${room.cardCount ? '' : 'disabled'}>إنشاء لعبة من هذه الغرفة</button>
      </div>
    </article>
  `;
}

async function loadRoomTemplates() {
  const box = $('roomsList');
  if (!box) return;
  const res = await fetch('/api/room-templates').then(r => r.json());
  roomTemplates = res.rooms || [];
  box.innerHTML = roomTemplates.length
    ? roomTemplates.map(roomCardHtml).join('')
    : '<p class="muted">لا توجد غرف بعد. أنشئ غرفة من لوحة الأدمن وأضف صورها.</p>';
}

window.createGameFromTemplate = function(roomId) {
  socket.emit('createRoom', { roomId });
};

// دخول غرفة بكود دعوة
$('joinBtn').onclick = () => {
  const roomCode = $('codeInput')?.value.trim().toUpperCase();
  if (!roomCode) return toast('اكتب كود الغرفة');
  saveLastRoom(roomCode);
  socket.emit('joinRoom', { code: roomCode });
};

async function requirePlayerLogin() {
  const res = await fetch('/api/auth/me').then(r => r.json()).catch(() => ({ ok:false }));
  if (!res.ok || !res.user) {
    const next = encodeURIComponent(location.pathname + location.search);
    location.href = '/login.html?next=' + next;
    return false;
  }
  currentUser = res.user;
  const w = $('welcomeText');
  if (w) w.textContent = `هلا ${currentUser.display_name || currentUser.username} — اختر غرفة وابدأ اللعب.`;
  return true;
}

const logoutBtn = $('logoutPlayerBtn');
if (logoutBtn) logoutBtn.onclick = async () => { clearLastRoom(); await fetch('/api/auth/logout', { method:'POST' }); location.href = '/login.html'; };

socket.on('connect', async () => {
  myId = socket.id;
  if (!(await requirePlayerLogin())) return;
  await loadResumeRooms();
  await loadRoomTemplates();

  const params = new URLSearchParams(location.search);
  const roomFromUrl = params.get('room') || params.get('code');
  if (roomFromUrl && $('codeInput')) {
    $('codeInput').value = roomFromUrl.toUpperCase();
  }
});

socket.on('roomCreated', c => {
  code = c;
  saveLastRoom(c);
  if ($('codeInput')) $('codeInput').value = c;
  toast('تم إنشاء الغرفة');
});

socket.on('roomInvite', data => {
  if (data?.code) code = data.code;
});

socket.on('reconnectedToRoom', data => {
  if (data?.code) saveLastRoom(data.code);
  toast(data?.message || 'تمت إعادة الاتصال');
});

socket.on('errorMessage', toast);
socket.on('successMessage', toast);

socket.on('kickedFromRoom', data => {
  toast(data?.message || 'تم طردك من الغرفة');
  clearLastRoom();
  state = null;
  code = '';
  myHand = [];
  setHidden('gameBox', true);
  setHidden('roomsBox', false);
  loadResumeRooms();
  loadRoomTemplates();
});

socket.on('yourHand', hand => {
  myHand = hand || [];
  render();
});

socket.on('gameWinner', w => {
  winSound();
  toast(`🏆 الفائز: ${w.name} - ${w.score} نقطة`);
});

socket.on('roomState', s => {
  state = s;
  code = s.code;
  saveLastRoom(s.code);
  const resume = $('resumeBox');
  if (resume) resume.classList.add('hidden');
  render();
});
