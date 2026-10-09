// whatsappDIaa server v3: saved contacts, offline messages, push notifications
// Render -> Environment: FAMILY_PASSWORD, ALLOWED_ORIGIN, SUPABASE_URL, SUPABASE_KEY
const express = require('express');
const http = require('http');
const crypto = require('crypto');
const cors = require('cors');
const webpush = require('web-push');
const { Server } = require('socket.io');

const PASSWORD = process.env.FAMILY_PASSWORD;
const ORIGIN = process.env.ALLOWED_ORIGIN || '*';
const SB_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SB_KEY = process.env.SUPABASE_KEY || '';
if (!PASSWORD) { console.error('Missing FAMILY_PASSWORD env variable'); process.exit(1); }
const DB = !!(SB_URL && SB_KEY);
const GROUP = '__group';
const enc = encodeURIComponent;
let vapidPublic = '';

// ---------- tiny Supabase client (no extra library) ----------
async function sb(path, opts = {}) {
  if (!DB) return null;
  try {
    const headers = { apikey: SB_KEY, 'Content-Type': 'application/json', Prefer: 'return=minimal', ...(opts.headers || {}) };
    if (SB_KEY.startsWith('eyJ')) headers.Authorization = 'Bearer ' + SB_KEY; // old-style key; new sb_secret_ keys use apikey only
    const r = await fetch(SB_URL + '/rest/v1/' + path, { ...opts, headers });
    if (!r.ok) { console.error('DB error', r.status, (await r.text()).slice(0, 200)); return null; }
    const t = await r.text(); return t ? JSON.parse(t) : [];
  } catch (e) { console.error('DB failed', e.message); return null; }
}
const upsert = (table, conflict, row) => sb(table + '?on_conflict=' + conflict, { method: 'POST', headers: { Prefer: 'resolution=merge-duplicates,return=minimal' }, body: JSON.stringify(row) });

const app = express();
app.use(cors({ origin: ORIGIN }));
app.get('/', (req, res) => res.send('whatsappDIaa server is awake')); // ping this with UptimeRobot
app.get('/vapid', (req, res) => res.json({ key: vapidPublic }));

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: ORIGIN }, maxHttpBufferSize: 5e6, pingInterval: 10000, pingTimeout: 8000 });

const users = new Map();        // lowercase name -> { username, avatar, status, socketId }
const msgOwners = new Map();    // message id -> { from, to }
const pendingCalls = new Map(); // lowercase name -> { data, exp } (call waiting for someone who is offline)
const ringing = new Map();      // callee key -> { from, name, type } until they answer
const busy = new Map();         // lowercase name -> lowercase name of call partner
const TYPES = ['text', 'photo', 'voice', 'video', 'html', 'file', 'gif', 'poll'];
const PUSH_HOSTS = /^https:\/\/(fcm\.googleapis\.com|android\.googleapis\.com|updates\.push\.services\.mozilla\.com|[\w.-]+\.push\.apple\.com|[\w.-]+\.notify\.windows\.com)\//;

function freeCall(key) { const p = busy.get(key); busy.delete(key); if (p && busy.get(p) === key) busy.delete(p); return p; }
function safeEqual(a, b) {
  const x = crypto.createHash('sha256').update(String(a)).digest(), y = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(x, y);
}
const publicList = () => [...users.values()].map(u => ({ username: u.username, avatar: u.avatar, status: u.status || '', online: !!u.socketId }));
function socketOf(name) { const u = users.get(String(name || '').toLowerCase()); return u && u.socketId ? io.sockets.sockets.get(u.socketId) : null; }
const prevText = m => m.type === 'text' ? m.text.slice(0, 80) : ({ photo: 'Photo', voice: 'Voice message', video: 'Video', html: 'File', file: 'File', gif: 'GIF', poll: 'Poll' })[m.type] || 'New message';

// ---------- push notifications ----------
function missedCall(k, r) { // leaves a 'Missed call' message and alerts the phone
  const u = users.get(k); if (!u) return;
  const m = { id: 'missed-' + Date.now() + Math.random().toString(36).slice(2, 6), from: r.name, to: u.username, text: 'Missed ' + r.type + ' call', type: 'text', fileName: '', time: '', color: '#ffffff' };
  const t = socketOf(k); if (t) t.emit('receive_message', m); else deliver(k, m);
}
async function pushTo(key, payload) {
  if (!vapidPublic) return false;
  const r = await sb('push_subs?username=eq.' + enc(key) + '&select=sub');
  if (!r || !r[0]) return false;
  try { await webpush.sendNotification(r[0].sub, JSON.stringify(payload)); return true; }
  catch (e) { if (e.statusCode === 404 || e.statusCode === 410) sb('push_subs?username=eq.' + enc(key), { method: 'DELETE' }); return false; }
}
// keep a message for someone who is offline, and alert their phone
async function deliver(key, clean) {
  if (!DB) return;
  if (JSON.stringify(clean).length < 1.5e6) await sb('pending', { method: 'POST', body: JSON.stringify({ to_user: key, payload: clean }) });
  pushTo(key, { title: clean.to === GROUP ? 'Family Group' : clean.from, body: (clean.to === GROUP ? clean.from + ': ' : '') + prevText(clean), tag: 'msg-' + clean.from });
}
async function flushPending(socket, key) {
  const call = pendingCalls.get(key);
  if (call && call.exp > Date.now()) socket.emit('incoming_call', call.data);
  pendingCalls.delete(key);
  const rows = await sb('pending?to_user=eq.' + enc(key) + '&order=id.asc&select=id,payload');
  if (!rows || !rows.length) return;
  rows.forEach(r => socket.emit('receive_message', r.payload));
  await sb('pending?id=in.(' + rows.map(r => r.id).join(',') + ')', { method: 'DELETE' });
}

