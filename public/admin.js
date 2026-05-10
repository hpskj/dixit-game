fetch('/api/admin/check').then(r=>r.json()).then(d=>{ if(!d.ok) location.href='/admin-login.html'; });
const $ = id => document.getElementById(id);
function toast(msg){ const t=$('toast'); t.textContent=msg; t.style.display='block'; setTimeout(()=>t.style.display='none',2500); }
function setText(id, value){ const el=$(id); if(el) el.textContent=value; }
function numVal(id, fallback){ const el=$(id); const n=Number(el?.value); return Number.isFinite(n) ? n : fallback; }
async function loadSettings(){
  const s=await fetch('/api/settings').then(r=>r.json());
  if($('storyTimer')) $('storyTimer').value=s.storyTimer ?? s.selectTimer ?? 45;
  if($('submitTimer')) $('submitTimer').value=s.submitTimer ?? s.selectTimer ?? 45;
  if($('voteTimer')) $('voteTimer').value=s.voteTimer ?? 45;
  if($('resultsTimer')) $('resultsTimer').value=s.resultsTimer ?? 45;
  if($('aiEnabled')) $('aiEnabled').checked=!!s.aiEnabled;
  if($('aiMonthlyLimit')) $('aiMonthlyLimit').value=s.aiMonthlyLimit ?? 0;
  const usage=s.aiUsage || {};
  setText('aiStatus', s.aiEnabled ? (s.hasOpenAiKey ? 'مفعّل' : 'مفعّل لكن مفتاح OPENAI_API_KEY غير موجود') : 'متوقف');
  setText('aiUsageMonth', usage.month || '—');
  setText('aiUsageRequests', usage.requests || 0);
  setText('aiUsageSuccesses', usage.successes || 0);
  setText('aiUsageFailures', usage.failures || 0);
}
$('saveSettings').onclick=async()=>{
  const body={
    storyTimer:numVal('storyTimer',45),
    submitTimer:numVal('submitTimer',45),
    voteTimer:numVal('voteTimer',45),
    resultsTimer:numVal('resultsTimer',45),
    aiEnabled:!!$('aiEnabled')?.checked,
    aiMonthlyLimit:numVal('aiMonthlyLimit',0)
  };
  const res=await fetch('/api/settings',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}).then(r=>r.json());
  if(!res.ok) return toast(res.message || 'فشل حفظ الإعدادات');
  toast('تم حفظ الإعدادات');
  await loadSettings();
};
if($('resetAiUsage')) $('resetAiUsage').onclick=async()=>{
  if(!confirm('تصفير عداد استخدام AI لهذا الشهر؟')) return;
  const res=await fetch('/api/settings/ai-usage/reset',{method:'POST'}).then(r=>r.json()).catch(()=>({ok:false}));
  if(!res.ok) return toast('فشل تصفير العداد');
  toast('تم تصفير عداد AI');
  await loadSettings();
};

async function loadCards(){
  const cards=await fetch('/api/cards').then(r=>r.json());
  $('cardsList').innerHTML = `
    <div class="globalBulkActions">
      <button class="smallBtn" onclick="selectAllGlobalCards(true)">تحديد الكل</button>
      <button class="smallBtn" onclick="selectAllGlobalCards(false)">إلغاء التحديد</button>
      <button class="danger smallBtn" onclick="deleteSelectedGlobalCards()">حذف المحدد نهائياً</button>
      <span class="muted" id="globalSelectedCount">0 محددة</span>
    </div>
    ${cards.map(c=>`
      <div class="gameCard selectableCard">
        <label class="selectImageBox">
          <input type="checkbox" class="globalCardCheck" value="${c.id}">
          <span>تحديد</span>
        </label>
        <div class="imgWrap"><img src="${c.image}"></div>
        <p>${c.title}</p>
        <button class="danger" onclick="delCard('${c.id}')">حذف نهائي</button>
      </div>
    `).join('')}
  `;
}

