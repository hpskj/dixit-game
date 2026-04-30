const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const multer = require('multer');
const fs = require('fs');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, 'data', 'cards.json');
const SETTINGS_FILE = path.join(__dirname, 'data', 'settings.json');
const UPLOAD_DIR = path.join(__dirname, 'public', 'uploads');
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'Fofoin7ob';
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || ('admin-' + Math.random().toString(36).slice(2) + Date.now().toString(36));

app.use(express.json());

function getCookie(req, name) {
  const cookie = req.headers.cookie || '';
  return cookie.split(';').map(v => v.trim()).find(v => v.startsWith(name + '='))?.split('=').slice(1).join('=');
}
function isAdmin(req) { return getCookie(req, 'admin_token') === ADMIN_TOKEN; }
function requireAdmin(req, res, next) {
  if (!isAdmin(req)) return res.status(401).json({ ok: false, message: 'غير مصرح. سجّل الدخول كأدمن أولاً.' });
  next();
}

// حماية ملفات لوحة التحكم: لا تظهر إلا بعد تسجيل الدخول
app.use((req, res, next) => {
  if (req.path === "/admin.html" || req.path === "/admin.js") {
    res.setHeader("Cache-Control", "no-store");
  }
  next();
});

app.get('/admin.html', (req, res) => {
  if (!isAdmin(req)) return res.redirect('/admin-login.html');
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});
app.get('/admin.js', (req, res) => {
  if (!isAdmin(req)) return res.status(403).type('text/plain').send('Forbidden');
  res.sendFile(path.join(__dirname, 'public', 'admin.js'));
});
app.post('/api/admin/login', (req, res) => {
  const password = String(req.body.password || '');
  if (password !== ADMIN_PASSWORD) return res.status(401).json({ ok: false, message: 'كلمة المرور غير صحيحة' });
  res.setHeader('Set-Cookie', `admin_token=${ADMIN_TOKEN}; HttpOnly; Path=/; SameSite=Lax; Max-Age=604800`);
  res.json({ ok: true });
});
app.post('/api/admin/logout', (_, res) => {
  res.setHeader('Set-Cookie', 'admin_token=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0');
  res.json({ ok: true });
});
app.get('/api/admin/check', (req, res) => res.json({ ok: isAdmin(req) }));

app.use(express.static(path.join(__dirname, 'public')));

