const form = document.getElementById('loginForm');
const msg = document.getElementById('message');

function show(text, type='') {
  msg.className = 'message ' + type;
  msg.textContent = text;
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  show('جاري تسجيل الدخول...');

  const username = document.getElementById('username').value.trim();
  const password = document.getElementById('password').value;

  try {
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password })
    });

    const data = await res.json();

    if (!data.ok) {
      show(data.message || 'فشل تسجيل الدخول', 'error');
      return;
    }

    localStorage.setItem('member_token', data.token || '');
    localStorage.setItem('member_user', JSON.stringify(data.user || {}));
    show('تم تسجيل الدخول بنجاح ✅', 'ok');

    setTimeout(() => {
      const params = new URLSearchParams(location.search);
      const next = params.get('next');
      const room = params.get('room');
      location.href = next || (room ? '/?room=' + encodeURIComponent(room) : '/');
    }, 700);
  } catch (err) {
    show('حدث خطأ في الاتصال', 'error');
  }
});
