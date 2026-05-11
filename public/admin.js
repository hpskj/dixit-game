fetch('/api/admin/check').then(r=>r.json()).then(d=>{ if(!d.ok) location.href='/admin-login.html'; });
const $ = id => document.getElementById(id);
function toast(msg){ const t=$('toast'); t.textContent=msg; t.style.display='block'; setTimeout(()=>t.style.display='none',2500); }
function setText(id, value){ const el=$(id); if(el) el.textContent=value; }
function numVal(id, fallback){ const el=$(id); const n=Number(el?.value); return Number.isFinite(n) ? n : fallback; }

function showAdminSection(name){
  document.querySelectorAll('.adminTab').forEach(btn => btn.classList.toggle('active', btn.dataset.adminTab === name));
  document.querySelectorAll('.adminSection').forEach(sec => sec.classList.toggle('active', sec.dataset.adminSection === name));
  localStorage.setItem('adminActiveSection', name);
  window.scrollTo({ top: 0, behavior: 'smooth' });
}
function bindAdminTabs(){
  document.querySelectorAll('[data-admin-tab]').forEach(btn => {
    btn.addEventListener('click', () => showAdminSection(btn.dataset.adminTab));
  });
  document.addEventListener('click', (event) => {
    const jump = event.target.closest('[data-admin-tab-jump]');
    if (jump) showAdminSection(jump.dataset.adminTabJump);
  });
  const saved = localStorage.getItem('adminActiveSection') || 'dashboard';
  showAdminSection(saved);
}
function updateAdminStat(id, value){ const el=$(id); if(el) el.textContent=value; }
async function refreshAdminDashboard(){
  await Promise.allSettled([loadSettings(), loadRooms(), loadCards(), loadPlayers()]);
  toast('تم تحديث الملخص');
}
window.refreshAdminDashboard = refreshAdminDashboard;
async function loadSettings(){
  const s=await fetch('/api/settings').then(r=>r.json());
  if($('storyTimer')) $('storyTimer').value=s.storyTimer ?? s.selectTimer ?? 45;
  if($('submitTimer')) $('submitTimer').value=s.submitTimer ?? s.selectTimer ?? 45;
  if($('voteTimer')) $('voteTimer').value=s.voteTimer ?? 45;
  if($('resultsTimer')) $('resultsTimer').value=s.resultsTimer ?? 45;
  if($('aiEnabled')) $('aiEnabled').checked=!!s.aiEnabled;
  if($('aiMonthlyLimit')) $('aiMonthlyLimit').value=s.aiMonthlyLimit ?? 0;
  if($('whatsappNumber')) $('whatsappNumber').value=s.whatsappNumber || '';
  const usage=s.aiUsage || {};
  setText('aiStatus', s.aiEnabled ? (s.hasOpenAiKey ? 'مفعّل' : 'مفعّل لكن مفتاح OPENAI_API_KEY غير موجود') : 'متوقف');
  setText('aiUsageMonth', usage.month || '—');
  setText('aiUsageRequests', usage.requests || 0);
  setText('aiUsageSuccesses', usage.successes || 0);
  setText('aiUsageFailures', usage.failures || 0);
  updateAdminStat('statAi', s.aiEnabled ? 'ON' : 'OFF');
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
  updateAdminStat('statImages', Array.isArray(cards) ? cards.length : 0);
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
  updateAdminStat('statRooms', rooms.length);
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

bindAdminTabs();
loadSettings(); loadRooms(); loadCards();
$('logoutBtn').onclick = async () => { await fetch('/api/admin/logout', {method:'POST'}); location.href='/admin-login.html'; };

// ================= إدارة اللاعبين =================
function escHtml(value){
  return String(value ?? '').replace(/[&<>'"]/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[ch]));
}
async function loadPlayers(){
  const box = $('playersAdminList');
  if (!box) return;
  const q = $('playersSearch')?.value?.trim() || '';
  box.innerHTML = '<p class="muted">جاري تحميل اللاعبين...</p>';
  const data = await fetch('/api/admin/members?q=' + encodeURIComponent(q)).then(r=>r.json()).catch(()=>({ok:false,message:'فشل الاتصال'}));
  if(!data.ok){ box.innerHTML = `<p class="errorText">${escHtml(data.message || 'فشل تحميل اللاعبين')}</p>`; return; }
  const members = data.members || [];
  updateAdminStat('statPlayers', members.length);
  if(!members.length){ box.innerHTML = '<p class="muted">لا يوجد لاعبون.</p>'; return; }
  box.innerHTML = members.map(m => `
    <article class="playerAdminCard" data-id="${escHtml(m.id)}">
      <div class="playerHead">
        <div>
          <h3>${escHtml(m.display_name || m.username)} ${m.status === 'banned' ? '<span class="banBadge">موقوف</span>' : ''}</h3>
          <p class="muted">@${escHtml(m.username)} — ${escHtml(m.email || 'بدون إيميل')}</p>
          <p class="muted">تاريخ التسجيل: ${m.created_at ? new Date(m.created_at).toLocaleString('ar') : '—'}</p>
        </div>
        <button class="danger smallBtn" onclick="deletePlayer('${escHtml(m.id)}')">حذف اللاعب</button>
      </div>
      <div class="playersFormGrid editGrid">
        <label>اسم العرض<input id="display_${escHtml(m.id)}" value="${escHtml(m.display_name || '')}"></label>
        <label>اليوزر<input id="username_${escHtml(m.id)}" value="${escHtml(m.username || '')}"></label>
        <label>الإيميل<input id="email_${escHtml(m.id)}" type="email" value="${escHtml(m.email || '')}"></label>
        <label>رابط الصورة<input id="avatar_${escHtml(m.id)}" value="${escHtml(m.avatar_url || '')}"></label>
        <label>النقاط<input id="score_${escHtml(m.id)}" type="number" min="0" value="${Number(m.score || 0)}"></label>
        <label>الفوز<input id="wins_${escHtml(m.id)}" type="number" min="0" value="${Number(m.wins || 0)}"></label>
        <label>المباريات<input id="games_${escHtml(m.id)}" type="number" min="0" value="${Number(m.games_played || 0)}"></label>
        <label>الحالة<select id="status_${escHtml(m.id)}"><option value="active" ${m.status !== 'banned' ? 'selected' : ''}>نشط</option><option value="banned" ${m.status === 'banned' ? 'selected' : ''}>موقوف</option></select></label>
      </div>
      <div class="rowActions playerActions">
        <button class="smallBtn" onclick="savePlayer('${escHtml(m.id)}')">حفظ بيانات اللاعب</button>
        <input id="pass_${escHtml(m.id)}" type="password" placeholder="باسوورد جديد">
        <button class="smallBtn" onclick="resetPlayerPassword('${escHtml(m.id)}')">تغيير الباسوورد</button>
      </div>
    </article>
  `).join('');
}

window.savePlayer = async (id) => {
  const body = {
    display_name: $(`display_${id}`).value.trim(),
    username: $(`username_${id}`).value.trim(),
    email: $(`email_${id}`).value.trim(),
    avatar_url: $(`avatar_${id}`).value.trim(),
    score: Number($(`score_${id}`).value || 0),
    wins: Number($(`wins_${id}`).value || 0),
    games_played: Number($(`games_${id}`).value || 0),
    status: $(`status_${id}`).value
  };
  const res = await fetch('/api/admin/members/' + encodeURIComponent(id), { method:'PUT', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body) }).then(r=>r.json()).catch(()=>({ok:false,message:'فشل الاتصال'}));
  if(!res.ok) return toast(res.message || 'فشل حفظ بيانات اللاعب');
  toast('تم حفظ بيانات اللاعب');
  await loadPlayers();
};

window.resetPlayerPassword = async (id) => {
  const password = $(`pass_${id}`).value;
  if(!password || password.length < 6) return toast('اكتب باسوورد جديد 6 أحرف على الأقل');
  if(!confirm('تغيير باسوورد هذا اللاعب؟')) return;
  const res = await fetch('/api/admin/members/' + encodeURIComponent(id) + '/password', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({password}) }).then(r=>r.json()).catch(()=>({ok:false,message:'فشل الاتصال'}));
  if(!res.ok) return toast(res.message || 'فشل تغيير الباسوورد');
  toast('تم تغيير الباسوورد');
  $(`pass_${id}`).value = '';
};

window.deletePlayer = async (id) => {
  if(!confirm('حذف اللاعب نهائياً؟ هذا الإجراء لا يمكن التراجع عنه.')) return;
  const res = await fetch('/api/admin/members/' + encodeURIComponent(id), { method:'DELETE' }).then(r=>r.json()).catch(()=>({ok:false,message:'فشل الاتصال'}));
  if(!res.ok) return toast(res.message || 'فشل حذف اللاعب');
  toast('تم حذف اللاعب');
  await loadPlayers();
};

async function createPlayerFromAdmin(){
  const body = {
    display_name: $('newPlayerDisplay').value.trim(),
    username: $('newPlayerUsername').value.trim(),
    email: $('newPlayerEmail').value.trim(),
    password: $('newPlayerPassword').value
  };
  const res = await fetch('/api/admin/members', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body) }).then(r=>r.json()).catch(()=>({ok:false,message:'فشل الاتصال'}));
  if(!res.ok) return toast(res.message || 'فشل إضافة اللاعب');
  ['newPlayerDisplay','newPlayerUsername','newPlayerEmail','newPlayerPassword'].forEach(id => { if($(id)) $(id).value=''; });
  toast('تم إضافة اللاعب');
  await loadPlayers();
}

