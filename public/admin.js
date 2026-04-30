fetch('/api/admin/check').then(r=>r.json()).then(d=>{ if(!d.ok) location.href='/admin-login.html'; });
const $ = id => document.getElementById(id);
function toast(msg){ const t=$('toast'); t.textContent=msg; t.style.display='block'; setTimeout(()=>t.style.display='none',2500); }
async function loadSettings(){ const s=await fetch('/api/settings').then(r=>r.json()); $('selectTimer').value=s.selectTimer; $('voteTimer').value=s.voteTimer; }
$('saveSettings').onclick=async()=>{ const body={selectTimer:$('selectTimer').value, voteTimer:$('voteTimer').value}; await fetch('/api/settings',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}); toast('تم حفظ المؤقتات'); };
async function loadCards(){ const cards=await fetch('/api/cards').then(r=>r.json()); $('cardsList').innerHTML=cards.map(c=>`<div class="gameCard"><div class="imgWrap"><img src="${c.image}"></div><p>${c.title}</p><button class="danger" onclick="delCard('${c.id}')">حذف</button></div>`).join(''); }
$('addSingle').onclick=async()=>{ const f=$('singleImage').files[0]; if(!f) return toast('اختر صورة'); const fd=new FormData(); fd.append('title',$('singleTitle').value||f.name); fd.append('image',f); await fetch('/api/cards',{method:'POST',body:fd}); $('singleTitle').value=''; $('singleImage').value=''; toast('تمت الإضافة'); loadCards(); };
$('addBulk').onclick=async()=>{ const files=$('bulkImages').files; if(!files.length) return toast('اختر صور'); const fd=new FormData(); [...files].forEach(f=>fd.append('images',f)); const res=await fetch('/api/cards/bulk',{method:'POST',body:fd}).then(r=>r.json()); $('bulkImages').value=''; toast(`تم رفع ${res.added.length} كرت`); loadCards(); };
window.delCard=async(id)=>{ if(!confirm('حذف هذا الكرت؟')) return; await fetch('/api/cards/'+id,{method:'DELETE'}); loadCards(); };
loadSettings(); loadCards();

$('logoutBtn').onclick = async () => { await fetch('/api/admin/logout', {method:'POST'}); location.href='/admin-login.html'; };
