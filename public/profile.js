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
    const avatar = user.avatar_url
      ? `<img src="${user.avatar_url}" style="width:90px;height:90px;border-radius:28px;object-fit:cover" alt="avatar">`
      : `<div class="avatar">${letter}</div>`;

    const isMe = !username;

    box.innerHTML = `
      <div class="profile-card">
        ${avatar}
        <div>
          <h1>${user.display_name || user.username}</h1>
          <p class="sub">@${user.username}</p>
          <div class="features" style="margin-top:10px">
            <div class="feature"><b>🏆 النقاط</b><span>${user.score || 0} نقطة</span></div>
            <div class="feature"><b>👑 مرات الفوز</b><span>${user.wins || 0}</span></div>
            <div class="feature"><b>🎮 عدد الألعاب</b><span>${user.games_played || 0}</span></div>
            <div class="feature"><b>📅 عضو منذ</b><span>${new Date(user.created_at).toLocaleDateString('ar-KW')}</span></div>
          </div>

          ${isMe ? `
          <div style="margin-top:18px;padding:16px;border-radius:20px;background:rgba(255,255,255,.08);border:1px solid rgba(255,255,255,.12)">
            <b>🖼️ صورة البروفايل</b>
            <p class="sub" style="margin:8px 0">ارفع صورة مربعة أو قريبة من المربع.</p>
            <input id="avatarInput" type="file" accept="image/*">
            <br><br>
            <button class="btn" onclick="uploadAvatar()">رفع الصورة</button>
            <div id="avatarMsg" class="message"></div>
          </div>` : ''}

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

async function uploadAvatar() {
  const input = document.getElementById('avatarInput');
  const msg = document.getElementById('avatarMsg');
  const file = input?.files?.[0];

  if (!file) {
    msg.textContent = 'اختر صورة أولاً';
    msg.className = 'message error';
    return;
  }

  const form = new FormData();
  form.append('avatar', file);

  msg.textContent = 'جاري الرفع...';
  msg.className = 'message';

  try {
    const res = await fetch('/api/profile/avatar', {
      method: 'POST',
      body: form
    });
    const data = await res.json();

    if (!data.ok) {
      msg.textContent = data.message || 'فشل الرفع';
      msg.className = 'message error';
      return;
    }

    localStorage.setItem('member_user', JSON.stringify(data.user || {}));
    msg.textContent = 'تم رفع الصورة ✅';
    msg.className = 'message ok';
    setTimeout(() => location.reload(), 700);
  } catch {
    msg.textContent = 'حدث خطأ في الاتصال';
    msg.className = 'message error';
  }
}

loadProfile();
