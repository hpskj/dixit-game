const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const multer = require('multer');
const { v2: cloudinary } = require('cloudinary');
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

const JWT_SECRET = process.env.JWT_SECRET || 'secret123';

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, 'data', 'cards.json');
const SETTINGS_FILE = path.join(__dirname, 'data', 'settings.json');
const ROOM_TEMPLATES_FILE = path.join(__dirname, 'data', 'rooms.json');
const UPLOAD_DIR = path.join(__dirname, 'public', 'uploads');
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '123456';
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || ('admin-' + Math.random().toString(36).slice(2) + Date.now().toString(36));
const CLOUDINARY_READY = Boolean(process.env.CLOUDINARY_CLOUD_NAME && process.env.CLOUDINARY_API_KEY && process.env.CLOUDINARY_API_SECRET);
if (CLOUDINARY_READY) {
  cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
    secure: true
  });
}
const CLOUDINARY_FOLDER = process.env.CLOUDINARY_FOLDER || 'dixitq8/cards';
const CLOUDINARY_AVATAR_FOLDER = process.env.CLOUDINARY_AVATAR_FOLDER || 'dixitq8/avatars';

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

// ================= نظام الأعضاء =================
function getMemberToken(req) {
  const bearer = (req.headers.authorization || '').split(' ')[1];
  return bearer || getCookie(req, 'member_token');
}

function getMemberFromRequest(req) {
  const token = getMemberToken(req);
  if (!token) return null;

  try {
    return jwt.verify(token, JWT_SECRET);
  } catch {
    return null;
  }
}

function getUserFromSocket(socket) {
  const cookie = socket.handshake.headers.cookie || '';
  const token = cookie
    .split(';')
    .map(v => v.trim())
    .find(v => v.startsWith('member_token='))
    ?.split('=')
    .slice(1)
    .join('=');

  if (!token) return null;

  try {
    return jwt.verify(token, JWT_SECRET);
  } catch {
    return null;
  }
}

async function addMemberScore(memberId, points) {
  if (!memberId || !points || points <= 0) return;

  try {
    const { data, error } = await supabase
      .from('members')
      .select('score')
      .eq('id', memberId)
      .single();

    if (error || !data) return;

    await supabase
      .from('members')
      .update({ score: Number(data.score || 0) + points })
      .eq('id', memberId);
  } catch (e) {
    console.error('Score update error:', e.message);
  }
}


async function updateMemberStats(memberId, { points = 0, win = false, gamePlayed = false } = {}) {
  if (!memberId) return;

  try {
    const { data, error } = await supabase
      .from('members')
      .select('score, wins, games_played')
      .eq('id', memberId)
      .single();

    if (error || !data) return;

    const updates = {
      score: Number(data.score || 0) + Number(points || 0),
      wins: Number(data.wins || 0) + (win ? 1 : 0),
      games_played: Number(data.games_played || 0) + (gamePlayed ? 1 : 0)
    };

    await supabase
      .from('members')
      .update(updates)
      .eq('id', memberId);
  } catch (e) {
    console.error('Stats update error:', e.message);
  }
}

async function saveMatchHistory(room) {
  try {
    if (!room || !room.lastWinner) return;

    const players = room.players.map(p => ({
      name: p.name,
      username: p.username || null,
      memberId: p.memberId || null,
      score: p.score
    }));

    await supabase
      .from('matches')
      .insert([{
        room_code: room.code,
        winner_name: room.lastWinner.name,
        winner_score: room.lastWinner.score,
        players
      }]);
  } catch (e) {
    console.error('Match history save error:', e.message);
  }
}

app.post('/api/auth/register', async (req, res) => {
  try {
    const username = String(req.body.username || '').trim().toLowerCase();
    const password = String(req.body.password || '');
    const displayName = String(req.body.display_name || username).trim();

    if (!username || !password) {
      return res.status(400).json({ ok: false, message: 'اكتب اسم المستخدم وكلمة المرور' });
    }

    if (username.length < 3) {
      return res.status(400).json({ ok: false, message: 'اسم المستخدم يجب أن يكون 3 أحرف على الأقل' });
    }

    if (password.length < 6) {
      return res.status(400).json({ ok: false, message: 'كلمة المرور يجب أن تكون 6 أحرف على الأقل' });
    }

    const passwordHash = await bcrypt.hash(password, 10);

    const { data, error } = await supabase
      .from('members')
      .insert([{
        username,
        password_hash: passwordHash,
        display_name: displayName
      }])
      .select('id, username, display_name, score, wins, games_played, avatar_url, created_at')
      .single();

    if (error) {
      const message = error.code === '23505'
        ? 'اسم المستخدم موجود مسبقاً'
        : error.message;
      return res.status(400).json({ ok: false, message });
    }

    const token = jwt.sign(
      { id: data.id, username: data.username, displayName: data.display_name },
      JWT_SECRET,
      { expiresIn: '7d' }
    );

    res.setHeader('Set-Cookie', `member_token=${token}; HttpOnly; Path=/; SameSite=Lax; Max-Age=604800`);
    res.json({ ok: true, user: data, token });
  } catch (e) {
    console.error('Register error:', e);
    res.status(500).json({ ok: false, message: 'فشل إنشاء الحساب: ' + e.message });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const username = String(req.body.username || '').trim().toLowerCase();
    const password = String(req.body.password || '');

    if (!username || !password) {
      return res.status(400).json({ ok: false, message: 'اكتب اسم المستخدم وكلمة المرور' });
    }

    const { data, error } = await supabase
      .from('members')
      .select('id, username, password_hash, display_name, score, wins, games_played, avatar_url, created_at')
      .eq('username', username)
      .single();

    if (error || !data) {
      return res.status(401).json({ ok: false, message: 'اسم المستخدم أو كلمة المرور غير صحيحة' });
    }

    const match = await bcrypt.compare(password, data.password_hash);
    if (!match) {
      return res.status(401).json({ ok: false, message: 'اسم المستخدم أو كلمة المرور غير صحيحة' });
    }

    const token = jwt.sign(
      { id: data.id, username: data.username, displayName: data.display_name },
      JWT_SECRET,
      { expiresIn: '7d' }
    );

    res.setHeader('Set-Cookie', `member_token=${token}; HttpOnly; Path=/; SameSite=Lax; Max-Age=604800`);

    res.json({
      ok: true,
      user: {
        id: data.id,
        username: data.username,
        display_name: data.display_name,
        score: data.score,
        wins: data.wins || 0,
        games_played: data.games_played || 0,
        avatar_url: data.avatar_url || null,
        created_at: data.created_at
      },
      token
    });
  } catch (e) {
    console.error('Login error:', e);
    res.status(500).json({ ok: false, message: 'فشل تسجيل الدخول: ' + e.message });
  }
});

