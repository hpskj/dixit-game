window.socket = io();
const socket = window.socket;

let code = '';
let state = null;
let myHand = [];
let myId = null;
let timerInterval = null;

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
  const title = card.title || '';
  const image = card.image || '';
  return `
    <button class="card ${extra}" data-card="${card.id}" ${onClick ? `onclick="${onClick}"` : ''}>
      <img src="${image}" alt="${title}" loading="lazy">
      <span>${title}</span>
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
    return `
      <div class="player ${p.connected ? '' : 'muted'}">
        <b>${p.name || 'لاعب'}${you}${host}${storyteller}</b>
        <span>${p.score || 0} نقطة${off}</span>
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

  table.innerHTML = cards.map(card => {
    const voters = (card.voters || []).length
      ? `<small>الأصوات: ${(card.voters || []).join('، ')}</small>`
      : '';

    const owner = card.ownerName ? `<small>صاحب الكرت: ${card.ownerName}</small>` : '';
    const story = card.isStorytellerCard ? `<small>🎙️ كرت الراوي</small>` : '';

    const canVote = state.phase === 'voting' && myId !== state.storytellerId;
    return `
      <button class="card tableCard ${card.isStorytellerCard ? 'storyCard' : ''}" ${canVote ? `onclick="voteCard('${card.id}')"` : ''}>
        <img src="${card.image}" alt="${card.title || ''}" loading="lazy">
        <span>${card.title || ''}</span>
        ${owner}
        ${story}
        ${voters}
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
  const el = $('timerText');
  const muted = document.querySelector('.muted');

  function tick() {
    if (!state?.timerEndsAt) {
      if (el) el.textContent = '';
      return;
    }
    const left = Math.max(0, Math.ceil((state.timerEndsAt - Date.now()) / 1000));
    if (el) el.textContent = `⏱️ ${left}`;
    if (muted && ['story','submit','voting'].includes(state.phase)) {
      muted.textContent = `الوقت: ${left} ثانية`;
    }
  }

  tick();
  timerInterval = setInterval(tick, 1000);
}

function render() {
  if (!state) return;

  setHidden('joinBox', true);
  setHidden('gameBox', false);

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

// إنشاء غرفة
$('createBtn').onclick = () => {
  const name = $('nameInput')?.value.trim() || 'لاعب';
  socket.emit('createRoom', name);
};

// دخول غرفة
$('joinBtn').onclick = () => {
  const name = $('nameInput')?.value.trim() || 'لاعب';
  const roomCode = $('codeInput')?.value.trim().toUpperCase();
  if (!roomCode) return toast('اكتب كود الغرفة');
  socket.emit('joinRoom', { name, code: roomCode });
};

socket.on('connect', () => {
  myId = socket.id;

  const params = new URLSearchParams(location.search);
  const roomFromUrl = params.get('room') || params.get('code');
  if (roomFromUrl && $('codeInput')) {
    $('codeInput').value = roomFromUrl.toUpperCase();
  }
});

socket.on('roomCreated', c => {
  code = c;
  if ($('codeInput')) $('codeInput').value = c;
  toast('تم إنشاء الغرفة');
});

socket.on('roomInvite', data => {
  if (data?.code) code = data.code;
});

socket.on('reconnectedToRoom', data => {
  toast(data?.message || 'تمت إعادة الاتصال');
});

socket.on('errorMessage', toast);

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
  render();
});
