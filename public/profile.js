async function loadProfile() {
  const box = document.getElementById('profile');

  try {
    const params = new URLSearchParams(location.search);
    const username = params.get('user');

    let url = '/api/auth/me';
    if (username) url = '/api/profile/' + encodeURIComponent(username);

    const res = await fetch(url);
    const data = await res.json();

    const user = data.user || data.profile;

    if (!data.ok || !user) {
      box.innerHTML = `
        <h1>لم يتم العثور على اللاعب</h1>
        <p class="sub">سجل دخولك أو افتح بروفايل لاعب صحيح.</p>
        <a class="btn" href="/login.html">تسجيل الدخول</a>
      `;
      return;
    }

    const letter = (user.display_name || user.username || '?').trim()[0] || '?';

    box.innerHTML = `
      <div class="profile-card">
        <div class="avatar">${letter}</div>
        <div>
          <h1>${user.display_name || user.username}</h1>
          <p class="sub">@${user.username}</p>
          <div class="features" style="margin-top:10px">
            <div class="feature"><b>🏆 النقاط</b><span>${user.score || 0} نقطة</span></div>
            <div class="feature"><b>👑 مرات الفوز</b><span>${user.wins || 0}</span></div>
            <div class="feature"><b>🎮 عدد الألعاب</b><span>${user.games_played || 0}</span></div>
            <div class="feature"><b>📅 عضو منذ</b><span>${new Date(user.created_at).toLocaleDateString('ar-KW')}</span></div>
          </div>
          <br>
          <a class="btn secondary" href="/leaderboard.html">عرض ترتيب اللاعبين</a>
          <br><br>
          <a class="btn secondary" href="/matches.html">آخر المباريات</a>
        </div>
      </div>
    `;
  } catch {
    box.textContent = 'حدث خطأ في الاتصال.';
  }
}
loadProfile();
