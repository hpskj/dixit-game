async function loadMatches() {
  const box = document.getElementById('matches');
  try {
    const res = await fetch('/api/matches');
    const data = await res.json();

    if (!data.ok) {
      box.textContent = data.message || 'تعذر تحميل آخر المباريات';
      return;
    }

    if (!data.matches.length) {
      box.textContent = 'لا توجد مباريات محفوظة حتى الآن.';
      return;
    }

    box.innerHTML = data.matches.map(m => {
      const date = new Date(m.created_at).toLocaleString('ar-KW');
      const players = (m.players || [])
        .sort((a,b) => (b.score || 0) - (a.score || 0))
        .map(p => `<span style="display:inline-block;margin:4px;padding:7px 10px;border-radius:999px;background:rgba(255,255,255,.10)">${p.name}: ${p.score}</span>`)
        .join('');

      return `
        <div class="leader-row" style="grid-template-columns:1fr">
          <div>
            <b>🏆 الفائز: ${m.winner_name}</b>
            <div style="color:rgba(255,255,255,.65);font-size:14px">الغرفة: ${m.room_code || '-'} — ${date}</div>
            <div style="margin-top:8px">${players}</div>
          </div>
        </div>
      `;
    }).join('');
  } catch {
    box.textContent = 'حدث خطأ في الاتصال.';
  }
}
loadMatches();
