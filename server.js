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
    const email = String(req.body.email || '').trim().toLowerCase();
    const password = String(req.body.password || '');
    const displayName = String(req.body.display_name || username).trim();

    if (!username || !email || !password) {
      return res.status(400).json({ ok: false, message: 'اكتب اسم المستخدم والإيميل وكلمة المرور' });
    }

    if (username.length < 3 || !/^[a-z0-9_\.]{3,24}$/.test(username)) {
      return res.status(400).json({ ok: false, message: 'اسم المستخدم يجب أن يكون 3-24 حرفاً إنجليزياً أو أرقام أو _' });
    }

    if (!/^\S+@\S+\.\S+$/.test(email)) {
      return res.status(400).json({ ok: false, message: 'الإيميل غير صحيح' });
    }

    if (password.length < 6) {
      return res.status(400).json({ ok: false, message: 'كلمة المرور يجب أن تكون 6 أحرف على الأقل' });
    }

    const passwordHash = await bcrypt.hash(password, 10);

    const { data, error } = await supabase
      .from('members')
      .insert([{
        username,
        email,
        password_hash: passwordHash,
        display_name: displayName,
        status: 'active'
      }])
      .select('id, username, email, display_name, score, wins, games_played, avatar_url, status, created_at')
      .single();

    if (error) {
      const message = error.code === '23505'
        ? 'اسم المستخدم أو الإيميل موجود مسبقاً'
        : error.message;
      return res.status(400).json({ ok: false, message });
    }

    const token = jwt.sign(
      { id: data.id, username: data.username, email: data.email, displayName: data.display_name },
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
    const login = String(req.body.username || req.body.login || '').trim().toLowerCase();
    const password = String(req.body.password || '');

    if (!login || !password) {
      return res.status(400).json({ ok: false, message: 'اكتب اسم المستخدم/الإيميل وكلمة المرور' });
    }

    let query = supabase
      .from('members')
      .select('id, username, email, password_hash, display_name, score, wins, games_played, avatar_url, status, created_at')
      .eq(login.includes('@') ? 'email' : 'username', login)
      .single();

    let { data, error } = await query;

    if (error || !data) {
      return res.status(401).json({ ok: false, message: 'بيانات الدخول غير صحيحة' });
    }

    if ((data.status || 'active') === 'banned') {
      return res.status(403).json({ ok: false, message: 'تم إيقاف هذا الحساب من لوحة التحكم' });
    }

    const match = await bcrypt.compare(password, data.password_hash);
    if (!match) {
      return res.status(401).json({ ok: false, message: 'بيانات الدخول غير صحيحة' });
    }

    const token = jwt.sign(
      { id: data.id, username: data.username, email: data.email, displayName: data.display_name },
      JWT_SECRET,
      { expiresIn: '7d' }
    );

    res.setHeader('Set-Cookie', `member_token=${token}; HttpOnly; Path=/; SameSite=Lax; Max-Age=604800`);

    res.json({
      ok: true,
      user: {
        id: data.id,
        username: data.username,
        email: data.email || null,
        display_name: data.display_name,
        score: data.score,
        wins: data.wins || 0,
        games_played: data.games_played || 0,
        avatar_url: data.avatar_url || null,
        status: data.status || 'active',
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
      .select('id, username, email, display_name, score, wins, games_played, avatar_url, status, created_at')
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


// ================= إدارة اللاعبين من لوحة التحكم =================
function cleanUsername(value) {
  return String(value || '').trim().toLowerCase();
}
function cleanEmail(value) {
  return String(value || '').trim().toLowerCase();
}
function publicMemberRow(row) {
  return {
    id: row.id,
    username: row.username,
    email: row.email || '',
    display_name: row.display_name || row.username,
    score: Number(row.score || 0),
    wins: Number(row.wins || 0),
    games_played: Number(row.games_played || 0),
    avatar_url: row.avatar_url || '',
    status: row.status || 'active',
    created_at: row.created_at
  };
}

app.get('/api/admin/members', requireAdmin, async (req, res) => {
  try {
    const q = String(req.query.q || '').trim().toLowerCase();
    let query = supabase
      .from('members')
      .select('id, username, email, display_name, score, wins, games_played, avatar_url, status, created_at')
      .order('created_at', { ascending: false })
      .limit(200);

    if (q) {
      query = query.or(`username.ilike.%${q}%,display_name.ilike.%${q}%,email.ilike.%${q}%`);
    }

    const { data, error } = await query;
    if (error) return res.status(400).json({ ok: false, message: error.message });
    res.json({ ok: true, members: (data || []).map(publicMemberRow) });
  } catch (e) {
    res.status(500).json({ ok: false, message: e.message });
  }
});

app.post('/api/admin/members', requireAdmin, async (req, res) => {
  try {
    const username = cleanUsername(req.body.username);
    const email = cleanEmail(req.body.email);
    const password = String(req.body.password || '');
    const display_name = String(req.body.display_name || username).trim();

    if (!username || !email || !password) return res.status(400).json({ ok: false, message: 'اكتب اليوزر والإيميل والباسوورد' });
    if (!/^[a-z0-9_\.]{3,24}$/.test(username)) return res.status(400).json({ ok: false, message: 'اليوزر غير صحيح' });
    if (!/^\S+@\S+\.\S+$/.test(email)) return res.status(400).json({ ok: false, message: 'الإيميل غير صحيح' });
    if (password.length < 6) return res.status(400).json({ ok: false, message: 'الباسوورد 6 أحرف على الأقل' });

    const password_hash = await bcrypt.hash(password, 10);
    const { data, error } = await supabase
      .from('members')
      .insert([{ username, email, password_hash, display_name, status: 'active' }])
      .select('id, username, email, display_name, score, wins, games_played, avatar_url, status, created_at')
      .single();

    if (error) return res.status(400).json({ ok: false, message: error.code === '23505' ? 'اليوزر أو الإيميل مستخدم مسبقاً' : error.message });
    res.json({ ok: true, member: publicMemberRow(data) });
  } catch (e) {
    res.status(500).json({ ok: false, message: e.message });
  }
});

app.put('/api/admin/members/:id', requireAdmin, async (req, res) => {
  try {
    const id = req.params.id;
    const updates = {};
    if ('username' in req.body) {
      const username = cleanUsername(req.body.username);
      if (!/^[a-z0-9_\.]{3,24}$/.test(username)) return res.status(400).json({ ok: false, message: 'اليوزر غير صحيح' });
      updates.username = username;
    }
    if ('email' in req.body) {
      const email = cleanEmail(req.body.email);
      if (!/^\S+@\S+\.\S+$/.test(email)) return res.status(400).json({ ok: false, message: 'الإيميل غير صحيح' });
      updates.email = email;
    }
    if ('display_name' in req.body) updates.display_name = String(req.body.display_name || '').trim();
    if ('avatar_url' in req.body) updates.avatar_url = String(req.body.avatar_url || '').trim();
    if ('score' in req.body) updates.score = Math.max(0, Number(req.body.score || 0) || 0);
    if ('wins' in req.body) updates.wins = Math.max(0, Number(req.body.wins || 0) || 0);
    if ('games_played' in req.body) updates.games_played = Math.max(0, Number(req.body.games_played || 0) || 0);
    if ('status' in req.body) updates.status = req.body.status === 'banned' ? 'banned' : 'active';

    const { data, error } = await supabase
      .from('members')
      .update(updates)
      .eq('id', id)
      .select('id, username, email, display_name, score, wins, games_played, avatar_url, status, created_at')
      .single();

    if (error) return res.status(400).json({ ok: false, message: error.code === '23505' ? 'اليوزر أو الإيميل مستخدم مسبقاً' : error.message });
    res.json({ ok: true, member: publicMemberRow(data) });
  } catch (e) {
    res.status(500).json({ ok: false, message: e.message });
  }
});

app.post('/api/admin/members/:id/password', requireAdmin, async (req, res) => {
  try {
    const password = String(req.body.password || '');
    if (password.length < 6) return res.status(400).json({ ok: false, message: 'الباسوورد 6 أحرف على الأقل' });
    const password_hash = await bcrypt.hash(password, 10);
    const { error } = await supabase.from('members').update({ password_hash }).eq('id', req.params.id);
    if (error) return res.status(400).json({ ok: false, message: error.message });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, message: e.message });
  }
});

app.delete('/api/admin/members/:id', requireAdmin, async (req, res) => {
  try {
    const { error } = await supabase.from('members').delete().eq('id', req.params.id);
    if (error) return res.status(400).json({ ok: false, message: error.message });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, message: e.message });
  }
});