app.post('/api/auth/logout', (_, res) => {
  res.setHeader('Set-Cookie', 'member_token=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0');
  res.json({ ok: true });
});

app.get('/api/auth/me', async (req, res) => {
  try {
    const member = getMemberFromRequest(req);
    if (!member) return res.json({ ok: false, user: null });

    const { data, error } = await supabase
      .from('members')
      .select('id, username, display_name, score, wins, games_played, avatar_url, created_at')
      .eq('id', member.id)
      .single();

    if (error || !data) return res.json({ ok: false, user: null });

    res.json({ ok: true, user: data });
  } catch (e) {
    res.status(500).json({ ok: false, message: e.message });
  }
});




// بروفايل لاعب
app.get('/api/profile/:username', async (req, res) => {
  try {
    const username = String(req.params.username || '').trim().toLowerCase();

    const { data, error } = await supabase
      .from('members')
      .select('username, display_name, score, wins, games_played, avatar_url, created_at')
      .eq('username', username)
      .single();

    if (error || !data) {
      return res.status(404).json({ ok: false, message: 'اللاعب غير موجود' });
    }

    res.json({ ok: true, profile: data });
  } catch (e) {
    res.status(500).json({ ok: false, message: e.message });
  }
});


// آخر المباريات
app.get('/api/matches', async (_, res) => {
  try {
    const { data, error } = await supabase
      .from('matches')
      .select('room_code, winner_name, winner_score, players, created_at')
      .order('created_at', { ascending: false })
      .limit(30);

    if (error) return res.status(400).json({ ok: false, message: error.message });

    res.json({ ok: true, matches: data || [] });
  } catch (e) {
    res.status(500).json({ ok: false, message: e.message });
  }
});

// ترتيب اللاعبين
app.get('/api/leaderboard', async (_, res) => {
  try {
    const { data, error } = await supabase
      .from('members')
      .select('username, display_name, score, wins, games_played, avatar_url')
      .order('score', { ascending: false })
      .limit(50);

    if (error) return res.status(400).json({ ok: false, message: error.message });

    res.json({ ok: true, leaderboard: data || [] });
  } catch (e) {
    res.status(500).json({ ok: false, message: e.message });
  }
});



// رابط دعوة مباشر للغرفة: https://your-domain.com/invite/ABCD
app.get('/invite/:code', (req, res) => {
  const code = String(req.params.code || '').toUpperCase();
  res.redirect('/?room=' + encodeURIComponent(code));
});

app.use(express.static(path.join(__dirname, 'public')));

function readJson(file, fallback) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; } }
function writeJson(file, data) { fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8'); }
function readCards() { return readJson(DATA_FILE, []); }
function saveCards(cards) { writeJson(DATA_FILE, cards); }
function readSettings() { return { selectTimer: 30, voteTimer: 20, ...readJson(SETTINGS_FILE, {}) }; }
function saveSettings(settings) { writeJson(SETTINGS_FILE, settings); }
function readRoomTemplates() { return readJson(ROOM_TEMPLATES_FILE, []); }
function saveRoomTemplates(templates) { writeJson(ROOM_TEMPLATES_FILE, templates); }
function makeId(prefix='id') { return prefix + Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }
function roomCode() { return Math.random().toString(36).slice(2, 6).toUpperCase(); }
function shuffle(arr) { return [...arr].sort(() => Math.random() - 0.5); }
function publicPlayer(p) { return { id: p.id, name: p.name, score: p.score, connected: p.connected, username: p.username || null, memberId: p.memberId || null }; }
function randomFrom(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

// منع تكرار الكروت طول اللعبة كاملة
function resetDeck(room, sourceCards) {
  const used = new Set(room.usedCardIds || []);
  let available = shuffle(sourceCards || room.deckCards || readCards()).filter(card => !used.has(card.id));

  // إذا خلصت كل الكروت، نبدأ دورة جديدة ونسمح بالتكرار من جديد
  if (!available.length) {
    room.usedCardIds = [];
    available = shuffle(sourceCards || room.deckCards || readCards());
  }

  room.deck = available;
}

function drawCard(room) {
  if (!room.deck || room.deck.length === 0) {
    resetDeck(room, room.deckCards || readCards());
  }

  const card = room.deck.pop();
  if (card) {
    room.usedCardIds = room.usedCardIds || [];
    room.usedCardIds.push(card.id);
  }

  return card;
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 12 * 1024 * 1024, files: 200 },
  fileFilter: (_, file, cb) => file.mimetype.startsWith('image/') ? cb(null, true) : cb(new Error('Images only'))
});

