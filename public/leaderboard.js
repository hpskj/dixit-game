async function loadLeaderboard() {
  const list = document.getElementById('list');
  try {
    const res = await fetch('/api/leaderboard');
    const data = await res.json();

    if (!data.ok) {
      list.textContent = data.message || 'تعذر تحميل الترتيب';
      return;
    }

    if (!data.leaderboard.length) {
      list.textContent = 'لا يوجد لاعبين بعد.';
      return;
    }

    list.innerHTML = data.leaderboard.map((p, i) => `
      <div class="leader-row">
        <div class="rank">${i + 1}</div>
        <div>
          <b>${p.display_name || p.username}</b>
          <div style="color:rgba(255,255,255,.6);font-size:14px">@${p.username}</div>
        </div>
        <div class="score">${p.score || 0} نقطة</div>
      </div>
    `).join('');
  } catch {
    list.textContent = 'حدث خطأ في الاتصال.';
  }
}
loadLeaderboard();
