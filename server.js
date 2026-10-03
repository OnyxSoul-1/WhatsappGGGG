// whatsappDIaa server
// Set these in Render -> Environment:
//   FAMILY_PASSWORD = your secret password
//   ALLOWED_ORIGIN  = the address of your site, e.g. https://onyxsoul-1.github.io
const express = require('express');
const http = require('http');
const crypto = require('crypto');
const cors = require('cors');
const { Server } = require('socket.io');

const PASSWORD = process.env.FAMILY_PASSWORD;
const ORIGIN = process.env.ALLOWED_ORIGIN || '*'; // change '*' once your site address is known
if (!PASSWORD) { console.error('Missing FAMILY_PASSWORD env variable'); process.exit(1); }

const app = express();
app.use(cors({ origin: ORIGIN }));
app.get('/', (req, res) => res.send('whatsappDIaa server is awake')); // ping this with UptimeRobot

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: ORIGIN },
  maxHttpBufferSize: 5e6, // 5 MB max per message (photos/voice/video)
  pingInterval: 10000, pingTimeout: 8000, // notice a lost connection within ~18 seconds
});

const users = new Map();     // lowercase name -> { username, avatar, socketId }
const GROUP = '__group';
const busy = new Map(); // lowercase name -> lowercase name of the person they are on a call with
function freeCall(key) { const p = busy.get(key); busy.delete(key); if (p && busy.get(p) === key) busy.delete(p); return p; }
const msgOwners = new Map(); // message id -> { from, to } (for deletes)
const TYPES = ['text', 'photo', 'voice', 'video', 'html', 'file', 'gif', 'poll'];

function safeEqual(a, b) {
  const x = crypto.createHash('sha256').update(String(a)).digest();
  const y = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(x, y);
}
function publicList() {
  return [...users.values()].map(u => ({ username: u.username, avatar: u.avatar, status: u.status || '', online: !!u.socketId }));
}
function socketOf(name) {
  const u = users.get(String(name || '').toLowerCase());
  return u ? io.sockets.sockets.get(u.socketId) : null;
}

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
      if (!(avatar.startsWith('data:image/') || avatar.startsWith('https://')) || avatar.length > 300000)
        return socket.emit('auth_error');

      const key = username.toLowerCase();
      if (socket.data.key && socket.data.key !== key) users.delete(socket.data.key); // renamed profile
      socket.data.key = key;
      socket.data.username = username;
      users.set(key, { username, avatar, status, socketId: socket.id });
      socket.join('members'); // only logged-in users get lists and group messages
      io.to('members').emit('update_user_list', publicList());
    } catch { socket.emit('auth_error'); }
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
    if (group) return socket.to('members').emit('receive_message', clean);
    const target = socketOf(msg.to);
    if (target) { target.emit('receive_message', clean); socket.emit('delivered', { id: clean.id }); }
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
    const target = socketOf(userToCall);
    if (!target) return socket.emit('call_unavailable');
    const a = socket.data.key, b = target.data.key;
    freeCall(a); // the caller is obviously not in an old call anymore
    if (a === b || busy.has(b)) return socket.emit('call_busy', { name: target.data.username }); // no one can join a call in progress
    busy.set(a, b); busy.set(b, a);
    target.emit('incoming_call', {
      signal, type: type === 'voice' ? 'voice' : 'video',
      from: socket.data.username, name: socket.data.username,
    });
  });
  socket.on('answer_call', ({ signal, to } = {}) => {
    const target = socketOf(to);
    if (target && socket.data.username) target.emit('call_accepted', { signal });
  });
  socket.on('end_call', ({ to } = {}) => {
    freeCall(socket.data.key);
    const target = socketOf(to);
    if (target) target.emit('call_ended');
  });

  socket.on('disconnect', () => {
    clearInterval(limiter);
    // keep the user in the list so contacts stay visible; they are just offline
    const u = users.get(socket.data.key);
    if (u && u.socketId === socket.id) { const p = freeCall(socket.data.key); if (p) { const t = socketOf(p); if (t) t.emit('call_ended'); } u.socketId = null; io.to('members').emit('update_user_list', publicList()); }
  });
});

server.listen(process.env.PORT || 3000, () => console.log('Server running'));