// رفع صورة بروفايل اللاعب
app.post('/api/profile/avatar', upload.single('avatar'), async (req, res) => {
  try {
    const member = getMemberFromRequest(req);
    if (!member) return res.status(401).json({ ok: false, message: 'سجل دخولك أولاً' });

    if (!req.file) {
      return res.status(400).json({ ok: false, message: 'اختر صورة أولاً' });
    }

    if (!CLOUDINARY_READY) {
      return res.status(500).json({ ok: false, message: 'Cloudinary غير مفعّل' });
    }

    const result = await new Promise((resolve, reject) => {
      const stream = cloudinary.uploader.upload_stream({
        folder: CLOUDINARY_AVATAR_FOLDER,
        resource_type: 'image',
        public_id: 'member_' + member.id,
        overwrite: true,
        transformation: [
          { width: 400, height: 400, crop: 'fill', gravity: 'face:auto' },
          { quality: 'auto', fetch_format: 'auto' }
        ],
        tags: ['dixit_avatar']
      }, (err, out) => err ? reject(err) : resolve(out));

      stream.end(req.file.buffer);
    });

    const { data, error } = await supabase
      .from('members')
      .update({ avatar_url: result.secure_url })
      .eq('id', member.id)
      .select('id, username, display_name, score, wins, games_played, avatar_url, created_at')
      .single();

    if (error) return res.status(400).json({ ok: false, message: error.message });

    res.json({ ok: true, user: data, avatar_url: result.secure_url });
  } catch (e) {
    console.error('Avatar upload error:', e);
    res.status(500).json({ ok: false, message: 'فشل رفع صورة البروفايل: ' + e.message });
  }
});

function uploadBufferToCloudinary(file, title) {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream({
      folder: CLOUDINARY_FOLDER,
      resource_type: 'image',
      use_filename: true,
      unique_filename: true,
      overwrite: false,
      context: { title: title || file.originalname.replace(/\.[^.]+$/, '') },
      tags: ['dixit_card']
    }, (err, result) => err ? reject(err) : resolve(result));
    stream.end(file.buffer);
  });
}
async function getCloudinaryCards() {
  if (!CLOUDINARY_READY) return [];
  try {
    const result = await cloudinary.search
      .expression('folder:' + CLOUDINARY_FOLDER)
      .with_field('context')
      .sort_by('created_at', 'desc')
      .max_results(500)
      .execute();
    return (result.resources || []).map(r => ({
      id: 'cloud_' + Buffer.from(r.public_id).toString('base64url'),
      publicId: r.public_id,
      title: (r.context && r.context.custom && r.context.custom.title) || r.public_id.split('/').pop(),
      image: r.secure_url || r.url
    }));
  } catch (e) { console.error('Cloudinary list error:', e.message); return []; }
}
function cloudIdToPublicId(id) {
  if (!id || !id.startsWith('cloud_')) return null;
  try { return Buffer.from(id.slice(6), 'base64url').toString('utf8'); } catch { return null; }
}
async function allCards() {
  const localCards = readCards();
  const cloudCards = await getCloudinaryCards();
  const seen = new Set();
  return [...localCards, ...cloudCards].filter(c => { if (seen.has(c.id)) return false; seen.add(c.id); return true; });
}

function normalizeRoomTemplate(row) {
  const images = Array.isArray(row?.images) ? row.images : [];
  return {
    id: row.id,
    name: row.name || 'غرفة بدون اسم',
    category: row.category || '',
    description: row.description || '',
    coverImage: row.cover_image || row.coverImage || '',
    cover_image: row.cover_image || row.coverImage || '',
    cardIds: images.map(c => c.id).filter(Boolean),
    cards: images.filter(c => c && c.id && c.image),
    images,
    createdAt: row.created_at || row.createdAt || new Date().toISOString()
  };
}

async function getRoomTemplates() {
  const { data, error } = await supabase
    .from('rooms')
    .select('*')
    .order('created_at', { ascending: false });

  if (error) {
    console.error('Supabase rooms list error:', error.message);
    return readRoomTemplates();
  }

  return (data || []).map(normalizeRoomTemplate);
}

async function getRoomTemplateById(id) {
  if (!id) return null;
  const { data, error } = await supabase
    .from('rooms')
    .select('*')
    .eq('id', id)
    .single();

  if (error) {
    console.error('Supabase room get error:', error.message);
    return readRoomTemplates().find(r => r.id === id) || null;
  }

  return data ? normalizeRoomTemplate(data) : null;
}

async function cardsForTemplate(template) {
  if (Array.isArray(template?.cards) && template.cards.length) return template.cards;
  if (Array.isArray(template?.images) && template.images.length) return template.images;
  const ids = new Set(template?.cardIds || []);
  if (!ids.size) return [];
  const cards = await allCards();
  return cards.filter(c => ids.has(c.id));
}

async function publicRoomTemplates() {
  const templates = await getRoomTemplates();
  return templates.map(r => {
    const roomCards = r.cards || r.images || [];
    return {
      id: r.id,
      name: r.name,
      category: r.category || '',
      description: r.description || '',
      cardCount: roomCards.length,
      cover: r.coverImage || r.cover_image || roomCards[0]?.image || null,
      createdAt: r.createdAt
    };
  });
}

app.get('/api/cards', async (_, res) => res.json(await allCards()));
app.get('/api/room-templates', async (_, res) => res.json({ ok: true, rooms: await publicRoomTemplates() }));

app.get('/api/admin/room-templates', requireAdmin, async (_, res) => {
  const rooms = await getRoomTemplates();
  res.json({
    ok: true,
    rooms: rooms.map(r => ({
      ...r,
      cards: r.cards || r.images || [],
      cardCount: (r.cards || r.images || []).length,
      coverImage: r.coverImage || r.cover_image || '',
      cover_image: r.coverImage || r.cover_image || ''
    }))
  });
});