if($('createPlayerBtn')) $('createPlayerBtn').onclick = createPlayerFromAdmin;
if($('playersSearchBtn')) $('playersSearchBtn').onclick = loadPlayers;
if($('playersReloadBtn')) $('playersReloadBtn').onclick = loadPlayers;
if($('playersSearch')) $('playersSearch').addEventListener('keydown', e => { if(e.key === 'Enter') loadPlayers(); });
loadPlayers();

// ===== رسائل تواصل معنا =====
function fmtDate(value){ try { return new Date(value).toLocaleString('ar-KW'); } catch { return value || '—'; } }
async function loadContactMessages(){
  const box = $('contactMessagesList');
  if(!box) return;
  box.innerHTML = '<p class="muted">جاري تحميل الرسائل...</p>';
  const status = $('messagesFilter')?.value || '';
  const data = await fetch('/api/admin/contact-messages' + (status ? '?status=' + encodeURIComponent(status) : '')).then(r=>r.json()).catch(()=>({ok:false,message:'فشل الاتصال'}));
  if(!data.ok){ box.innerHTML = `<p class="errorText">${escHtml(data.message || 'فشل تحميل الرسائل')}</p>`; return; }
  const messages = data.messages || [];
  updateAdminStat('statMessages', messages.filter(m => m.status === 'new').length);
  if(!messages.length){ box.innerHTML = '<p class="muted">لا توجد رسائل.</p>'; return; }
  box.innerHTML = messages.map(m => `
    <div class="playerAdminCard ${m.status === 'new' ? 'unreadMessage' : ''}">
      <div class="playerAdminHead">
        <div><strong>${escHtml(m.name || 'لاعب')}</strong><span>${escHtml(m.email || '')}</span></div>
        <span class="pill">${m.status === 'new' ? 'جديدة' : 'مقروءة'}</span>
      </div>
      <p class="messageBody">${escHtml(m.message || '')}</p>
      <p class="muted">${fmtDate(m.created_at)}</p>
      <div class="rowActions">
        <button class="smallBtn" onclick="markContactMessageRead('${m.id}')">تحديد كمقروءة</button>
        <button class="danger smallBtn" onclick="deleteContactMessage('${m.id}')">حذف</button>
      </div>
    </div>
  `).join('');
}
async function markContactMessageRead(id){
  const res = await fetch('/api/admin/contact-messages/' + encodeURIComponent(id) + '/read', { method:'POST' }).then(r=>r.json()).catch(()=>({ok:false}));
  if(!res.ok) return toast('فشل تحديث الرسالة');
  await loadContactMessages();
}
async function deleteContactMessage(id){
  if(!confirm('حذف هذه الرسالة؟')) return;
  const res = await fetch('/api/admin/contact-messages/' + encodeURIComponent(id), { method:'DELETE' }).then(r=>r.json()).catch(()=>({ok:false}));
  if(!res.ok) return toast('فشل حذف الرسالة');
  await loadContactMessages();
}
window.loadContactMessages = loadContactMessages;
window.markContactMessageRead = markContactMessageRead;
window.deleteContactMessage = deleteContactMessage;
if($('messagesReloadBtn')) $('messagesReloadBtn').onclick = loadContactMessages;
if($('messagesFilterBtn')) $('messagesFilterBtn').onclick = loadContactMessages;