// ---------- start-up: load saved contacts, notification keys ----------
(async () => {
  if (!DB) return console.log('No database configured: running in memory-only mode');
  const rows = await sb('app_users?select=*');
  (rows || []).forEach(r => users.set(r.k, { username: r.display, avatar: r.avatar, status: r.status || '', socketId: null }));
  await sb('pending?created_at=lt.' + enc(new Date(Date.now() - 7 * 864e5).toISOString()), { method: 'DELETE' });
  const s = await sb('app_settings?k=eq.vapid&select=v');
  let keys;
  if (s && s[0]) keys = JSON.parse(s[0].v);
  else { keys = webpush.generateVAPIDKeys(); await upsert('app_settings', 'k', { k: 'vapid', v: JSON.stringify(keys) }); }
  webpush.setVapidDetails('mailto:admin@example.com', keys.publicKey, keys.privateKey);
  vapidPublic = keys.publicKey;
  console.log('Database ready. Contacts loaded:', users.size);
})();
setInterval(() => { for (const [k, c] of pendingCalls) if (c.exp < Date.now()) { pendingCalls.delete(k); freeCall(k); const r = ringing.get(k); if (r) { ringing.delete(k); missedCall(k, r); } } }, 15000);

io.on('connection', (socket) => {
  let hits = 0;
  const limiter = setInterval(() => { hits = 0; }, 10000);
  const limited = () => ++hits > 60; // max 60 events per 10 seconds

  socket.on('register_user', (data) => {
    try {
      if (!data || !safeEqual(data.password, PASSWORD)) return socket.emit('auth_error');
      const username = String(data.username || '').trim().slice(0, 20);
      const avatar = String(data.avatar || ''), status = String(data.status || '').slice(0, 60);
      if (!/^[\w ]{1,20}$/.test(username)) return socket.emit('auth_error');
      if (!(avatar.startsWith('data:image/') || avatar.startsWith('https://')) || avatar.length > 300000) return socket.emit('auth_error');
      const key = username.toLowerCase();
      if (socket.data.key && socket.data.key !== key) { users.delete(socket.data.key); sb('app_users?k=eq.' + enc(socket.data.key), { method: 'DELETE' }); }
      socket.data.key = key; socket.data.username = username;
      users.set(key, { username, avatar, status, socketId: socket.id });
      socket.join('members'); // only logged-in users get lists and group messages
      io.to('members').emit('update_user_list', publicList());
      upsert('app_users', 'k', { k: key, display: username, avatar, status, last_seen: new Date().toISOString() });
      flushPending(socket, key); // missed messages and waiting calls
    } catch { socket.emit('auth_error'); }
  });

  socket.on('push_sub', (sub) => {
    if (!socket.data.key || !sub || typeof sub.endpoint !== 'string' || !PUSH_HOSTS.test(sub.endpoint)) return;
    upsert('push_subs', 'username', { username: socket.data.key, sub });
  });

  socket.on('send_message', (msg) => {
    if (!socket.data.username || limited() || !msg) return;
    if (!TYPES.includes(msg.type) || typeof msg.text !== 'string' || msg.text.length > 4e6) return;
    if (msg.type === 'gif' && !/^https:\/\/(media\d*|i)\.giphy\.com\//.test(msg.text)) return; // GIFs must come from GIPHY
    if (msg.type === 'poll') { try { const p = JSON.parse(msg.text); if (msg.text.length > 2000 || typeof p.q !== 'string' || !Array.isArray(p.o) || p.o.length < 2 || p.o.length > 4 || p.o.some(x => typeof x !== 'string')) return; } catch (e) { return; } }
    const group = msg.to === GROUP;
    const clean = {
      id: String(msg.id).slice(0, 80), from: socket.data.username, to: group ? GROUP : String(msg.to).slice(0, 20),
      text: msg.text, type: msg.type, fileName: String(msg.fileName || '').slice(0, 100),
      time: String(msg.time || '').slice(0, 20), color: /^#[0-9a-f]{6}$/i.test(msg.color) ? msg.color : '#ffffff',
      reply: msg.reply && typeof msg.reply.text === 'string' ? { name: String(msg.reply.name).slice(0, 20), text: msg.reply.text.slice(0, 60) } : undefined,
      ttl: [60, 3600, 86400].includes(msg.ttl) ? msg.ttl : undefined, // disappearing messages
    };
    msgOwners.set(clean.id, { from: socket.data.username, to: clean.to });
    if (msgOwners.size > 1000) msgOwners.delete(msgOwners.keys().next().value);
    if (group) {
      socket.to('members').emit('receive_message', clean);
      for (const [k, u] of users) if (!u.socketId && k !== socket.data.key) deliver(k, clean);
      return;
    }
    const key = String(msg.to).toLowerCase(), target = socketOf(key);
    if (target) { target.emit('receive_message', clean); socket.emit('delivered', { id: clean.id }); }
    else if (users.has(key)) deliver(key, clean);
  });

  socket.on('delete_message', ({ id } = {}) => {
    const owner = msgOwners.get(id);
    if (!owner || owner.from !== socket.data.username) return; // only your own messages
    if (owner.to === GROUP) socket.to('members').emit('message_deleted', { id });
    else { const target = socketOf(owner.to); if (target) target.emit('message_deleted', { id }); }
    msgOwners.delete(id);
  });

  socket.on('typing', ({ to } = {}) => {
    if (!socket.data.username || limited()) return;
    const p = { from: socket.data.username, to: to === GROUP ? GROUP : undefined };
    if (to === GROUP) return socket.to('members').emit('typing', p);
    const t = socketOf(to); if (t) t.emit('typing', p);
  });
  socket.on('read', ({ to, ids } = {}) => {
    const t = socketOf(to);
    if (t && socket.data.username && Array.isArray(ids)) t.emit('read_ack', { ids: ids.slice(0, 100).map(String), from: socket.data.username });
  });
  socket.on('react', ({ id, to, emoji } = {}) => {
    if (!socket.data.username || limited()) return;
    const p = { id: String(id).slice(0, 80), from: socket.data.username, emoji: String(emoji || '').slice(0, 8), to: to === GROUP ? GROUP : undefined };
    if (to === GROUP) return socket.to('members').emit('reacted', p);
    const t = socketOf(to); if (t) t.emit('reacted', p);
  });

  // ---- calls ----
  socket.on('call_user', ({ userToCall, signal, type } = {}) => {
    if (!socket.data.username || limited()) return;
    const b = String(userToCall || '').toLowerCase(), a = socket.data.key, target = socketOf(b);
    freeCall(a); // the caller is obviously not in an old call anymore
    if (a === b || busy.has(b)) return socket.emit('call_busy', { name: (users.get(b) || {}).username || userToCall }); // no one can join a call in progress
    const data = { signal, type: type === 'voice' ? 'voice' : 'video', from: socket.data.username, name: socket.data.username };
    if (target) { busy.set(a, b); busy.set(b, a); ringing.set(b, { from: socket.data.username, name: socket.data.username, type: data.type }); return target.emit('incoming_call', data); }
    if (!users.has(b) || !vapidPublic) return socket.emit('call_unavailable');
    // the other person is offline: wake their phone, and hold the call for 45 seconds
    busy.set(a, b); busy.set(b, a); pendingCalls.set(b, { data, exp: Date.now() + 45000 });
    ringing.set(b, { from: socket.data.username, name: socket.data.username, type: data.type });
    const ring = () => pushTo(b, { title: data.name + ' is calling...', body: (data.type === 'video' ? 'Video call' : 'Voice call') + '. Tap Answer.', tag: 'call', call: true });
    ring().then(ok => { if (!ok) { pendingCalls.delete(b); ringing.delete(b); freeCall(a); socket.emit('call_unavailable'); } });
    const t = setInterval(() => { const c = pendingCalls.get(b); if (!c || c.exp < Date.now()) return clearInterval(t); ring(); }, 7000); // keeps buzzing until answered
  });
  socket.on('answer_call', ({ signal, to } = {}) => {
    ringing.delete(socket.data.key);
    const target = socketOf(to);
    if (target && socket.data.username) target.emit('call_accepted', { signal });
  });
  socket.on('end_call', ({ to } = {}) => {
    freeCall(socket.data.key); ringing.delete(socket.data.key);
    const k = String(to || '').toLowerCase(); pendingCalls.delete(k);
    const r = ringing.get(k); if (r && r.from === socket.data.username) { ringing.delete(k); missedCall(k, r); } // caller gave up before it was answered
    const target = socketOf(k); if (target) target.emit('call_ended');
  });

  socket.on('disconnect', () => {
    clearInterval(limiter);
    // keep the user in the list so contacts stay visible; they are just offline
    const u = users.get(socket.data.key);
    if (u && u.socketId === socket.id) {
      for (const [k, r] of ringing) if (r.from === socket.data.username) { ringing.delete(k); pendingCalls.delete(k); missedCall(k, r); }
      const p = freeCall(socket.data.key); if (p) { const t = socketOf(p); if (t) t.emit('call_ended'); }
      u.socketId = null; io.to('members').emit('update_user_list', publicList());
    }
  });
});

server.listen(process.env.PORT || 3000, () => console.log('Server running'));