app.post('/api/admin/room-templates', requireAdmin, async (req, res) => {
  const name = String(req.body.name || '').trim();
  const category = String(req.body.category || '').trim();
  const description = String(req.body.description || '').trim();
  if (!name) return res.status(400).json({ ok:false, message:'اكتب اسم الغرفة' });

  const roomData = { name, category: category || null, description: description || null, images: [], cover_image: null };

  const { data, error } = await supabase
    .from('rooms')
    .insert(roomData)
    .select('*')
    .single();

  if (error) return res.status(500).json({ ok:false, message:'فشل إنشاء الغرفة في Supabase: ' + error.message });
  res.json({ ok:true, room: normalizeRoomTemplate(data) });
});

app.put('/api/admin/room-templates/:id', requireAdmin, async (req, res) => {
  const name = String(req.body.name || '').trim();
  const category = String(req.body.category || '').trim();
  const description = String(req.body.description || '').trim();

  const update = {};
  if (name) update.name = name;
  update.category = category || null;
  update.description = description || null;

  const { data, error } = await supabase
    .from('rooms')
    .update(update)
    .eq('id', req.params.id)
    .select('*')
    .single();

  if (error) return res.status(404).json({ ok:false, message:'الغرفة غير موجودة أو فشل تعديلها: ' + error.message });
  res.json({ ok:true, room: normalizeRoomTemplate(data) });
});

app.delete('/api/admin/room-templates/:id', requireAdmin, async (req, res) => {
  const { data, error } = await supabase
    .from('rooms')
    .delete()
    .eq('id', req.params.id)
    .select('*')
    .maybeSingle();

  if (error) return res.status(500).json({ ok:false, message:'فشل حذف الغرفة: ' + error.message });
  res.json({ ok:true, deleted: data ? normalizeRoomTemplate(data) : null });
});


app.post('/api/admin/room-templates/:id/cover', requireAdmin, async (req, res) => {
  const imageUrl = String(req.body.imageUrl || '').trim();
  if (!imageUrl) return res.status(400).json({ ok:false, message:'اختر صورة الغلاف أولاً' });

  const room = await getRoomTemplateById(req.params.id);
  if (!room) return res.status(404).json({ ok:false, message:'الغرفة غير موجودة' });

  const existsInRoom = (room.images || []).some(c => c.image === imageUrl);
  if (!existsInRoom) return res.status(400).json({ ok:false, message:'الصورة ليست ضمن صور هذه الغرفة' });

  const { data, error } = await supabase
    .from('rooms')
    .update({ cover_image: imageUrl })
    .eq('id', req.params.id)
    .select('*')
    .single();

  if (error) return res.status(500).json({ ok:false, message:'فشل تعيين صورة الغلاف: ' + error.message });
  res.json({ ok:true, room: normalizeRoomTemplate(data) });
});

app.delete('/api/admin/room-templates/:id/cover', requireAdmin, async (req, res) => {
  const { data, error } = await supabase
    .from('rooms')
    .update({ cover_image: null })
    .eq('id', req.params.id)
    .select('*')
    .single();

  if (error) return res.status(500).json({ ok:false, message:'فشل إزالة الغلاف: ' + error.message });
  res.json({ ok:true, room: normalizeRoomTemplate(data) });
});

app.post('/api/admin/room-templates/:id/cards', requireAdmin, upload.array('images', 200), async (req, res) => {
  try {
    const room = await getRoomTemplateById(req.params.id);
    if (!room) return res.status(404).json({ ok:false, message:'الغرفة غير موجودة' });

    const files = req.files || [];
    if (!files.length) return res.status(400).json({ ok:false, message:'اختر صوراً أولاً' });

    let added = [];
    if (CLOUDINARY_READY) {
      for (const file of files) {
        const title = file.originalname.replace(/\.[^.]+$/, '');
        const result = await uploadBufferToCloudinary(file, title);
        added.push({
          id: 'cloud_' + Buffer.from(result.public_id).toString('base64url'),
          publicId: result.public_id,
          title,
          image: result.secure_url
        });
      }
    } else {
      if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });
      added = files.map(file => {
        const filename = Date.now() + '-' + Math.random().toString(36).slice(2, 8) + path.extname(file.originalname).toLowerCase();
        fs.writeFileSync(path.join(UPLOAD_DIR, filename), file.buffer);
        return { id: makeId('c'), title: file.originalname.replace(/\.[^.]+$/, ''), image: '/uploads/' + filename };
      });

      const cards = readCards();
      cards.push(...added);
      saveCards(cards);
    }

    const existing = Array.isArray(room.images) ? room.images : [];
    const byId = new Map([...existing, ...added].map(c => [c.id, c]));
    const images = Array.from(byId.values());

    const { data, error } = await supabase
      .from('rooms')
      .update({ images })
      .eq('id', req.params.id)
      .select('*')
      .single();

    if (error) return res.status(500).json({ ok:false, message:'تم رفع الصور لكن فشل حفظها في الغرفة: ' + error.message });
    res.json({ ok:true, added, room: normalizeRoomTemplate(data) });
  } catch(e) {
    console.error(e);
    res.status(500).json({ ok:false, message:'فشل رفع صور الغرفة: ' + e.message });
  }
});

