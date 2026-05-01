fetch('/api/admin/check').then(r=>r.json()).then(d=>{ if(!d.ok) location.href='/admin-login.html'; });
const $ = id => document.getElementById(id);
function toast(msg){ const t=$('toast'); t.textContent=msg; t.style.display='block'; setTimeout(()=>t.style.display='none',2500); }
async function loadSettings(){ const s=await fetch('/api/settings').then(r=>r.json()); $('selectTimer').value=s.selectTimer; $('voteTimer').value=s.voteTimer; }
$('saveSettings').onclick=async()=>{ const body={selectTimer:$('selectTimer').value, voteTimer:$('voteTimer').value}; await fetch('/api/settings',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}); toast('تم حفظ المؤقتات'); };

async function loadCards(){
  const cards=await fetch('/api/cards').then(r=>r.json());
  $('cardsList').innerHTML=cards.map(c=>`<div class="gameCard"><div class="imgWrap"><img src="${c.image}"></div><p>${c.title}</p><button class="danger" onclick="delCard('${c.id}')">حذف نهائي</button></div>`).join('');
}

async function loadRooms(){
  const data = await fetch('/api/admin/room-templates').then(r=>r.json());
  const rooms = data.rooms || [];
  $('roomsAdminList').innerHTML = rooms.length ? rooms.map(room => `
    <article class="adminRoomCard">
      <div class="roomAdminHead">
        <div>
          <h3>${room.name}</h3>
          <p class="muted">${room.category || 'بدون فئة'} — ${room.cardCount || 0} صورة</p>
          ${room.description ? `<p>${room.description}</p>` : ''}
        </div>
        <button class="danger" onclick="deleteRoom('${room.id}')">حذف الغرفة</button>
      </div>
      <div class="uploadLine">
        <input id="files_${room.id}" type="file" accept="image/*" multiple>
        <button onclick="uploadRoomImages('${room.id}')">رفع صور لهذه الغرفة</button>
      </div>
      <div class="cardsGrid smallCards">
        ${(room.cards || []).map(c => `
          <div class="gameCard">
            <div class="imgWrap"><img src="${c.image}"></div>
            <p>${c.title}</p>
            <button class="danger" onclick="removeRoomCard('${room.id}','${c.id}')">إزالة من الغرفة</button>
          </div>
        `).join('') || '<p class="muted">لا توجد صور في هذه الغرفة بعد.</p>'}
      </div>
    </article>
  `).join('') : '<p class="muted">لا توجد غرف بعد.</p>';
}

$('addRoom').onclick = async () => {
  const body = {
    name: $('roomName').value.trim(),
    category: $('roomCategory').value.trim(),
    description: $('roomDescription').value.trim()
  };
  if (!body.name) return toast('اكتب اسم الغرفة');
  const res = await fetch('/api/admin/room-templates', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body) }).then(r=>r.json());
  if (!res.ok) return toast(res.message || 'فشل إنشاء الغرفة');
  $('roomName').value = ''; $('roomCategory').value = ''; $('roomDescription').value = '';
  toast('تم إنشاء الغرفة');
  await loadRooms();
};

window.uploadRoomImages = async (roomId) => {
  const input = $(`files_${roomId}`);
  const files = input.files;
  if (!files.length) return toast('اختر صوراً أولاً');
  const fd = new FormData();
  [...files].forEach(f => fd.append('images', f));
  const res = await fetch(`/api/admin/room-templates/${roomId}/cards`, { method:'POST', body: fd }).then(r=>r.json());
  if (!res.ok) return toast(res.message || 'فشل الرفع');
  input.value = '';
  toast(`تم رفع ${res.added.length} صورة`);
  await loadRooms();
  await loadCards();
};

window.removeRoomCard = async (roomId, cardId) => {
  await fetch(`/api/admin/room-templates/${roomId}/cards/${cardId}`, { method:'DELETE' });
  await loadRooms();
};

window.deleteRoom = async (roomId) => {
  if (!confirm('حذف الغرفة؟ الصور ستبقى في النظام لكن لن تظهر ضمن هذه الغرفة.')) return;
  await fetch(`/api/admin/room-templates/${roomId}`, { method:'DELETE' });
  await loadRooms();
};

window.delCard=async(id)=>{ if(!confirm('حذف هذه الصورة نهائياً من النظام؟')) return; await fetch('/api/cards/'+id,{method:'DELETE'}); await loadCards(); await loadRooms(); };

loadSettings(); loadRooms(); loadCards();
$('logoutBtn').onclick = async () => { await fetch('/api/admin/logout', {method:'POST'}); location.href='/admin-login.html'; };