async function loadRooms(){
  const data = await fetch('/api/admin/room-templates').then(r=>r.json());
  const rooms = data.rooms || [];
  $('roomsAdminList').innerHTML = rooms.length ? rooms.map(room => {
    const cards = room.cards || [];
    const coverImage = room.coverImage || room.cover_image || '';
    const cardsHtml = cards.length ? cards.map(c => {
      const isCover = coverImage && c.image === coverImage;
      return `
      <div class="gameCard selectableCard ${isCover ? 'coverSelectedCard' : ''}">
        <label class="selectImageBox">
          <input type="checkbox" class="roomImageCheck" data-room-id="${room.id}" value="${c.id}">
          <span>تحديد</span>
        </label>
        <div class="imgWrap">
          ${isCover ? '<span class="coverBadge">⭐ الغلاف</span>' : ''}
          <img src="${c.image}">
        </div>
        <p>${c.title}</p>
        <button class="smallBtn" onclick="setRoomCover('${room.id}', '${encodeURIComponent(c.image)}')">${isCover ? 'الغلاف الحالي' : 'تعيين كغلاف'}</button>
        <button class="danger" onclick="removeRoomCard('${room.id}','${c.id}')">إزالة من الغرفة</button>
      </div>
    `;
    }).join('') : '<p class="muted">لا توجد صور في هذه الغرفة بعد.</p>';

    return `
      <article class="adminRoomCard">
        <div class="roomAdminHead">
          <div>
            <h3>${room.name}</h3>
            <p class="muted">${room.category || 'بدون فئة'} — ${room.cardCount || 0} صورة</p>
            ${room.description ? `<p>${room.description}</p>` : ''}
            ${coverImage ? `
              <div class="currentCoverPreview">
                <img src="${coverImage}" alt="غلاف ${room.name}">
                <span>الغلاف الحالي</span>
                <button class="smallBtn" onclick="clearRoomCover('${room.id}')">إزالة الغلاف</button>
              </div>
            ` : '<p class="muted">لا يوجد غلاف مخصص — سيتم استخدام أول صورة.</p>'}
          </div>
          <button class="danger" onclick="deleteRoom('${room.id}')">حذف الغرفة</button>
        </div>
        <div class="uploadLine">
          <input id="files_${room.id}" type="file" accept="image/*" multiple>
          <button onclick="uploadRoomImages('${room.id}')">رفع صور لهذه الغرفة</button>
        </div>
        <div class="bulkImageActions">
          <button class="smallBtn" onclick="selectAllRoomImages('${room.id}', true)">تحديد الكل</button>
          <button class="smallBtn" onclick="selectAllRoomImages('${room.id}', false)">إلغاء التحديد</button>
          <button class="danger smallBtn" onclick="removeSelectedRoomCards('${room.id}')">حذف الصور المحددة</button>
          <span class="muted" id="selectedCount_${room.id}">0 محددة</span>
        </div>
        <div class="cardsGrid smallCards">
          ${cardsHtml}
        </div>
      </article>
    `;
  }).join('') : '<p class="muted">لا توجد غرف بعد.</p>';
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

window.setRoomCover = async (roomId, encodedImageUrl) => {
  const imageUrl = decodeURIComponent(encodedImageUrl);
  const res = await fetch(`/api/admin/room-templates/${roomId}/cover`, {
    method:'POST',
    headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ imageUrl })
  }).then(r=>r.json()).catch(() => ({ ok:false, message:'فشل الاتصال بالسيرفر' }));
  if (!res.ok) return toast(res.message || 'فشل تعيين الغلاف');
  toast('تم تعيين صورة الغلاف');
  await loadRooms();
};

window.clearRoomCover = async (roomId) => {
  const res = await fetch(`/api/admin/room-templates/${roomId}/cover`, { method:'DELETE' })
    .then(r=>r.json()).catch(() => ({ ok:false, message:'فشل الاتصال بالسيرفر' }));
  if (!res.ok) return toast(res.message || 'فشل إزالة الغلاف');
  toast('تم إزالة الغلاف المخصص');
  await loadRooms();
};

window.selectAllRoomImages = (roomId, checked) => {
  document.querySelectorAll(`.roomImageCheck[data-room-id="${roomId}"]`).forEach(ch => { ch.checked = checked; });
  updateSelectedCount(roomId);
};

window.updateSelectedCount = (roomId) => {
  const count = document.querySelectorAll(`.roomImageCheck[data-room-id="${roomId}"]:checked`).length;
  const el = $(`selectedCount_${roomId}`);
  if (el) el.textContent = `${count} محددة`;
};

document.addEventListener('change', (event) => {
  if (event.target && event.target.classList.contains('roomImageCheck')) {
    updateSelectedCount(event.target.dataset.roomId);
  }
  if (event.target && event.target.classList.contains('globalCardCheck')) {
    updateGlobalSelectedCount();
  }
});

window.updateGlobalSelectedCount = () => {
  const count = document.querySelectorAll('.globalCardCheck:checked').length;
  const el = $('globalSelectedCount');
  if (el) el.textContent = `${count} محددة`;
};

window.selectAllGlobalCards = (checked) => {
  document.querySelectorAll('.globalCardCheck').forEach(ch => { ch.checked = checked; });
  updateGlobalSelectedCount();
};

window.deleteSelectedGlobalCards = async () => {
  const selectedIds = [...document.querySelectorAll('.globalCardCheck:checked')].map(ch => ch.value);
  if (!selectedIds.length) return toast('اختر صورة واحدة على الأقل');
  if (!confirm(`حذف ${selectedIds.length} صورة نهائياً من النظام؟ سيتم حذفها أيضاً من أي غرفة تستخدمها.`)) return;

  const res = await fetch('/api/cards/bulk-delete', {
    method:'POST',
    headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ cardIds: selectedIds })
  }).then(r=>r.json()).catch(() => ({ ok:false, message:'فشل الاتصال بالسيرفر' }));

  if (!res.ok) return toast(res.message || 'فشل حذف الصور المحددة');
  toast(`تم حذف ${res.deleted || selectedIds.length} صورة نهائياً`);
  await loadCards();
  await loadRooms();
};

window.removeSelectedRoomCards = async (roomId) => {
  const selectedIds = [...document.querySelectorAll(`.roomImageCheck[data-room-id="${roomId}"]:checked`)].map(ch => ch.value);
  if (!selectedIds.length) return toast('اختر صورة واحدة على الأقل');
  if (!confirm(`حذف ${selectedIds.length} صورة من هذه الغرفة؟`)) return;

  const res = await fetch(`/api/admin/room-templates/${roomId}/cards/bulk-delete`, {
    method:'POST',
    headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ cardIds: selectedIds })
  }).then(r=>r.json()).catch(() => ({ ok:false, message:'فشل الاتصال بالسيرفر' }));

  if (!res.ok) return toast(res.message || 'فشل حذف الصور المحددة');
  toast(`تم حذف ${res.removed || selectedIds.length} صورة`);
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