app.delete('/api/admin/room-templates/:roomId/cards/:cardId', requireAdmin, async (req, res) => {
  const room = await getRoomTemplateById(req.params.roomId);
  if (!room) return res.status(404).json({ ok:false, message:'الغرفة غير موجودة' });

  const removedCard = (room.images || []).find(c => c.id === req.params.cardId);
  const images = (room.images || []).filter(c => c.id !== req.params.cardId);
  const update = { images };
  if (removedCard && room.coverImage && removedCard.image === room.coverImage) update.cover_image = null;

  const { error } = await supabase
    .from('rooms')
    .update(update)
    .eq('id', req.params.roomId);

  if (error) return res.status(500).json({ ok:false, message:'فشل إزالة الصورة من الغرفة: ' + error.message });
  res.json({ ok:true });
});

app.post('/api/admin/room-templates/:roomId/cards/bulk-delete', requireAdmin, async (req, res) => {
  const room = await getRoomTemplateById(req.params.roomId);
  if (!room) return res.status(404).json({ ok:false, message:'الغرفة غير موجودة' });

  const cardIds = Array.isArray(req.body.cardIds) ? req.body.cardIds.map(String) : [];
  if (!cardIds.length) return res.status(400).json({ ok:false, message:'لم يتم تحديد صور للحذف' });

  const ids = new Set(cardIds);
  const before = Array.isArray(room.images) ? room.images : [];
  const removedCards = before.filter(c => ids.has(String(c.id)));
  const images = before.filter(c => !ids.has(String(c.id)));
  const removed = before.length - images.length;
  const update = { images };
  if (room.coverImage && removedCards.some(c => c.image === room.coverImage)) update.cover_image = null;

  const { error } = await supabase
    .from('rooms')
    .update(update)
    .eq('id', req.params.roomId);

  if (error) return res.status(500).json({ ok:false, message:'فشل حذف الصور المحددة: ' + error.message });
  res.json({ ok:true, removed });
});

app.post('/api/cards', requireAdmin, upload.single('image'), async (req, res) => {
  try {
    const title = req.body.title || (req.file ? req.file.originalname.replace(/\.[^.]+$/, '') : 'كرت جديد');
    if (!req.file && !req.body.image) return res.status(400).json({ ok:false, message:'اختر صورة أولاً' });
    if (CLOUDINARY_READY && req.file) {
      const result = await uploadBufferToCloudinary(req.file, title);
      return res.json({ ok: true, card: { id: 'cloud_' + Buffer.from(result.public_id).toString('base64url'), publicId: result.public_id, title, image: result.secure_url } });
    }
    if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });
    const filename = Date.now() + '-' + Math.random().toString(36).slice(2, 8) + path.extname(req.file.originalname).toLowerCase();
    fs.writeFileSync(path.join(UPLOAD_DIR, filename), req.file.buffer);
    const cards = readCards();
    const card = { id: makeId('c'), title, image: '/uploads/' + filename };
    cards.push(card); saveCards(cards); res.json({ ok: true, card });
  } catch (e) { console.error(e); res.status(500).json({ ok:false, message:'فشل رفع الصورة: ' + e.message }); }
});
app.post('/api/cards/bulk', requireAdmin, upload.array('images', 200), async (req, res) => {
  try {
    const files = req.files || [];
    if (!files.length) return res.status(400).json({ ok:false, message:'اختر صوراً أولاً' });
    let added = [];
    if (CLOUDINARY_READY) {
      for (const file of files) {
        const title = file.originalname.replace(/\.[^.]+$/, '');
        const result = await uploadBufferToCloudinary(file, title);
        added.push({ id: 'cloud_' + Buffer.from(result.public_id).toString('base64url'), publicId: result.public_id, title, image: result.secure_url });
      }
      return res.json({ ok: true, added });
    }
    if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });
    const cards = readCards();
    added = files.map(file => {
      const filename = Date.now() + '-' + Math.random().toString(36).slice(2, 8) + path.extname(file.originalname).toLowerCase();
      fs.writeFileSync(path.join(UPLOAD_DIR, filename), file.buffer);
      return { id: makeId('c'), title: file.originalname.replace(/\.[^.]+$/, ''), image: '/uploads/' + filename };
    });
    cards.push(...added); saveCards(cards); res.json({ ok: true, added });
  } catch (e) { console.error(e); res.status(500).json({ ok:false, message:'فشل رفع المجموعة: ' + e.message }); }
});
async function removeCardsFromAllRoomTemplates(cardIds) {
  const ids = new Set((cardIds || []).map(String));
  if (!ids.size) return 0;

  const { data, error } = await supabase.from('rooms').select('id, images, cover_image');
  if (error) {
    console.error('Supabase remove cards from rooms error:', error.message);
    return 0;
  }

  let updatedRooms = 0;
  for (const room of data || []) {
    const before = Array.isArray(room.images) ? room.images : [];
    const removedCards = before.filter(c => ids.has(String(c.id)));
    const images = before.filter(c => !ids.has(String(c.id)));
    if (images.length !== before.length) {
      const update = { images };
      if (room.cover_image && removedCards.some(c => c.image === room.cover_image)) update.cover_image = null;
      const { error: updateError } = await supabase.from('rooms').update(update).eq('id', room.id);
      if (!updateError) updatedRooms += 1;
    }
  }
  return updatedRooms;
}

async function deleteCardsByIds(cardIds) {
  const ids = [...new Set((cardIds || []).map(String).filter(Boolean))];
  if (!ids.length) return { deleted: 0, updatedRooms: 0 };

  let deleted = 0;
  for (const id of ids) {
    const publicId = cloudIdToPublicId(id);
    if (publicId && CLOUDINARY_READY) {
      try {
        await cloudinary.uploader.destroy(publicId, { resource_type: 'image' });
        deleted += 1;
      } catch (e) {
        console.error('Cloudinary delete error:', e.message);
      }
    }
  }

  let cards = readCards();
  const beforeLocal = cards.length;
  cards = cards.filter(c => !ids.includes(String(c.id)));
  if (cards.length !== beforeLocal) {
    saveCards(cards);
    deleted += beforeLocal - cards.length;
  }

  const updatedRooms = await removeCardsFromAllRoomTemplates(ids);
  return { deleted, updatedRooms };
}

