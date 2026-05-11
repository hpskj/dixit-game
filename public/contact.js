const $ = id => document.getElementById(id);
function setStatus(msg, ok=false){ const el=$('contactStatus'); el.textContent=msg; el.className=ok ? 'successText' : 'errorText'; }
async function loadContactInfo(){
  const data = await fetch('/api/contact-info').then(r=>r.json()).catch(()=>({ok:false}));
  const raw = String(data.whatsappNumber || '').replace(/[^0-9]/g, '');
  if(raw){
    const btn=$('whatsappContactBtn');
    btn.href='https://wa.me/' + raw;
    btn.classList.remove('hidden');
  }
}
$('sendContactBtn').onclick = async () => {
  const body = {
    name: $('contactName').value.trim(),
    email: $('contactEmail').value.trim(),
    message: $('contactMessage').value.trim()
  };
  const res = await fetch('/api/contact', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body) }).then(r=>r.json()).catch(()=>({ok:false,message:'فشل الاتصال'}));
  if(!res.ok) return setStatus(res.message || 'فشل إرسال الرسالة');
  $('contactMessage').value='';
  setStatus('تم إرسال رسالتك بنجاح. شكرًا لك.', true);
};
loadContactInfo();
