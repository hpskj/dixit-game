// auth-widget.js
// أضف هذا الملف في index.html قبل نهاية body:
// <script src="/auth-widget.js"></script>

(async function () {
  try {
    const res = await fetch('/api/auth/me');
    const data = await res.json();

    const bar = document.createElement('div');
    bar.style.cssText = `
      position:fixed;top:14px;left:14px;z-index:9999;
      display:flex;gap:8px;align-items:center;flex-wrap:wrap;
      direction:rtl;font-family:system-ui,Tahoma;
    `;

    function link(text, href, bg='rgba(255,255,255,.14)') {
      const a = document.createElement('a');
      a.textContent = text;
      a.href = href;
      a.style.cssText = `
        text-decoration:none;color:white;background:${bg};border:1px solid rgba(255,255,255,.18);
        padding:9px 12px;border-radius:999px;backdrop-filter:blur(12px);font-weight:800;
      `;
      return a;
    }

    if (data.ok && data.user) {
      bar.appendChild(link('👤 ' + (data.user.display_name || data.user.username), '/profile.html'));
      bar.appendChild(link('🏆 الترتيب', '/leaderboard.html'));
      const logout = link('خروج', '#', 'rgba(255,79,216,.28)');
      logout.onclick = async (e) => {
        e.preventDefault();
        await fetch('/api/auth/logout', { method: 'POST' });
        localStorage.removeItem('member_token');
        localStorage.removeItem('member_user');
        location.reload();
      };
      bar.appendChild(logout);
    } else {
      bar.appendChild(link('تسجيل دخول', '/login.html', 'rgba(255,216,77,.9)'));
      bar.lastChild.style.color = '#17152c';
      bar.appendChild(link('إنشاء حساب', '/register.html'));
      bar.appendChild(link('🏆 الترتيب', '/leaderboard.html'));
    }

    document.body.appendChild(bar);
  } catch {}
})();
