// smart-features.js
// ضعه بعد app.js في index.html

(function () {
  let currentRoomCode = null;
  let lastPhase = null;

  // مؤثر صوتي بسيط بدون ملفات خارجية
  function beep(type = 'click') {
    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      const ctx = new AudioCtx();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();

      const map = {
        click: [520, 0.045],
        card: [680, 0.070],
        vote: [760, 0.075],
        win: [880, 0.22],
        join: [420, 0.08]
      };

      const [freq, dur] = map[type] || map.click;
      osc.frequency.value = freq;
      osc.type = 'sine';
      gain.gain.value = 0.035;

      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start();

      setTimeout(() => {
        osc.stop();
        ctx.close();
      }, dur * 1000);
    } catch {}
  }

  function confetti() {
    const wrap = document.createElement('div');
    wrap.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:99999;overflow:hidden';
    document.body.appendChild(wrap);

    for (let i = 0; i < 90; i++) {
      const p = document.createElement('div');
      p.textContent = ['🎉','✨','⭐','🎴','🏆'][Math.floor(Math.random()*5)];
      p.style.cssText = `
        position:absolute;top:-40px;left:${Math.random()*100}vw;
        font-size:${18 + Math.random()*22}px;
        transform:rotate(${Math.random()*360}deg);
        transition:transform 1.8s ease, top 1.8s ease, opacity 1.8s ease;
      `;
      wrap.appendChild(p);
      setTimeout(() => {
        p.style.top = '110vh';
        p.style.transform += ` translateX(${(Math.random()-.5)*220}px)`;
        p.style.opacity = '0';
      }, 30 + Math.random()*250);
    }

    setTimeout(() => wrap.remove(), 2300);
  }

  function ensureInviteButton() {
    if (!currentRoomCode) return;

    let box = document.getElementById('smartInviteBox');
    if (!box) {
      box = document.createElement('div');
      box.id = 'smartInviteBox';
      box.style.cssText = `
        position:fixed;right:14px;top:14px;z-index:9999;
        display:flex;gap:8px;flex-wrap:wrap;direction:rtl;
      `;
      document.body.appendChild(box);
    }

    const link = `${location.origin}/invite/${currentRoomCode}`;
    box.innerHTML = `
      <button id="copyInviteBtn" style="
        border:0;border-radius:999px;padding:10px 14px;cursor:pointer;
        background:linear-gradient(135deg,#ffd84d,#fff07b);color:#17152c;font-weight:900;
        box-shadow:0 10px 30px rgba(0,0,0,.22)
      ">🔗 نسخ رابط الدعوة</button>
    `;

    document.getElementById('copyInviteBtn').onclick = async () => {
      beep('click');
      try {
        await navigator.clipboard.writeText(link);
        document.getElementById('copyInviteBtn').textContent = '✅ تم نسخ الرابط';
      } catch {
        prompt('انسخ رابط الدعوة:', link);
      }
      setTimeout(() => {
        const btn = document.getElementById('copyInviteBtn');
        if (btn) btn.textContent = '🔗 نسخ رابط الدعوة';
      }, 1600);
    };
  }

  // أصوات عند الضغط على الأزرار والكروت
  document.addEventListener('click', (e) => {
    const target = e.target;
    if (!target) return;

    if (target.closest('button')) beep('click');
    if (target.closest('.card') || target.closest('[data-card]') || target.closest('img')) beep('card');
  }, true);

  // التقاط أحداث socket.io إذا كان socket موجود عام
  function hookSocket() {
    const s = window.socket;
    if (!s || s.__smartHooked) return false;
    s.__smartHooked = true;

    s.on('roomState', (state) => {
      if (state?.code) {
        currentRoomCode = state.code;
        ensureInviteButton();
      }

      if (state?.phase && state.phase !== lastPhase) {
        if (state.phase === 'voting') beep('vote');
        if (state.phase === 'results') beep('win');
        lastPhase = state.phase;
      }
    });

    s.on('roomCreated', (code) => {
      currentRoomCode = code;
      beep('join');
      ensureInviteButton();
    });

    s.on('reconnectedToRoom', () => {
      beep('join');
    });

    s.on('gameWinner', () => {
      beep('win');
      confetti();
    });

    return true;
  }

  // بعض مشاريعك تعرّف socket بـ const وليس window.socket
  // لذلك نضيف مؤثرات عامة، وإذا كان window.socket متاحاً نفعل الدعوة الذكية فوراً.
  const timer = setInterval(() => {
    if (hookSocket()) clearInterval(timer);
  }, 500);

  setTimeout(() => clearInterval(timer), 10000);

  // دعم روابط الدعوة: /?room=ABCD
  window.addEventListener('DOMContentLoaded', () => {
    const room = new URLSearchParams(location.search).get('room');
    if (!room) return;

    const codeInput = document.querySelector('#code, input[placeholder*="كود"], input[placeholder*="الغرفة"]');
    if (codeInput) codeInput.value = room.toUpperCase();
  });
})();