function readJson(file, fallback) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; } }
function writeJson(file, data) { fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8'); }
function readCards() { return readJson(DATA_FILE, []); }
function saveCards(cards) { writeJson(DATA_FILE, cards); }
function readSettings() { return { selectTimer: 30, voteTimer: 20, ...readJson(SETTINGS_FILE, {}) }; }
function saveSettings(settings) { writeJson(SETTINGS_FILE, settings); }
function makeId(prefix='id') { return prefix + Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }
function roomCode() { return Math.random().toString(36).slice(2, 6).toUpperCase(); }
function shuffle(arr) { return [...arr].sort(() => Math.random() - 0.5); }
function publicPlayer(p) { return { id: p.id, name: p.name, score: p.score, connected: p.connected }; }
function randomFrom(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

const storage = multer.diskStorage({
  destination: (_, __, cb) => cb(null, UPLOAD_DIR),
  filename: (_, file, cb) => cb(null, Date.now() + '-' + Math.random().toString(36).slice(2, 8) + path.extname(file.originalname).toLowerCase())
});
const upload = multer({ storage, fileFilter: (_, file, cb) => file.mimetype.startsWith('image/') ? cb(null, true) : cb(new Error('Images only')) });

app.get('/api/cards', (_, res) => res.json(readCards()));
app.post('/api/cards', requireAdmin, upload.single('image'), (req, res) => {
  const cards = readCards();
  const title = req.body.title || (req.file ? req.file.originalname.replace(/\.[^.]+$/, '') : 'كرت جديد');
  const card = { id: makeId('c'), title, image: req.file ? `/uploads/${req.file.filename}` : req.body.image };
  cards.push(card); saveCards(cards); res.json({ ok: true, card });
});
app.post('/api/cards/bulk', requireAdmin, upload.array('images', 200), (req, res) => {
  const cards = readCards();
  const added = (req.files || []).map(file => ({ id: makeId('c'), title: file.originalname.replace(/\.[^.]+$/, ''), image: `/uploads/${file.filename}` }));
  cards.push(...added); saveCards(cards); res.json({ ok: true, added });
});
app.delete('/api/cards/:id', requireAdmin, (req, res) => {
  let cards = readCards();
  const card = cards.find(c => c.id === req.params.id);
  cards = cards.filter(c => c.id !== req.params.id); saveCards(cards); res.json({ ok: true, deleted: card });
});
app.get('/api/settings', (_, res) => res.json(readSettings()));
app.post('/api/settings', requireAdmin, (req, res) => {
  const selectTimer = Math.max(5, Math.min(300, Number(req.body.selectTimer) || 30));
  const voteTimer = Math.max(5, Math.min(300, Number(req.body.voteTimer) || 20));
  const settings = { selectTimer, voteTimer };
  saveSettings(settings);
  res.json({ ok: true, settings });
});

const rooms = {};

function newRoom(hostId, name) {
  return {
    code: roomCode(), hostId,
    players: [{ id: hostId, name, score: 0, connected: true }],
    phase: 'lobby', round: 0, targetScore: 30, storytellerIndex: -1,
    storytellerId: null, hint: '', hands: {}, storyCardId: null,
    submissions: {}, votes: {}, tableCards: [], timerEndsAt: null, timerHandle: null,
    settings: readSettings(), lastWinner: null
  };
}
function clearTimer(room) { if (room.timerHandle) clearTimeout(room.timerHandle); room.timerHandle = null; room.timerEndsAt = null; }
function setPhaseTimer(room, seconds, onExpire) {
  clearTimer(room);
  room.timerEndsAt = Date.now() + seconds * 1000;
  room.timerHandle = setTimeout(() => { try { onExpire(); } catch (e) { console.error(e); } }, seconds * 1000 + 300);
}
function emitRoom(code) {
  const room = rooms[code]; if (!room) return;
  const showRoundDetails = ['results', 'ended'].includes(room.phase);
  io.to(code).emit('roomState', {
    code, phase: room.phase, round: room.round, targetScore: room.targetScore,
    hostId: room.hostId, storytellerId: room.storytellerId, hint: room.hint,
    players: room.players.map(publicPlayer),
    tableCards: room.tableCards.map(c => {
      const owner = room.players.find(p => p.id === c.ownerId);
      const voters = Object.entries(room.votes || {})
        .filter(([, tableId]) => tableId === c.tableId)
        .map(([pid]) => room.players.find(p => p.id === pid)?.name)
        .filter(Boolean);
      return {
        id: c.tableId, image: c.image, title: c.title,
        ownerName: showRoundDetails ? (owner?.name || 'لاعب') : null,
        voters: showRoundDetails ? voters : [],
        isStorytellerCard: showRoundDetails ? c.ownerId === room.storytellerId : false
      };
    }),
    timerEndsAt: room.timerEndsAt, settings: room.settings, lastWinner: room.lastWinner
  });
  room.players.forEach(p => io.to(p.id).emit('yourHand', room.hands[p.id] || []));
}
function ensureEnoughCards() { return readCards().length > 0; }
function deal(room) {
  const deck = shuffle(readCards());
  room.hands = {}; let i = 0;
  room.players.forEach(p => { room.hands[p.id] = []; for (let n=0;n<6;n++) room.hands[p.id].push(deck[i++ % deck.length]); });
}
function startRound(room) {
  clearTimer(room);
  room.round += 1; room.phase = 'story'; room.hint = ''; room.storyCardId = null; room.submissions = {}; room.votes = {}; room.tableCards = []; room.lastWinner = null;
  room.storytellerIndex = (room.storytellerIndex + 1) % room.players.length;
  room.storytellerId = room.players[room.storytellerIndex].id;
  if (!Object.keys(room.hands).length) deal(room);
  setPhaseTimer(room, room.settings.selectTimer, () => autoStory(room));
}
function removeFromHand(room, playerId, cardId) {
  const hand = room.hands[playerId] || [];
  const idx = hand.findIndex(c => c.id === cardId);
  if (idx === -1) return null;
  return hand.splice(idx, 1)[0];
}
function refillHand(room, playerId) {
  const cards = shuffle(readCards());
  while ((room.hands[playerId] || []).length < 6 && cards.length) room.hands[playerId].push(randomFrom(cards));
}
function prepareVoting(room) {
  clearTimer(room);
  const table = [];
  for (const [pid, card] of Object.entries(room.submissions)) table.push({ ...card, ownerId: pid, tableId: makeId('t') });
  room.tableCards = shuffle(table); room.phase = 'voting';
  setPhaseTimer(room, room.settings.voteTimer, () => autoVote(room));
}
function autoStory(room) {
  if (!room || room.phase !== 'story') return;
  const hand = room.hands[room.storytellerId] || [];
  if (!hand.length) return;
  const card = removeFromHand(room, room.storytellerId, hand[0].id);
  room.hint = 'تلميح تلقائي';
  room.storyCardId = card.id;
  room.submissions[room.storytellerId] = card;
  room.phase = 'submit';
  setPhaseTimer(room, room.settings.selectTimer, () => autoSubmit(room));
  emitRoom(room.code);
}
function autoSubmit(room) {
  if (!room || room.phase !== 'submit') return;
  room.players.filter(p => p.connected && p.id !== room.storytellerId && !room.submissions[p.id]).forEach(p => {
    const hand = room.hands[p.id] || [];
    if (hand.length) room.submissions[p.id] = removeFromHand(room, p.id, hand[0].id);
  });
  prepareVoting(room); emitRoom(room.code);
}
function autoVote(room) {
  if (!room || room.phase !== 'voting') return;
  room.players.filter(p => p.connected && p.id !== room.storytellerId && !room.votes[p.id]).forEach(p => {
    const options = room.tableCards.filter(c => c.ownerId !== p.id);
    if (options.length) room.votes[p.id] = randomFrom(options).tableId;
  });
  scoreRound(room); emitRoom(room.code);
}
function scoreRound(room) {
  clearTimer(room);
  const votes = Object.entries(room.votes);
  const correct = votes.filter(([, tableId]) => room.tableCards.find(c => c.tableId === tableId)?.ownerId === room.storytellerId).map(([pid]) => pid);
  const allGuessers = room.players.filter(p => p.connected && p.id !== room.storytellerId);
  const storyteller = room.players.find(p => p.id === room.storytellerId);
  if (storyteller && correct.length > 0 && correct.length < allGuessers.length) {
    storyteller.score += 3;
    correct.forEach(pid => { const p = room.players.find(x => x.id === pid); if (p) p.score += 3; });
  }
  for (const [, tableId] of votes) {
    const card = room.tableCards.find(c => c.tableId === tableId);
    if (card && card.ownerId !== room.storytellerId) {
      const owner = room.players.find(p => p.id === card.ownerId); if (owner) owner.score += 1;
    }
  }
  room.players.forEach(p => refillHand(room, p.id));
  room.phase = 'results';
  const winners = room.players.filter(p => p.score >= room.targetScore).sort((a,b) => b.score-a.score);
  if (winners.length) { room.phase = 'ended'; room.lastWinner = { name: winners[0].name, score: winners[0].score }; io.to(room.code).emit('gameWinner', room.lastWinner); }
}

io.on('connection', socket => {
  socket.on('createRoom', (name='لاعب') => { const room = newRoom(socket.id, name); rooms[room.code] = room; socket.join(room.code); socket.emit('roomCreated', room.code); emitRoom(room.code); });
  socket.on('joinRoom', ({ name='لاعب', code }) => { code = (code || '').toUpperCase(); const room = rooms[code]; if (!room) return socket.emit('errorMessage','الغرفة غير موجودة'); room.players.push({ id: socket.id, name, score: 0, connected: true }); socket.join(code); if (room.phase !== 'lobby') room.hands[socket.id] = shuffle(readCards()).slice(0,6); emitRoom(code); });
  socket.on('startGame', code => { const room = rooms[(code||'').toUpperCase()]; if (!room || room.hostId !== socket.id) return; if (room.players.filter(p=>p.connected).length < 2) return socket.emit('errorMessage','تحتاج لاعبين على الأقل'); if (!ensureEnoughCards()) return socket.emit('errorMessage','أضف كروت أولاً من لوحة التحكم'); room.settings = readSettings(); deal(room); startRound(room); emitRoom(room.code); });
  socket.on('storySubmit', ({ code, cardId, hint }) => { const room = rooms[(code||'').toUpperCase()]; if (!room || socket.id !== room.storytellerId || room.phase !== 'story') return; const card = removeFromHand(room, socket.id, cardId); if (!card) return; room.hint = hint || 'بدون تلميح'; room.storyCardId = cardId; room.submissions[socket.id] = card; room.phase = 'submit'; setPhaseTimer(room, room.settings.selectTimer, () => autoSubmit(room)); emitRoom(room.code); });
  socket.on('submitCard', ({ code, cardId }) => { const room = rooms[(code||'').toUpperCase()]; if (!room || socket.id === room.storytellerId || room.phase !== 'submit' || room.submissions[socket.id]) return; const card = removeFromHand(room, socket.id, cardId); if (!card) return; room.submissions[socket.id] = card; const needed = room.players.filter(p => p.connected).length; if (Object.keys(room.submissions).length >= needed) prepareVoting(room); emitRoom(room.code); });
  socket.on('vote', ({ code, tableId }) => { const room = rooms[(code||'').toUpperCase()]; if (!room || socket.id === room.storytellerId || room.phase !== 'voting') return; const card = room.tableCards.find(c => c.tableId === tableId); if (!card || card.ownerId === socket.id) return; room.votes[socket.id] = tableId; const needed = room.players.filter(p => p.connected && p.id !== room.storytellerId).length; if (Object.keys(room.votes).length >= needed) scoreRound(room); emitRoom(room.code); });
  socket.on('nextRound', code => { const room = rooms[(code||'').toUpperCase()]; if (!room || room.hostId !== socket.id || room.phase !== 'results') return; startRound(room); emitRoom(room.code); });
  socket.on('disconnect', () => { Object.values(rooms).forEach(room => { const p = room.players.find(x => x.id === socket.id); if (p) { p.connected = false; emitRoom(room.code); } }); });
});
server.listen(PORT, () => console.log(`Game running at http://localhost:${PORT}`));
