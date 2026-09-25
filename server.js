const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const cors = require('cors');

const app = express();
app.use(cors());
const server = http.createServer(app);

const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] }
});

let users = {}; // Stores connected users and their socket IDs

io.on('connection', (socket) => {
  console.log('User connected:', socket.id);

  // 1. User logs in
  socket.on('register_user', (data) => {
    users[socket.id] = data; // data = { username, avatar, password }
    io.emit('update_user_list', Object.values(users));
  });

  // 2. Real Text & Voice Messages
  socket.on('send_message', (data) => {
    io.emit('receive_message', data);
  });

  // 3. Real Video/Voice Call Signaling (WebRTC)
  socket.on('call_user', (data) => {
    const { userToCall, signalData, from, name } = data;
    // Find the socket ID of the user being called
    const targetSocketId = Object.keys(users).find(key => users[key].username === userToCall);
    if (targetSocketId) {
      io.to(targetSocketId).emit('call_incoming', { signal: signalData, from, name });
    }
  });

  socket.on('answer_call', (data) => {
    const { signal, to } = data;
    const targetSocketId = Object.keys(users).find(key => users[key].username === to);
    if (targetSocketId) {
      io.to(targetSocketId).emit('call_accepted', signal);
    }
  });

  socket.on('disconnect', () => {
    delete users[socket.id];
    io.emit('update_user_list', Object.values(users));
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Real Server running on port ${PORT}`));