app.post('/api/cards/bulk-delete', requireAdmin, async (req, res) => {
  try {
    const cardIds = Array.isArray(req.body.cardIds) ? req.body.cardIds : [];
    if (!cardIds.length) return res.status(400).json({ ok:false, message:'لم يتم تحديد صور للحذف' });
    const result = await deleteCardsByIds(cardIds);
    res.json({ ok:true, ...result });
  } catch(e) {
    res.status(500).json({ ok:false, message:'فشل الحذف الجماعي: ' + e.message });
  }
});

app.delete('/api/cards/:id', requireAdmin, async (req, res) => {
  try {
    const result = await deleteCardsByIds([req.params.id]);
    res.json({ ok: true, deleted: result.deleted, updatedRooms: result.updatedRooms });
  } catch(e) { res.status(500).json({ ok:false, message:'فشل الحذف: ' + e.message }); }
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

function activeRoomSummary(room, memberId) {
  const player = room.players.find(p => p.memberId === memberId);
  if (!player) return null;
  return {
    code: room.code,
    roomName: room.roomName || 'غرفة',
    roomCategory: room.roomCategory || '',
    phase: room.phase,
    round: room.round || 0,
    score: player.score || 0,
    connected: !!player.connected,
    playersCount: room.players.length,
    updatedAt: Date.now()
  };
}

app.get('/api/my-active-rooms', (req, res) => {
  try {
    const member = getMemberFromRequest(req);
    if (!member?.id) return res.json({ ok: false, rooms: [] });

    const activeRooms = Object.values(rooms)
      .map(room => activeRoomSummary(room, member.id))
      .filter(Boolean)
      .sort((a, b) => (b.round || 0) - (a.round || 0));

    res.json({ ok: true, rooms: activeRooms });
  } catch (e) {
    res.status(500).json({ ok: false, message: e.message, rooms: [] });
  }
});

function newRoom(hostId, name, member = null, template = null) {
  return {
    code: roomCode(), hostId, templateId: template?.id || null, roomName: template?.name || 'غرفة خاصة', roomCategory: template?.category || '',
    players: [{ id: hostId, name, score: 0, connected: true, memberId: member?.id || null, username: member?.username || null }],
    phase: 'lobby', round: 0, targetScore: 30, storytellerIndex: -1,
    storytellerId: null, hint: '', hands: {}, storyCardId: null,
    submissions: {}, votes: {}, skippedPlayers: {}, tableCards: [], timerEndsAt: null, timerHandle: null,
    settings: readSettings(), lastWinner: null, deck: [], usedCardIds: []
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
    code, roomName: room.roomName || 'غرفة', roomCategory: room.roomCategory || '', phase: room.phase, round: room.round, targetScore: room.targetScore,
    hostId: room.hostId, storytellerId: room.storytellerId, hint: room.hint,
    players: room.players.map(publicPlayer),
    tableCards: room.tableCards.map(c => {
      const owner = room.players.find(p => p.id === c.ownerId);
      const voters = Object.entries(room.votes || {})
        .filter(([pid, tableId]) => tableId === c.tableId && !room.skippedPlayers?.[pid])
        .map(([pid]) => room.players.find(p => p.id === pid)?.name)
        .filter(Boolean);
      return {
        id: c.tableId, image: c.image, title: c.title,
        ownerName: showRoundDetails ? (owner?.name || 'لاعب') : null,
        voters: showRoundDetails ? voters : [],
        isStorytellerCard: showRoundDetails ? c.ownerId === room.storytellerId : false
      };
    }),
    timerEndsAt: room.timerEndsAt, settings: room.settings, lastWinner: room.lastWinner, inviteUrl: `/invite/${code}`
  });
  room.players.forEach(p => io.to(p.id).emit('yourHand', room.hands[p.id] || []));
}
function ensureEnoughCards(cards) { return (cards || []).length > 0; }
function deal(room, sourceCards) {
  resetDeck(room, sourceCards);
  room.hands = {};

  room.players.forEach(p => {
    room.hands[p.id] = [];
    for (let n = 0; n < 6; n++) {
      const card = drawCard(room);
      if (card) room.hands[p.id].push(card);
    }
  });
}
function startRound(room) {
  clearTimer(room);
  room.round += 1; room.phase = 'story'; room.hint = ''; room.storyCardId = null; room.submissions = {}; room.votes = {}; room.skippedPlayers = {}; room.tableCards = []; room.lastWinner = null;
  room.storytellerIndex = (room.storytellerIndex + 1) % room.players.length;
  room.storytellerId = room.players[room.storytellerIndex].id;
  if (!Object.keys(room.hands).length) deal(room, room.deckCards);
  setPhaseTimer(room, room.settings.selectTimer, () => autoStory(room));
}
function removeFromHand(room, playerId, cardId) {
  const hand = room.hands[playerId] || [];
  const idx = hand.findIndex(c => c.id === cardId);
  if (idx === -1) return null;
  return hand.splice(idx, 1)[0];
}
function refillHand(room, playerId) {
  room.hands[playerId] = room.hands[playerId] || [];

  while (room.hands[playerId].length < 6) {
    const card = drawCard(room);
    if (!card) break;
    room.hands[playerId].push(card);
  }
}
function prepareVoting(room) {
  clearTimer(room);
  const table = [];

  for (const [pid, card] of Object.entries(room.submissions)) {
    if (!card) continue;
    table.push({ ...card, ownerId: pid, tableId: makeId('t') });
  }

  room.tableCards = shuffle(table);
  room.phase = 'voting';
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

  // من لا يختار كرت قبل انتهاء الوقت لا يحصل على نقاط في هذه الجولة
  room.players
    .filter(p => p.connected && p.id !== room.storytellerId && !room.submissions[p.id])
    .forEach(p => {
      room.skippedPlayers[p.id] = true;
    });

  prepareVoting(room);
  emitRoom(room.code);
}
function autoVote(room) {
  if (!room || room.phase !== 'voting') return;

  // من لا يصوّت قبل انتهاء الوقت لا يحصل على نقاط في هذه الجولة
  room.players
    .filter(p => p.connected && p.id !== room.storytellerId && !room.votes[p.id])
    .forEach(p => {
      room.skippedPlayers[p.id] = true;
    });

  scoreRound(room);
  emitRoom(room.code);
}
function scoreRound(room) {
  clearTimer(room);

  const votes = Object.entries(room.votes);
  const gained = {};

  function addPoints(playerId, points) {
    const p = room.players.find(x => x.id === playerId);
    if (!p) return;
    p.score += points;
    gained[playerId] = (gained[playerId] || 0) + points;
  }

  const activeGuessers = room.players.filter(p =>
    p.connected &&
    p.id !== room.storytellerId &&
    !room.skippedPlayers?.[p.id]
  );

  const correct = votes
    .filter(([pid]) => !room.skippedPlayers?.[pid])
    .filter(([, tableId]) => room.tableCards.find(c => c.tableId === tableId)?.ownerId === room.storytellerId)
    .map(([pid]) => pid);

  const allPickedStoryCard = activeGuessers.length > 0 && correct.length === activeGuessers.length;
  const nonePickedStoryCard = correct.length === 0;

  // قانون Dixit الصحيح:
  // إذا كل اللاعبين عرفوا كرت الراوي أو لا أحد عرفه:
  // الراوي = 0، وكل اللاعبين الآخرين النشطين = +2
  if (allPickedStoryCard || nonePickedStoryCard) {
    activeGuessers.forEach(p => addPoints(p.id, 2));
  } else {
    // الحالة الطبيعية:
    // الراوي +3، وكل من خمن كرت الراوي +3
    addPoints(room.storytellerId, 3);
    correct.forEach(pid => addPoints(pid, 3));
  }

  // نقاط الأصوات الإضافية:
  // صاحب أي كرت غير كرت الراوي يحصل +1 عن كل صوت عليه
  for (const [voterId, tableId] of votes) {
    if (room.skippedPlayers?.[voterId]) continue;

    const card = room.tableCards.find(c => c.tableId === tableId);
    if (card && card.ownerId !== room.storytellerId) {
      const owner = room.players.find(p => p.id === card.ownerId);
      if (owner && !room.skippedPlayers?.[owner.id]) addPoints(owner.id, 1);
    }
  }

  // ربط نقاط الجولة بقاعدة البيانات للأعضاء المسجلين
  for (const [playerId, points] of Object.entries(gained)) {
    const player = room.players.find(p => p.id === playerId);
    if (player?.memberId) updateMemberStats(player.memberId, { points });
  }

  room.players.forEach(p => refillHand(room, p.id));

  room.phase = 'results';
  const winners = room.players.filter(p => p.score >= room.targetScore).sort((a, b) => b.score - a.score);

  if (winners.length) {
    room.phase = 'ended';
    room.lastWinner = { name: winners[0].name, score: winners[0].score };

    // حفظ الفوز وعدد الألعاب للأعضاء المسجلين
    room.players.forEach(p => {
      if (p.memberId) {
        updateMemberStats(p.memberId, {
          win: p.id === winners[0].id,
          gamePlayed: true
        });
      }
    });

    saveMatchHistory(room);
    io.to(room.code).emit('gameWinner', room.lastWinner);
  }
}


function reconnectExistingPlayer(room, socket, member, fallbackName = 'لاعب') {
  if (!room || !member?.id) return false;

  const existing = room.players.find(p => p.memberId === member.id);
  if (!existing) return false;

  const oldId = existing.id;
  const newId = socket.id;

  existing.id = newId;
  existing.connected = true;
  existing.name = member.displayName || existing.name || fallbackName;
  existing.username = member.username || existing.username || null;
  existing.memberId = member.id;

  // إذا كان هو صاحب الغرفة أو الراوي، حدث الـ socket id
  if (room.hostId === oldId) room.hostId = newId;
  if (room.storytellerId === oldId) room.storytellerId = newId;

  // نقل كروت اليد من السوكيت القديم إلى الجديد
  if (room.hands && room.hands[oldId]) {
    room.hands[newId] = room.hands[oldId];
    delete room.hands[oldId];
  }

  // نقل اختيار الكرت
  if (room.submissions && room.submissions[oldId]) {
    room.submissions[newId] = room.submissions[oldId];
    delete room.submissions[oldId];
  }

  // نقل التصويت
  if (room.votes && room.votes[oldId]) {
    room.votes[newId] = room.votes[oldId];
    delete room.votes[oldId];
  }

  // نقل حالة التخطي
  if (room.skippedPlayers && room.skippedPlayers[oldId]) {
    room.skippedPlayers[newId] = room.skippedPlayers[oldId];
    delete room.skippedPlayers[oldId];
  }

  // تحديث مالك الكرت على طاولة التصويت
  if (Array.isArray(room.tableCards)) {
    room.tableCards.forEach(card => {
      if (card.ownerId === oldId) card.ownerId = newId;
    });
  }

  socket.join(room.code);
  return true;
}

io.on('connection', socket => {
  socket.on('createRoom', async (payload = {}) => {
    const member = getUserFromSocket(socket);
    if (!member) return socket.emit('errorMessage','سجّل دخولك أولاً');

    const roomId = typeof payload === 'string' ? null : payload.roomId;
    const template = await getRoomTemplateById(roomId);
    if (!template) return socket.emit('errorMessage','اختر غرفة من القائمة أولاً');

    const templateCards = await cardsForTemplate(template);
    if (!ensureEnoughCards(templateCards)) return socket.emit('errorMessage','هذه الغرفة لا تحتوي صوراً بعد');

    const displayName = member.displayName || payload.name || 'لاعب';
    const room = newRoom(socket.id, displayName, member, template);
    room.deckCards = templateCards;
    rooms[room.code] = room;
    socket.join(room.code);
    socket.emit('roomCreated', room.code);
    socket.emit('roomInvite', { code: room.code, inviteUrl: `/invite/${room.code}` });
    emitRoom(room.code);
  });
  socket.on('joinRoom', ({ name='لاعب', code }) => {
    code = (code || '').toUpperCase();
    const room = rooms[code];
    if (!room) return socket.emit('errorMessage','الغرفة غير موجودة');

    const member = getUserFromSocket(socket);
    if (!member) return socket.emit('errorMessage','سجّل دخولك أولاً');

    // إعادة اتصال حقيقية: إذا اللاعب مسجل وكان موجوداً في الغرفة، نعيده لنفس مكانه
    if (reconnectExistingPlayer(room, socket, member, name)) {
      socket.emit('reconnectedToRoom', {
        code,
        message: 'تمت إعادتك لنفس الغرفة بنفس النقاط والكروت'
      });
      emitRoom(code);
      return;
    }

    const displayName = member?.displayName || name || 'لاعب';

    room.players.push({
      id: socket.id,
      name: displayName,
      score: 0,
      connected: true,
      memberId: member?.id || null,
      username: member?.username || null
    });

    socket.join(code);

    if (room.phase !== 'lobby') {
      room.hands[socket.id] = [];
      for (let n = 0; n < 6; n++) {
        const card = drawCard(room);
        if (card) room.hands[socket.id].push(card);
      }
    }

    emitRoom(code);
  });

  socket.on('reconnectRoom', ({ code }) => {
    code = (code || '').toUpperCase();
    const room = rooms[code];
    if (!room) return socket.emit('errorMessage','الغرفة غير موجودة');

    const member = getUserFromSocket(socket);
    if (!reconnectExistingPlayer(room, socket, member)) {
      return socket.emit('errorMessage','لم يتم العثور على لاعب سابق بنفس الحساب داخل هذه الغرفة');
    }

    socket.emit('reconnectedToRoom', {
      code,
      message: 'تمت إعادتك لنفس الغرفة بنفس النقاط والكروت'
    });
    emitRoom(code);
  });

  socket.on('startGame', async code => { const room = rooms[(code||'').toUpperCase()]; if (!room || room.hostId !== socket.id) return; if (room.players.filter(p=>p.connected).length < 2) return socket.emit('errorMessage','تحتاج لاعبين على الأقل'); if (!room.deckCards || !room.deckCards.length) { const t = await getRoomTemplateById(room.templateId); room.deckCards = t ? await cardsForTemplate(t) : []; } if (!ensureEnoughCards(room.deckCards)) return socket.emit('errorMessage','أضف صوراً لهذه الغرفة من لوحة التحكم'); room.settings = readSettings(); deal(room, room.deckCards); startRound(room); emitRoom(room.code); });
  socket.on('storySubmit', ({ code, cardId, hint }) => { const room = rooms[(code||'').toUpperCase()]; if (!room || socket.id !== room.storytellerId || room.phase !== 'story') return; const card = removeFromHand(room, socket.id, cardId); if (!card) return; room.hint = hint || 'بدون تلميح'; room.storyCardId = cardId; room.submissions[socket.id] = card; room.phase = 'submit'; setPhaseTimer(room, room.settings.selectTimer, () => autoSubmit(room)); emitRoom(room.code); });
  socket.on('submitCard', ({ code, cardId }) => { const room = rooms[(code||'').toUpperCase()]; if (!room || socket.id === room.storytellerId || room.phase !== 'submit' || room.submissions[socket.id]) return;
    if (room.skippedPlayers?.[socket.id]) return;
    const card = removeFromHand(room, socket.id, cardId);
    if (!card) return;
    room.submissions[socket.id] = card;
    const needed = room.players.filter(p => p.connected && !room.skippedPlayers?.[p.id]).length;
    if (Object.keys(room.submissions).length >= needed) prepareVoting(room);
    emitRoom(room.code); });
  socket.on('vote', ({ code, tableId }) => { const room = rooms[(code||'').toUpperCase()]; if (!room || socket.id === room.storytellerId || room.phase !== 'voting') return;
    if (room.skippedPlayers?.[socket.id]) return;
    const card = room.tableCards.find(c => c.tableId === tableId);
    if (!card || card.ownerId === socket.id) return;
    room.votes[socket.id] = tableId;
    const needed = room.players.filter(p => p.connected && p.id !== room.storytellerId && !room.skippedPlayers?.[p.id]).length;
    if (Object.keys(room.votes).length >= needed) scoreRound(room);
    emitRoom(room.code); });
  socket.on('nextRound', code => { const room = rooms[(code||'').toUpperCase()]; if (!room || room.hostId !== socket.id || room.phase !== 'results') return; startRound(room); emitRoom(room.code); });
  socket.on('disconnect', () => { Object.values(rooms).forEach(room => { const p = room.players.find(x => x.id === socket.id); if (p) { p.connected = false; p.disconnectedAt = Date.now(); emitRoom(room.code); } }); });
});
server.listen(PORT, () => console.log(`Game running at http://localhost:${PORT}`));