window.socket = io();
const socket = window.socket;
let code = '', state = null, myHand = [], myId = null, timerInterval = null;
const $ = id => document.getElementById(id);

function toast(msg){ const t=$('toast'); t.textContent=msg; t.style.display='block'; setTimeout(()=>t.style.display='none',2600); }
function phaseName(p){ return ({lobby:'الانتظار',story:'اختيار الراوي',submit:'اختيار الكروت',voting:'التصويت',results:'النتائج',ended:'انتهت اللعبة'})[p]||p; }
function playTone(freq=440, duration=0.12, type='sine'){
  try{
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = ctx.createOscillator(); const gain = ctx.createGain();
    osc.type = type; osc.frequency.value = freq; gain.gain.value = 0.08;
    osc.connect(gain); gain.connect(ctx.destination); osc.start();
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + duration);
    osc.stop(ctx.currentTime + duration);
  }catch(e){}
}
function selectSound(){ playTone(620, .08, 'triangle'); setTimeout(()=>playTone(820,.08,'triangle'),80); }
function winSound(){ [523,659,784,1046].forEach((f,i)=>setTimeout(()=>playTone(f,.18,'sine'),i*150)); }

$('createBtn').onclick=()=>{ const name=$('name').value.trim()||'لاعب'; socket.emit('createRoom',name); };
$('joinBtn').onclick=()=>{ const name=$('name').value.trim()||'لاعب'; code=$('codeInput').value.trim().toUpperCase(); socket.emit('joinRoom',{name,code}); };
socket.on('connect',()=> myId=socket.id);
socket.on('roomCreated',c=>{ code=c; $('codeInput').value=c; toast('تم إنشاء الغرفة'); });
socket.on('errorMessage',toast);
socket.on('yourHand',hand=>{ myHand=hand; render(); });
socket.on('gameWinner',w=>{ winSound(); toast(`🏆 الفائز: ${w.name} - ${w.score} نقطة`); });
socket.on('roomState',s=>{ state=s; code=s.code; $('joinBox').classList.add('hidden'); $('gameBox').classList.remove('hidden'); render(); startTimer(); });

function startTimer(){
  clearInterval(timerInterval);
  const el=$('timerText');
  function tick(){
    if(!state?.timerEndsAt){ el.textContent='--'; return; }
    const left=Math.max(0, Math.ceil((state.timerEndsAt-Date.now())/1000));
    el.textContent=left;
    const circle=document.querySelector('.timerCircle');
    circle.classList.toggle('danger', left<=5 && left>0);
  }
  tick(); timerInterval=setInterval(tick,500);
}

function render(){ if(!state) return; $('roomCode').textContent=state.code; $('phase').textContent=phaseName(state.phase); $('round').textContent=state.round || '-'; $('players').innerHTML=state.players.map(p=>`<div class="player"><b>${p.name}</b><span>${p.score} نقطة ${p.id===state.storytellerId?'🎙️':''} ${!p.connected?'⚪':''}</span></div>`).join(''); renderActions(); renderHand(); renderTable(); }
function renderActions(){ const a=$('actions'); a.innerHTML=''; $('hintTitle').textContent='';
 if(state.phase==='lobby'){ a.innerHTML = state.hostId===myId ? '<button id="start">ابدأ اللعبة</button><p class="muted">يتم استخدام مؤقتات لوحة التحكم عند بدء اللعبة.</p>' : '<div class="phaseMsg">انتظر صاحب الغرفة يبدأ اللعبة.</div>'; const b=$('start'); if(b) b.onclick=()=>socket.emit('startGame',code); }
 if(state.phase==='story'){ if(myId===state.storytellerId){ a.innerHTML='<div class="phaseMsg">أنت الراوي: اختر كرتًا واكتب تلميحًا. الوقت الافتراضي 30 ثانية.</div><input id="hint" placeholder="اكتب التلميح هنا">'; } else a.innerHTML='<div class="phaseMsg">انتظر الراوي يختار كرتًا ويكتب التلميح.</div>'; }
 if(state.phase==='submit'){ $('hintTitle').textContent='💡 التلميح: '+state.hint; if(myId!==state.storytellerId) a.innerHTML='<div class="phaseMsg">اختر كرتًا يناسب التلميح قبل انتهاء الوقت.</div>'; else a.innerHTML='<div class="phaseMsg">انتظر اللاعبين يختارون كروتهم.</div>'; }
 if(state.phase==='voting'){ $('hintTitle').textContent='💡 التلميح: '+state.hint; a.innerHTML = myId===state.storytellerId ? '<div class="phaseMsg">الراوي لا يصوّت.</div>' : '<div class="phaseMsg">صوّت على كرت الراوي. الوقت الافتراضي 20 ثانية.</div>'; }
 if(state.phase==='results'){ a.innerHTML = state.hostId===myId ? '<button id="next">الجولة التالية</button>' : '<div class="phaseMsg">انتظر الجولة التالية.</div>'; const n=$('next'); if(n) n.onclick=()=>socket.emit('nextRound',code); }
 if(state.phase==='ended'){ const winner=state.lastWinner || [...state.players].sort((a,b)=>b.score-a.score)[0]; a.innerHTML=`<div class="winner">🏆<br>الفائز<br><strong>${winner.name}</strong><br>${winner.score} نقطة</div>`; }
}
function cardHtml(c, extra='', showDetails=false){
  const voters = (c.voters && c.voters.length) ? c.voters.join('، ') : 'لا أحد';
  const details = showDetails ? `
    <div class="cardDetails">
      <div class="ownerLine">${c.isStorytellerCard ? '🎙️ كرت الراوي' : '🎴 كرت اللاعب'}: <b>${c.ownerName || '-'}</b></div>
      <div class="votersLine">🗳️ اختاروا هذا الكرت: <b>${voters}</b></div>
    </div>` : '';
  return `<div class="gameCard ${showDetails ? 'resultCard' : ''}" ${extra}><div class="imgWrap"><img src="${c.image}" alt=""></div><p>${c.title||''}</p>${details}</div>`;
}
function renderHand(){ const h=$('hand'); h.innerHTML=''; if(['story','submit'].includes(state.phase)){ myHand.forEach(c=>{ let extra=''; if(state.phase==='story' && myId===state.storytellerId) extra=`onclick="submitStory('${c.id}')"`; if(state.phase==='submit' && myId!==state.storytellerId) extra=`onclick="submitCard('${c.id}')"`; h.innerHTML += cardHtml(c,extra); }); } }
function renderTable(){
  const t=$('table'); t.innerHTML='';
  if(['voting','results','ended'].includes(state.phase)){
    state.tableCards.forEach(c=>{
      const extra = state.phase==='voting' && myId!==state.storytellerId ? `onclick="vote('${c.id}')"` : '';
      const showDetails = ['results','ended'].includes(state.phase);
      t.innerHTML += cardHtml(c, extra, showDetails);
    });
  }
}
window.submitStory=(cardId)=>{ const hint=$('hint')?.value.trim(); if(!hint) return toast('اكتب التلميح أولاً'); selectSound(); socket.emit('storySubmit',{code,cardId,hint}); };
window.submitCard=(cardId)=>{ selectSound(); socket.emit('submitCard',{code,cardId}); };
window.vote=(tableId)=>{ selectSound(); socket.emit('vote',{code,tableId}); };
