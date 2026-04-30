const form = document.getElementById('registerForm');
const msg = document.getElementById('message');

function show(text, type='') {
  msg.className = 'message ' + type;
  msg.textContent = text;
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  show('جاري إنشاء الحساب...');

  const display_name = document.getElementById('display_name').value.trim();
  const username = document.getElementById('username').value.trim();
  const password = document.getElementById('password').value;

  try {
    const res = await fetch('/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ display_name, username, password })
    });

    const data = await res.json();

    if (!data.ok) {
      show(data.message || 'فشل إنشاء الحساب', 'error');
      return;
    }

    localStorage.setItem('member_token', data.token || '');
    localStorage.setItem('member_user', JSON.stringify(data.user || {}));
    show('تم إنشاء الحساب بنجاح ✅', 'ok');

    setTimeout(() => location.href = '/', 700);
  } catch (err) {
    show('حدث خطأ في الاتصال', 'error');
  }
});