// أزرار إضافية لإعدادات AI والتواصل
async function saveAllSettings(extraToast){
  const body={
    storyTimer:numVal('storyTimer',45),
    submitTimer:numVal('submitTimer',45),
    voteTimer:numVal('voteTimer',45),
    resultsTimer:numVal('resultsTimer',45),
    aiEnabled:!!$('aiEnabled')?.checked,
    aiMonthlyLimit:numVal('aiMonthlyLimit',0),
    whatsappNumber:$('whatsappNumber')?.value?.trim() || ''
  };
  const res=await fetch('/api/settings',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}).then(r=>r.json()).catch(()=>({ok:false,message:'فشل الاتصال'}));
  if(!res.ok) return toast(res.message || 'فشل حفظ الإعدادات');
  toast(extraToast || 'تم حفظ الإعدادات');
  await loadSettings();
}
if($('saveAiSettings')) $('saveAiSettings').onclick=()=>saveAllSettings('تم حفظ إعدادات AI');
if($('saveContactSettings')) $('saveContactSettings').onclick=()=>saveAllSettings('تم حفظ إعدادات التواصل');
if($('testAiConnection')) $('testAiConnection').onclick=async()=>{
  await saveAllSettings('تم حفظ إعدادات AI');
  const res=await fetch('/api/settings/ai-test').then(r=>r.json()).catch(()=>({ok:false,message:'فشل الاتصال'}));
  toast(res.message || (res.ok ? 'AI جاهز' : 'AI غير جاهز'));
};

// تحميل الرسائل عند فتح تبويبها
const _oldShowAdminSection = window.showAdminSection;
if (typeof showAdminSection === 'function') {
  const originalShow = showAdminSection;
  window.showAdminSection = function(name){
    originalShow(name);
    if(name === 'messages') loadContactMessages();
  };
}
document.querySelectorAll('[data-admin-tab="messages"],[data-admin-tab-jump="messages"]').forEach(el => {
  el.addEventListener('click', () => setTimeout(loadContactMessages, 150));
});
// حمّل عدد الرسائل الجديدة للملخص بدون فتح التبويب
loadContactMessages().catch(()=>{});
