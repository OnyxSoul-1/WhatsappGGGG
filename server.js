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
});

const users = new Map();     // lowercase name -> { username, avatar, socketId }
const msgOwners = new Map(); // message id -> { from, to } (for deletes)
const TYPES = ['text', 'photo', 'voice', 'video', 'html', 'file'];

function safeEqual(a, b) {
  const x = crypto.createHash('sha256').update(String(a)).digest();
  const y = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(x, y);
}
function publicList() {
  return [...users.values()].map(u => ({ username: u.username, avatar: u.avatar }));
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
      const avatar = String(data.avatar || '');
      if (!/^[\w ]{1,20}$/.test(username)) return socket.emit('auth_error');
      if (!(avatar.startsWith('data:image/') || avatar.startsWith('https://')) || avatar.length > 300000)
        return socket.emit('auth_error');

      const key = username.toLowerCase();
      if (socket.data.key && socket.data.key !== key) users.delete(socket.data.key); // renamed profile
      socket.data.key = key;
      socket.data.username = username;
      users.set(key, { username, avatar, socketId: socket.id });
      io.emit('update_user_list', publicList());
    } catch { socket.emit('auth_error'); }
  });

  socket.on('send_message', (msg) => {
    if (!socket.data.username || limited() || !msg) return;
    if (!TYPES.includes(msg.type) || typeof msg.text !== 'string' || msg.text.length > 4e6) return;
    const target = socketOf(msg.to);
    const clean = {
      id: String(msg.id).slice(0, 80), from: socket.data.username, to: String(msg.to).slice(0, 20),
      text: msg.text, type: msg.type, fileName: String(msg.fileName || '').slice(0, 100),
      time: String(msg.time || '').slice(0, 20), color: /^#[0-9a-f]{6}$/i.test(msg.color) ? msg.color : '#ffffff',
    };
    msgOwners.set(clean.id, { from: socket.data.username, to: clean.to });
    if (msgOwners.size > 1000) msgOwners.delete(msgOwners.keys().next().value);
    if (target) target.emit('receive_message', clean);
  });

  socket.on('delete_message', ({ id } = {}) => {
    const owner = msgOwners.get(id);
    if (!owner || owner.from !== socket.data.username) return; // only your own messages
    const target = socketOf(owner.to);
    if (target) target.emit('message_deleted', { id });
    msgOwners.delete(id);
  });

  // ---- calls ----
  socket.on('call_user', ({ userToCall, signal, type } = {}) => {
    if (!socket.data.username || limited()) return;
    const target = socketOf(userToCall);
    if (!target) return socket.emit('call_unavailable');
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
    const target = socketOf(to);
    if (target) target.emit('call_ended');
  });

  socket.on('disconnect', () => {
    clearInterval(limiter);
    // keep the user in the list so contacts stay visible; they are just offline
    const u = users.get(socket.data.key);
    if (u && u.socketId === socket.id) u.socketId = null;
  });
});

server.listen(process.env.PORT || 3000, () => console.log('Server running'));