app.use(express.static(path.join(__dirname, 'public')));

function readJson(file, fallback) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; } }
function writeJson(file, data) { fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8'); }
function readCards() { return readJson(DATA_FILE, []); }
function saveCards(cards) { writeJson(DATA_FILE, cards); }
function currentAiMonth() {
  return new Date().toISOString().slice(0, 7);
}
const DEFAULT_SETTINGS = {
  storyTimer: 45,
  submitTimer: 45,
  voteTimer: 45,
  resultsTimer: 45,
  aiEnabled: false,
  aiMonthlyLimit: 0,
  aiUsage: {
    month: currentAiMonth(),
    requests: 0,
    successes: 0,
    failures: 0
  }
};
function normalizeSettings(raw = {}) {
  const merged = { ...DEFAULT_SETTINGS, ...raw };
  merged.storyTimer = Math.max(5, Math.min(300, Number(merged.storyTimer ?? merged.selectTimer ?? 45) || 45));
  merged.submitTimer = Math.max(5, Math.min(300, Number(merged.submitTimer ?? merged.selectTimer ?? 45) || 45));
  merged.voteTimer = Math.max(5, Math.min(300, Number(merged.voteTimer ?? 45) || 45));
  merged.resultsTimer = Math.max(0, Math.min(300, Number(merged.resultsTimer ?? 45) || 45));
  merged.selectTimer = merged.submitTimer; // توافق مع النسخ القديمة
  merged.aiEnabled = merged.aiEnabled === true || merged.aiEnabled === 'true';
  merged.aiMonthlyLimit = Math.max(0, Math.min(1000000, Number(merged.aiMonthlyLimit || 0) || 0));
  const usage = merged.aiUsage && typeof merged.aiUsage === 'object' ? merged.aiUsage : {};
  merged.aiUsage = {
    month: usage.month || currentAiMonth(),
    requests: Math.max(0, Number(usage.requests || 0) || 0),
    successes: Math.max(0, Number(usage.successes || 0) || 0),
    failures: Math.max(0, Number(usage.failures || 0) || 0)
  };
  if (merged.aiUsage.month !== currentAiMonth()) {
    merged.aiUsage = { month: currentAiMonth(), requests: 0, successes: 0, failures: 0 };
  }
  return merged;
}
function readSettings() { return normalizeSettings(readJson(SETTINGS_FILE, {})); }
function saveSettings(settings) { writeJson(SETTINGS_FILE, normalizeSettings(settings)); }
function recordAiUsage(status = 'success') {
  const settings = readSettings();
  settings.aiUsage.requests += 1;
  if (status === 'success') settings.aiUsage.successes += 1;
  else settings.aiUsage.failures += 1;
  saveSettings(settings);
  return settings.aiUsage;
}
function aiUsageSummary() {
  const settings = readSettings();
  return settings.aiUsage;
}
function readRoomTemplates() { return readJson(ROOM_TEMPLATES_FILE, []); }
function saveRoomTemplates(templates) { writeJson(ROOM_TEMPLATES_FILE, templates); }
function makeId(prefix='id') { return prefix + Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }
function roomCode() { return Math.random().toString(36).slice(2, 6).toUpperCase(); }
function shuffle(arr) { return [...arr].sort(() => Math.random() - 0.5); }
function publicPlayer(p) { return { id: p.id, name: p.name, score: p.score, connected: p.connected, username: p.username || null, memberId: p.memberId || null, isBot: !!p.isBot }; }
function randomFrom(arr) { return arr[Math.floor(Math.random() * arr.length)]; }


// AI Vision bots (optional): يعمل فقط إذا كان OPENAI_API_KEY موجوداً.
// إذا لم يكن المفتاح موجوداً أو فشل الطلب، يرجع البوت للنظام العادي بدون تعطيل اللعبة.
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4.1-mini';
const AI_BOTS_ENABLED = process.env.AI_BOTS_ENABLED !== 'false';
const AI_IMAGE_BASE_URL = (process.env.AI_IMAGE_BASE_URL || process.env.PUBLIC_BASE_URL || process.env.SITE_URL || process.env.APP_URL || '').replace(/\/$/, '');
const AI_CACHE = new Map();

function aiReady() {
  const settings = readSettings();
  if (!settings.aiEnabled) return false;
  if (settings.aiMonthlyLimit && settings.aiUsage.requests >= settings.aiMonthlyLimit) return false;
  return Boolean(AI_BOTS_ENABLED && OPENAI_API_KEY && typeof fetch === 'function');
}

function publicImageUrl(image) {
  const raw = String(image || '').trim();
  if (!raw) return '';
  if (/^https?:\/\//i.test(raw)) return raw;
  if (AI_IMAGE_BASE_URL && raw.startsWith('/')) return AI_IMAGE_BASE_URL + raw;
  return '';
}

function extractResponseText(data) {
  if (!data) return '';
  if (typeof data.output_text === 'string') return data.output_text;
  const parts = [];
  const walk = value => {
    if (!value) return;
    if (typeof value === 'string') return;
    if (Array.isArray(value)) return value.forEach(walk);
    if (typeof value === 'object') {
      if (typeof value.text === 'string') parts.push(value.text);
      if (typeof value.content === 'string') parts.push(value.content);
      Object.values(value).forEach(walk);
    }
  };
  walk(data.output || data);
  return parts.join('\n').trim();
}

function parseJsonObject(text) {
  if (!text) return null;
  try { return JSON.parse(text); } catch {}
  const match = String(text).match(/\{[\s\S]*\}/);
  if (!match) return null;
  try { return JSON.parse(match[0]); } catch { return null; }
}

async function openAiJson(prompt, images = [], cacheKey = '') {
  if (!aiReady()) return null;
  if (cacheKey && AI_CACHE.has(cacheKey)) return AI_CACHE.get(cacheKey);

  const content = [{ type: 'input_text', text: prompt + '\n\nأرجع JSON فقط بدون شرح.' }];
  images.forEach((img, index) => {
    const url = publicImageUrl(img.url || img.image);
    if (!url) return;
    content.push({ type: 'input_text', text: `الصورة رقم ${index + 1}:` });
    content.push({ type: 'input_image', image_url: url, detail: 'low' });
  });
  if (!content.some(x => x.type === 'input_image')) return null;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12000);
  try {
    const resp = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${OPENAI_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: OPENAI_MODEL,
        input: [{ role: 'user', content }],
        max_output_tokens: 350
      }),
      signal: controller.signal
    });
    if (!resp.ok) {
      const err = await resp.text().catch(() => '');
      console.error('OpenAI bot error:', resp.status, err.slice(0, 200));
      recordAiUsage('failure');
      return null;
    }
    const data = await resp.json();
    recordAiUsage('success');
    const json = parseJsonObject(extractResponseText(data));
    if (json && cacheKey) AI_CACHE.set(cacheKey, json);
    return json;
  } catch (e) {
    console.error('OpenAI bot request failed:', e.message);
    recordAiUsage('failure');
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

function botAiProbability(bot) {
  const level = botSkillForPlayer(bot).level;
  if (level === 'easy') return 0.35;
  if (level === 'smart') return 0.95;
  return 0.70;
}

function shouldUseAiForBot(bot) {
  return aiReady() && Math.random() < botAiProbability(bot);
}

function normalizeAiIndex(value, length) {
  const n = Number(value);
  if (!Number.isFinite(n)) return -1;
  const idx = Math.trunc(n) - 1;
  return idx >= 0 && idx < length ? idx : -1;
}

function sanitizeArabicHint(raw) {
  const text = String(raw || '').trim();
  if (!text) return '';
  // يمنع الإنجليزي، الأرقام، الإيموجي، والرموز الغريبة بالكامل.
  if (/[A-Za-z0-9]/.test(text)) return '';
  const normalized = text
    .replace(/[ـًٌٍَُِّْٰ]/g, '')
    .replace(/["'`“”‘’.,!?؟،؛:;()\[\]{}<>\/|@#$%^&*_+=~\-–—]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  // بعد التنظيف يجب أن يبقى النص عربياً فقط ومسافات.
  if (!/^[ء-ي\s]+$/.test(normalized)) return '';
  const words = normalized.match(/[ء-ي]+/g) || [];
  if (words.length < 2 || words.length > 5) return '';
  return words.join(' ');
}

function botHintKey(hint) {
  return sanitizeArabicHint(hint).replace(/\s+/g, ' ').trim();
}

function isBotHintUsed(room, hint) {
  const key = botHintKey(hint);
  if (!key) return true;
  const used = new Set((room?.usedBotHints || []).map(botHintKey).filter(Boolean));
  return used.has(key);
}

function rememberBotHint(room, hint) {
  const key = botHintKey(hint);
  if (!key || !room) return;
  room.usedBotHints = room.usedBotHints || [];
  if (!room.usedBotHints.map(botHintKey).includes(key)) room.usedBotHints.push(key);
}

function safeBotHintFallback(card, room = null) {
  const pool = [...BOT_HINTS, ...BOT_STYLE_HINTS]
    .map(sanitizeArabicHint)
    .filter(Boolean)
    .filter(h => !room || !isBotHintUsed(room, h));
  const picked = randomFrom(pool);
  if (picked) return picked;

  const emergency = ['حلم قديم', 'سر صغير', 'رحلة غريبة', 'ظل طويل', 'أمل بعيد', 'صوت الصمت']
    .map(sanitizeArabicHint)
    .find(h => h && (!room || !isBotHintUsed(room, h)));
  return emergency || 'حلم قديم';
}

async function chooseBotStoryMoveAI(room, botId) {
  const hand = room.hands?.[botId] || [];
  if (!hand.length) return null;
  const bot = room.players.find(p => p.id === botId);
  if (!shouldUseAiForBot(bot)) return null;

  const images = hand.map(c => ({ image: c.image }));
  const prompt = `أنت لاعب في لعبة Dixit. اختر من الصور صورة تصلح أن تكون كرت الراوي، واكتب تلميحاً عربياً قصيراً وغامضاً.
قواعد التلميح إجبارية:
- عربي فقط.
- من 2 إلى 5 كلمات فقط.
- حروف عربية ومسافات فقط.
- ممنوع الإنجليزي والأرقام والرموز والإيموجي وعلامات الترقيم.
- لا تستخدم اسم الملف أو عنوان الصورة أو أي نص ظاهر بجانب الصورة.
- لا تصف الصورة مباشرة؛ اجعله غامضاً ومخادعاً وله علاقة بالمعنى العام.
التلميحات المستخدمة سابقاً في هذه المباراة ممنوع تكرارها: ${(room.usedBotHints || []).join('، ') || 'لا يوجد'}.
أرجع JSON فقط بهذا الشكل: {"index": رقم_الصورة, "hint": "التلميح"}`;
  const json = await openAiJson(prompt, images, 'story:' + images.map(i => i.image).join('|'));
  const idx = normalizeAiIndex(json?.index, hand.length);
  const hint = sanitizeArabicHint(json?.hint);
  if (idx < 0 || !hint || isBotHintUsed(room, hint)) return null;
  return { card: hand[idx], hint };
}

async function chooseBotSubmitCardAI(room, botId) {
  const hand = room.hands?.[botId] || [];
  if (!hand.length || !room.hint) return null;
  const bot = room.players.find(p => p.id === botId);
  if (!shouldUseAiForBot(bot)) return null;

  const images = hand.map(c => ({ image: c.image }));
  const prompt = `أنت لاعب في Dixit. التلميح هو: "${String(room.hint).slice(0, 80)}".
اختر من صور يدك صورة يمكن أن تخدع اللاعبين وتبدو مناسبة للتلميح، لكن لا تجعل الاختيار عشوائياً.
لا تختَر بناءً على اسم الملف، بل على معنى الصورة.
أرجع JSON بهذا الشكل فقط: {"index": رقم_الصورة}`;
  const json = await openAiJson(prompt, images, 'submit:' + room.hint + ':' + images.map(i => i.image).join('|'));
  const idx = normalizeAiIndex(json?.index, hand.length);
  return idx >= 0 ? hand[idx] : null;
}

async function botVoteChoiceAI(room, botId) {
  const options = (room.tableCards || []).filter(c => c.ownerId !== botId);
  if (!options.length || !room.hint) return null;
  const bot = room.players.find(p => p.id === botId);
  if (!shouldUseAiForBot(bot)) return null;

  const images = options.map(c => ({ image: c.image }));
  const prompt = `أنت لاعب في Dixit. التلميح هو: "${String(room.hint).slice(0, 80)}".
اختر الصورة التي تعتقد أنها كرت الراوي الحقيقي. لا يمكنك اختيار كرتك أنت، والخيارات المعروضة لا تحتوي على كرتك.
اختر بناءً على معنى الصورة وعلاقتها بالتلميح، وليس اسم الملف.
أرجع JSON بهذا الشكل فقط: {"index": رقم_الصورة}`;
  const json = await openAiJson(prompt, images, 'vote:' + room.hint + ':' + images.map(i => i.image).join('|'));
  const idx = normalizeAiIndex(json?.index, options.length);
  return idx >= 0 ? options[idx] : null;
}



const BOT_NAMES = ['بوت نورة', 'بوت سالم', 'بوت لولو', 'بوت بدر', 'بوت دانة', 'بوت فهد', 'بوت مريم', 'بوت راشد'];
const BOT_HINTS = [
  'حلم قديم', 'سر صغير', 'رحلة غريبة', 'خارج الواقع', 'ذكرى بعيدة',
  'هدوء مخيف', 'باب جديد', 'قصة ناقصة', 'ضوء في العتمة', 'شيء لا يقال',
  'بين الخوف والأمل', 'الطريق المختفي', 'صوت من بعيد', 'قرار صعب', 'مكان لا يعود',
  'ظل طويل', 'وعد قديم', 'ليل بلا نجوم', 'حكاية صامتة', 'باب الذاكرة',
  'خوف جميل', 'أمل بعيد', 'سر في الظلام', 'رحلة داخلية', 'نهاية مفتوحة',
  'صوت الصمت', 'حلم مكسور', 'مدينة نائمة', 'شيء ينتظر', 'طريق بلا عودة',
  'فرح ناقص', 'رسالة قديمة', 'عين لا تنام', 'قلب تائه', 'ضوء خافت'
];
const BOT_STYLE_HINTS = [
  'ليس كما يبدو', 'قبل النهاية', 'بعد الصمت', 'بلا صوت', 'خلف الباب',
  'تحت القمر', 'بين عالمين', 'وراء الحلم', 'داخل الظل', 'قرب النهاية'
];
const BOT_SKILLS = [
  { level: 'easy', accuracy: 0.28, matchBias: 0.25, bluffBias: 0.20 },
  { level: 'normal', accuracy: 0.45, matchBias: 0.50, bluffBias: 0.35 },
  { level: 'smart', accuracy: 0.62, matchBias: 0.75, bluffBias: 0.55 }
];
const BOT_STOP_WORDS = new Set(['image','img','photo','picture','card','dixit','the','and','with','from','room','new','copy','final','jpg','jpeg','png','webp','svg','صورة','كرت','لعبة','نهائي','نسخة']);
function isBotPlayer(p) { return !!p?.isBot; }
function botSkillForPlayer(bot) {
  if (bot?.botSkill) return BOT_SKILLS.find(s => s.level === bot.botSkill) || BOT_SKILLS[1];
  return BOT_SKILLS[1];
}
function cleanTextTokens(value) {
  return String(value || '')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/[_\-.\/\?=&%#0-9]+/g, ' ')
    .replace(/[^\w\s؀-ۿ]/g, ' ')
    .toLowerCase()
    .split(/\s+/)
    .map(w => w.trim())
    .filter(w => w.length > 2 && !BOT_STOP_WORDS.has(w));
}
function cardText(card) {
  const urlTail = String(card?.image || '').split('/').pop() || '';
  return `${card?.title || ''} ${card?.category || ''} ${urlTail}`;
}
function cardTokens(card) { return cleanTextTokens(cardText(card)); }
function similarityScore(card, hint) {
  const a = new Set(cardTokens(card));
  const b = new Set(cleanTextTokens(hint));
  if (!a.size || !b.size) return Math.random() * 0.05;
  let score = 0;
  b.forEach(t => { if (a.has(t)) score += 1; });
  return score / Math.max(1, Math.sqrt(a.size * b.size));
}
function weightedPick(items, weightFn) {
  if (!items.length) return null;
  const weighted = items.map(item => ({ item, weight: Math.max(0.01, Number(weightFn(item)) || 0.01) }));
  const total = weighted.reduce((s, x) => s + x.weight, 0);
  let r = Math.random() * total;
  for (const x of weighted) {
    r -= x.weight;
    if (r <= 0) return x.item;
  }
  return weighted[weighted.length - 1].item;
}
function botNameForRoom(room) {
  const used = new Set((room.players || []).map(p => p.name));
  return BOT_NAMES.find(n => !used.has(n)) || `بوت ${Math.floor(100 + Math.random() * 900)}`;
}
function makeBotPlayer(room) {
  const skill = randomFrom(BOT_SKILLS);
  return {
    id: makeId('bot'),
    name: botNameForRoom(room),
    score: 0,
    connected: true,
    isBot: true,
    botSkill: skill.level,
    memberId: null,
    username: null
  };
}
function generateBotHint(card, room = null) {
  // البوت العادي لا يستخدم اسم الصورة أو اسم الملف نهائياً حتى لا تظهر تلميحات غريبة.
  // كل التلميحات عربية فقط، بدون رموز، ومن 2 إلى 5 كلمات، ولا تتكرر داخل نفس المباراة.
  const pool = [...BOT_HINTS, ...BOT_STYLE_HINTS]
    .map(sanitizeArabicHint)
    .filter(Boolean)
    .filter(h => !room || !isBotHintUsed(room, h));
  return randomFrom(pool) || safeBotHintFallback(card, room);
}
function chooseBotCard(room, botId, purpose = 'submit') {
  const hand = room.hands?.[botId] || [];
  if (!hand.length) return null;
  const bot = room.players.find(p => p.id === botId);
  const skill = botSkillForPlayer(bot);

  if (purpose === 'submit' && room.hint) {
    const best = weightedPick(hand, card => {
      const sim = similarityScore(card, room.hint);
      return 1 + (sim * 10 * skill.bluffBias) + Math.random();
    });
    if (best && Math.random() < skill.matchBias) return best;
  }

  if (purpose === 'story') {
    return weightedPick(hand, card => 1 + Math.min(4, cardTokens(card).length));
  }

  return randomFrom(hand);
}
function botVoteChoice(room, botId) {
  const options = (room.tableCards || []).filter(c => c.ownerId !== botId);
  if (!options.length) return null;
  const bot = room.players.find(p => p.id === botId);
  const skill = botSkillForPlayer(bot);
  const storytellerCard = options.find(c => c.ownerId === room.storytellerId);
  const decoys = options.filter(c => c.ownerId !== room.storytellerId);

  const bestByHint = weightedPick(options, card => {
    const sim = similarityScore(card, room.hint);
    const storytellerBoost = card.ownerId === room.storytellerId ? skill.accuracy : 0;
    return 1 + sim * 12 + storytellerBoost * 2 + Math.random();
  });

  if (storytellerCard && Math.random() < skill.accuracy) return storytellerCard;
  if (bestByHint && Math.random() < skill.matchBias) return bestByHint;
  return randomFrom(decoys.length ? decoys : options);
}
function maybeFinishSubmit(room) {
  const needed = room.players.filter(p => p.connected && !room.skippedPlayers?.[p.id]).length;
  if (room.phase === 'submit' && Object.keys(room.submissions || {}).length >= needed) prepareVoting(room);
}
function maybeFinishVoting(room) {
  const needed = room.players.filter(p => p.connected && p.id !== room.storytellerId && !room.skippedPlayers?.[p.id]).length;
  if (room.phase === 'voting' && Object.keys(room.votes || {}).length >= needed) scoreRound(room);
}
function runBots(room) {
  if (!room) return;

  if (room.phase === 'story') {
    const storyteller = room.players.find(p => p.id === room.storytellerId);
    if (!isBotPlayer(storyteller)) return;
    setTimeout(async () => {
      if (!room || room.phase !== 'story' || room.storytellerId !== storyteller.id) return;
      const aiMove = await chooseBotStoryMoveAI(room, storyteller.id).catch(() => null);
      const chosen = aiMove?.card || chooseBotCard(room, storyteller.id, 'story');
      if (!chosen) return autoStory(room);
      const card = removeFromHand(room, storyteller.id, chosen.id);
      if (!card) return;
      room.hint = aiMove?.hint || safeBotHintFallback(card, room);
      rememberBotHint(room, room.hint);
      room.storyCardId = card.id;
      room.submissions[storyteller.id] = card;
      room.phase = 'submit';
      setPhaseTimer(room, room.settings.submitTimer, () => autoSubmit(room));
      emitRoom(room.code);
      runBots(room);
    }, 900 + Math.floor(Math.random() * 1200));
    return;
  }

  if (room.phase === 'submit') {
    const bots = room.players.filter(p => isBotPlayer(p) && p.id !== room.storytellerId && !room.submissions?.[p.id] && !room.skippedPlayers?.[p.id]);
    bots.forEach((bot, i) => {
      setTimeout(async () => {
        if (!room || room.phase !== 'submit' || room.submissions?.[bot.id] || room.skippedPlayers?.[bot.id]) return;
        const aiChosen = await chooseBotSubmitCardAI(room, bot.id).catch(() => null);
        const chosen = aiChosen || chooseBotCard(room, bot.id, 'submit');
        if (!chosen) return;
        const card = removeFromHand(room, bot.id, chosen.id);
        if (!card) return;
        room.submissions[bot.id] = card;
        const previousPhase = room.phase;
        maybeFinishSubmit(room);
        if (room.phase !== previousPhase) emitRoom(room.code);
        if (room.phase === 'voting') runBots(room);
      }, 900 + i * 700 + Math.floor(Math.random() * 700));
    });
    return;
  }

  if (room.phase === 'voting') {
    const bots = room.players.filter(p => isBotPlayer(p) && p.id !== room.storytellerId && !room.votes?.[p.id] && !room.skippedPlayers?.[p.id]);
    bots.forEach((bot, i) => {
      setTimeout(async () => {
        if (!room || room.phase !== 'voting' || room.votes?.[bot.id] || room.skippedPlayers?.[bot.id]) return;
        const aiChoice = await botVoteChoiceAI(room, bot.id).catch(() => null);
        const choice = aiChoice || botVoteChoice(room, bot.id);
        if (!choice) return;
        room.votes[bot.id] = choice.tableId;
        const previousPhase = room.phase;
        maybeFinishVoting(room);
        if (room.phase !== previousPhase || room.phase === 'results' || room.phase === 'ended') emitRoom(room.code);
      }, 1000 + i * 800 + Math.floor(Math.random() * 900));
    });
  }
}

// منع تكرار الصور داخل اليد أو بين اللاعبين أو على الطاولة
function cardUniqueKey(card) {
  return String(card?.image || card?.id || '').trim();
}

function inPlayCardKeys(room) {
  const keys = new Set();
  Object.values(room.hands || {}).flat().forEach(card => {
    const key = cardUniqueKey(card);
    if (key) keys.add(key);
  });
  Object.values(room.submissions || {}).forEach(card => {
    const key = cardUniqueKey(card);
    if (key) keys.add(key);
  });
  (room.tableCards || []).forEach(card => {
    const key = cardUniqueKey(card);
    if (key) keys.add(key);
  });
  return keys;
}

function resetDeck(room, sourceCards) {
  const source = sourceCards || room.deckCards || readCards();
  const usedIds = new Set(room.usedCardIds || []);
  const blockedKeys = inPlayCardKeys(room);
  const seenKeys = new Set();

  let available = shuffle(source).filter(card => {
    const key = cardUniqueKey(card);
    if (!key || seenKeys.has(key) || blockedKeys.has(key) || usedIds.has(card.id)) return false;
    seenKeys.add(key);
    return true;
  });

  // إذا خلصت كل الصور غير المستخدمة، نبدأ دورة جديدة، لكن لا نكرر أي صورة موجودة حالياً في يد لاعب أو على الطاولة.
  if (!available.length) {
    room.usedCardIds = [];
    seenKeys.clear();
    available = shuffle(source).filter(card => {
      const key = cardUniqueKey(card);
      if (!key || seenKeys.has(key) || blockedKeys.has(key)) return false;
      seenKeys.add(key);
      return true;
    });
  }

  room.deck = available;
}

function drawCard(room) {
  const blockedKeys = inPlayCardKeys(room);
  let attempts = 0;
  while (attempts < 3) {
    if (!room.deck || room.deck.length === 0) resetDeck(room, room.deckCards || readCards());
    while (room.deck && room.deck.length) {
      const card = room.deck.pop();
      const key = cardUniqueKey(card);
      if (!key || blockedKeys.has(key)) continue;
      room.usedCardIds = room.usedCardIds || [];
      if (card?.id) room.usedCardIds.push(card.id);
      return card;
    }
    attempts += 1;
    resetDeck(room, room.deckCards || readCards());
  }
  return null;
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
app.get('/api/settings', (_, res) => {
  const settings = readSettings();
  res.json({
    ...settings,
    aiReady: aiReady(),
    hasOpenAiKey: Boolean(OPENAI_API_KEY),
    aiModel: OPENAI_MODEL,
    aiUsage: aiUsageSummary()
  });
});
app.post('/api/settings', requireAdmin, (req, res) => {
  const current = readSettings();
  const incoming = req.body || {};
  const settings = normalizeSettings({
    ...current,
    storyTimer: incoming.storyTimer ?? incoming.selectTimer ?? current.storyTimer,
    submitTimer: incoming.submitTimer ?? incoming.selectTimer ?? current.submitTimer,
    voteTimer: incoming.voteTimer ?? current.voteTimer,
    resultsTimer: incoming.resultsTimer ?? current.resultsTimer,
    aiEnabled: incoming.aiEnabled ?? current.aiEnabled,
    aiMonthlyLimit: incoming.aiMonthlyLimit ?? current.aiMonthlyLimit,
    aiUsage: current.aiUsage
  });
  saveSettings(settings);
  // حدّث إعدادات الغرف النشطة أيضاً حتى لا تنتظر بدء مباراة جديدة
  Object.values(rooms || {}).forEach(room => {
    room.settings = { ...(room.settings || {}), ...settings };
  });
  res.json({ ok: true, settings: { ...settings, aiReady: aiReady(), hasOpenAiKey: Boolean(OPENAI_API_KEY), aiModel: OPENAI_MODEL } });
});
app.post('/api/settings/ai-usage/reset', requireAdmin, (req, res) => {
  const settings = readSettings();
  settings.aiUsage = { month: currentAiMonth(), requests: 0, successes: 0, failures: 0 };
  saveSettings(settings);
  res.json({ ok: true, aiUsage: settings.aiUsage });
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
    kickedMemberIds: [], kickedSocketIds: [],
    settings: readSettings(), lastWinner: null, roundGained: {}, deck: [], usedCardIds: [], usedBotHints: [], tieBreakActive: false, tieBreakPlayers: []
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
    tieBreakActive: !!room.tieBreakActive, tieBreakPlayers: room.tieBreakPlayers || [],
    hostId: room.hostId, storytellerId: room.storytellerId, hint: room.hint,
    players: room.players.map(publicPlayer),
    tableCards: (showRoundDetails
      ? [...(room.tableCards || [])].sort((a, b) => (a.ownerId === room.storytellerId ? -1 : b.ownerId === room.storytellerId ? 1 : 0))
      : (room.tableCards || [])
    ).map(c => {
      const owner = room.players.find(p => p.id === c.ownerId);
      const voters = Object.entries(room.votes || {})
        .filter(([pid, tableId]) => tableId === c.tableId && !room.skippedPlayers?.[pid])
        .map(([pid]) => {
          const voter = room.players.find(p => p.id === pid);
          return voter ? { id: pid, name: voter.name || 'لاعب', roundPoints: (room.roundGained || {})[pid] || 0 } : null;
        })
        .filter(Boolean);
      return {
        id: c.tableId, image: c.image, title: c.title,
        ownerName: showRoundDetails ? (owner?.name || 'لاعب') : null,
        ownerRoundPoints: showRoundDetails ? ((room.roundGained || {})[c.ownerId] || 0) : 0,
        voters: showRoundDetails ? voters.map(v => v.name) : [],
        voterDetails: showRoundDetails ? voters : [],
        isStorytellerCard: showRoundDetails ? c.ownerId === room.storytellerId : false
      };
    }),
    roundGained: showRoundDetails ? room.players.map(p => ({ id: p.id, name: p.name || 'لاعب', points: (room.roundGained || {})[p.id] || 0 })) : [],
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
  room.round += 1; room.phase = 'story'; room.hint = ''; room.storyCardId = null; room.submissions = {}; room.votes = {}; room.skippedPlayers = {}; room.tableCards = []; room.lastWinner = null; room.roundGained = {};
  // إذا كانت هناك حالة تعادل، تبقى مفعلة حتى يظهر فائز منفرد
  if (!room.tieBreakActive) room.tieBreakPlayers = [];
  room.storytellerIndex = (room.storytellerIndex + 1) % room.players.length;
  room.storytellerId = room.players[room.storytellerIndex].id;
  if (!Object.keys(room.hands).length) deal(room, room.deckCards);
  setPhaseTimer(room, room.settings.storyTimer, () => autoStory(room));
  runBots(room);
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
  runBots(room);
}
function autoStory(room) {
  if (!room || room.phase !== 'story') return;
  const hand = room.hands[room.storytellerId] || [];
  if (!hand.length) return;
  const card = removeFromHand(room, room.storytellerId, hand[0].id);
  room.hint = safeBotHintFallback(card, room);
  rememberBotHint(room, room.hint);
  room.storyCardId = card.id;
  room.submissions[room.storytellerId] = card;
  room.phase = 'submit';
  setPhaseTimer(room, room.settings.submitTimer, () => autoSubmit(room));
  emitRoom(room.code);
  runBots(room);
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

  room.roundGained = { ...gained };

  room.players.forEach(p => refillHand(room, p.id));

  room.phase = 'results';

  // نظام كسر التعادل:
  // إذا وصل أكثر من لاعب إلى أعلى نتيجة بعد تجاوز/بلوغ الهدف، لا تنتهي اللعبة.
  // تبدأ جولة إضافية حتى يصبح هناك فائز واحد فقط بالمركز الأول.
  const sortedPlayers = [...room.players].sort((a, b) => (b.score || 0) - (a.score || 0));
  const topScore = sortedPlayers[0]?.score || 0;
  const topPlayers = sortedPlayers.filter(p => (p.score || 0) === topScore);

  if (topScore >= room.targetScore) {
    if (topPlayers.length === 1) {
      const winner = topPlayers[0];
      room.tieBreakActive = false;
      room.tieBreakPlayers = [];
      room.phase = 'ended';
      room.lastWinner = { name: winner.name, score: winner.score };

      // حفظ الفوز وعدد الألعاب للأعضاء المسجلين
      room.players.forEach(p => {
        if (p.memberId) {
          updateMemberStats(p.memberId, {
            win: p.id === winner.id,
            gamePlayed: true
          });
        }
      });

      saveMatchHistory(room);
      io.to(room.code).emit('gameWinner', room.lastWinner);
    } else {
      room.tieBreakActive = true;
      room.tieBreakPlayers = topPlayers.map(p => ({ id: p.id, name: p.name, score: p.score }));
      io.to(room.code).emit('tieBreak', {
        message: 'تعادل على المركز الأول! ستبدأ جولة كسر التعادل.',
        players: room.tieBreakPlayers
      });
    }
  }

  // مؤقت عرض النتائج: إذا كان أكبر من صفر ينتقل تلقائياً للجولة التالية.
  if (room.phase === 'results' && Number(room.settings?.resultsTimer || 0) > 0) {
    setPhaseTimer(room, room.settings.resultsTimer, () => {
      if (!room || room.phase !== 'results') return;
      startRound(room);
      emitRoom(room.code);
    });
  }
}


function isPlayerKicked(room, socketId, memberId) {
  if (!room) return false;
  return (memberId && (room.kickedMemberIds || []).includes(memberId)) ||
    (socketId && (room.kickedSocketIds || []).includes(socketId));
}

function removePlayerRuntimeData(room, playerId) {
  if (!room || !playerId) return;
  if (room.hands) delete room.hands[playerId];
  if (room.submissions) delete room.submissions[playerId];
  if (room.votes) delete room.votes[playerId];
  if (room.skippedPlayers) delete room.skippedPlayers[playerId];
  if (Array.isArray(room.tableCards)) {
    room.tableCards = room.tableCards.filter(c => c.ownerId !== playerId);
  }
}

function normalizeAfterKick(room, kickedWasStoryteller = false) {
  if (!room) return;

  // إذا لم يبق عدد كافٍ من اللاعبين، أعد الغرفة للانتظار بدل استمرار جولة ناقصة
  if (room.players.length < 2) {
    clearTimer(room);
    room.phase = 'lobby';
    room.storytellerIndex = -1;
    room.storytellerId = null;
    room.hint = '';
    room.storyCardId = null;
    room.submissions = {};
    room.votes = {};
    room.skippedPlayers = {};
    room.tableCards = [];
    room.timerEndsAt = null;
    return;
  }

  if (kickedWasStoryteller && room.phase !== 'lobby') {
    // طرد الراوي أثناء جولة نشطة: نبدأ جولة جديدة نظيفة حتى لا تتعلق اللعبة
    const oldStorytellerIndex = Math.max(0, Math.min(room.storytellerIndex || 0, room.players.length - 1));
    room.storytellerIndex = oldStorytellerIndex - 1;
    startRound(room);
    return;
  }

  if (room.phase === 'submit') {
    const needed = room.players.filter(p => p.connected && !room.skippedPlayers?.[p.id]).length;
    if (Object.keys(room.submissions || {}).length >= needed) prepareVoting(room);
  }

  if (room.phase === 'voting') {
    const needed = room.players.filter(p => p.connected && p.id !== room.storytellerId && !room.skippedPlayers?.[p.id]).length;
    if (Object.keys(room.votes || {}).length >= needed) scoreRound(room);
  }
}

function kickPlayerFromRoom(room, targetId, reason = 'تم طردك من الغرفة بواسطة صاحب الغرفة') {
  const idx = room.players.findIndex(p => p.id === targetId);
  if (idx === -1) return { ok: false, message: 'اللاعب غير موجود' };

  const target = room.players[idx];
  if (target.id === room.hostId) return { ok: false, message: 'لا يمكن طرد صاحب الغرفة' };

  room.kickedMemberIds = room.kickedMemberIds || [];
  room.kickedSocketIds = room.kickedSocketIds || [];
  if (target.memberId && !room.kickedMemberIds.includes(target.memberId)) room.kickedMemberIds.push(target.memberId);
  if (target.id && !room.kickedSocketIds.includes(target.id)) room.kickedSocketIds.push(target.id);

  const kickedWasStoryteller = target.id === room.storytellerId;
  room.players.splice(idx, 1);
  removePlayerRuntimeData(room, target.id);

  io.to(target.id).emit('kickedFromRoom', { code: room.code, message: reason });
  const targetSocket = io.sockets.sockets.get(target.id);
  if (targetSocket) targetSocket.leave(room.code);

  normalizeAfterKick(room, kickedWasStoryteller);
  return { ok: true };
}


function reconnectExistingPlayer(room, socket, member, fallbackName = 'لاعب') {
  if (!room || !member?.id) return false;

  if (isPlayerKicked(room, socket.id, member.id)) return false;

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
    if (isPlayerKicked(room, socket.id, member.id)) return socket.emit('errorMessage','تم طردك من هذه الغرفة ولا يمكنك الرجوع إليها');

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
    if (isPlayerKicked(room, socket.id, member?.id)) return socket.emit('errorMessage','تم طردك من هذه الغرفة ولا يمكنك الرجوع إليها');
    if (!reconnectExistingPlayer(room, socket, member)) {
      return socket.emit('errorMessage','لم يتم العثور على لاعب سابق بنفس الحساب داخل هذه الغرفة');
    }

    socket.emit('reconnectedToRoom', {
      code,
      message: 'تمت إعادتك لنفس الغرفة بنفس النقاط والكروت'
    });
    emitRoom(code);
  });

  socket.on('kickPlayer', ({ code, playerId }) => {
    code = (code || '').toUpperCase();
    const room = rooms[code];
    if (!room) return socket.emit('errorMessage','الغرفة غير موجودة');
    if (room.hostId !== socket.id) return socket.emit('errorMessage','هذه الخاصية لصاحب الغرفة فقط');
    if (!playerId || playerId === socket.id) return socket.emit('errorMessage','لا يمكنك طرد نفسك');

    const result = kickPlayerFromRoom(room, playerId);
    if (!result.ok) return socket.emit('errorMessage', result.message || 'تعذر طرد اللاعب');

    socket.emit('successMessage', 'تم طرد اللاعب من الغرفة');
    emitRoom(code);
  });


  socket.on('addBot', ({ code, count = 1 } = {}) => {
    code = (code || '').toUpperCase();
    const room = rooms[code];
    if (!room) return socket.emit('errorMessage','الغرفة غير موجودة');
    if (room.hostId !== socket.id) return socket.emit('errorMessage','هذه الخاصية لصاحب الغرفة فقط');
    if (room.phase !== 'lobby') return socket.emit('errorMessage','يمكن إضافة البوتات قبل بدء اللعبة فقط');

    const amount = Math.max(1, Math.min(5, Number(count) || 1));
    const maxPlayers = 8;
    for (let i = 0; i < amount && room.players.length < maxPlayers; i++) {
      room.players.push(makeBotPlayer(room));
    }
    emitRoom(code);
  });

  socket.on('startGame', async code => { const room = rooms[(code||'').toUpperCase()]; if (!room || room.hostId !== socket.id) return; if (room.players.filter(p=>p.connected).length < 2) return socket.emit('errorMessage','تحتاج لاعبين على الأقل'); if (!room.deckCards || !room.deckCards.length) { const t = await getRoomTemplateById(room.templateId); room.deckCards = t ? await cardsForTemplate(t) : []; } if (!ensureEnoughCards(room.deckCards)) return socket.emit('errorMessage','أضف صوراً لهذه الغرفة من لوحة التحكم'); room.settings = readSettings(); deal(room, room.deckCards); startRound(room); emitRoom(room.code); });
  socket.on('storySubmit', ({ code, cardId, hint }) => { const room = rooms[(code||'').toUpperCase()]; if (!room || socket.id !== room.storytellerId || room.phase !== 'story') return; const card = removeFromHand(room, socket.id, cardId); if (!card) return; room.hint = hint || 'بدون تلميح'; room.storyCardId = cardId; room.submissions[socket.id] = card; room.phase = 'submit'; setPhaseTimer(room, room.settings.submitTimer, () => autoSubmit(room)); emitRoom(room.code); runBots(room); });
  socket.on('submitCard', ({ code, cardId }) => { const room = rooms[(code||'').toUpperCase()]; if (!room || socket.id === room.storytellerId || room.phase !== 'submit' || room.submissions[socket.id]) return;
    if (room.skippedPlayers?.[socket.id]) return;
    const card = removeFromHand(room, socket.id, cardId);
    if (!card) return;
    room.submissions[socket.id] = card;
    socket.emit('choiceAccepted', { type: 'submit', cardId });
    socket.emit('yourHand', room.hands[socket.id] || []);
    const needed = room.players.filter(p => p.connected && !room.skippedPlayers?.[p.id]).length;
    if (Object.keys(room.submissions).length >= needed) {
      prepareVoting(room);
      emitRoom(room.code);
    }
  });
  socket.on('vote', ({ code, tableId }) => { const room = rooms[(code||'').toUpperCase()]; if (!room || socket.id === room.storytellerId || room.phase !== 'voting') return;
    if (room.skippedPlayers?.[socket.id]) return;
    const card = room.tableCards.find(c => c.tableId === tableId);
    if (!card) return;
    if (card.ownerId === socket.id) return socket.emit('errorMessage', 'لا يمكنك اختيار كرتك');
    if (room.votes?.[socket.id]) return socket.emit('choiceAccepted', { type: 'vote', tableId: room.votes[socket.id] });
    room.votes[socket.id] = tableId;
    socket.emit('choiceAccepted', { type: 'vote', tableId });
    const needed = room.players.filter(p => p.connected && p.id !== room.storytellerId && !room.skippedPlayers?.[p.id]).length;
    if (Object.keys(room.votes).length >= needed) {
      scoreRound(room);
      emitRoom(room.code);
    }
  });
  socket.on('nextRound', code => { const room = rooms[(code||'').toUpperCase()]; if (!room || room.hostId !== socket.id || room.phase !== 'results') return; startRound(room); emitRoom(room.code); });
  socket.on('disconnect', () => { Object.values(rooms).forEach(room => { const p = room.players.find(x => x.id === socket.id); if (p) { p.connected = false; p.disconnectedAt = Date.now(); emitRoom(room.code); } }); });
});
server.listen(PORT, () => console.log(`Game running at http://localhost:${PORT}`));