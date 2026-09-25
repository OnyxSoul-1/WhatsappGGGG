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

let users = {}; // Maps socket ID to user data

io.on('connection', (socket) => {
  console.log('User connected:', socket.id);

  // 1. User logs in
  socket.on('register_user', (data) => {
    users[socket.id] = data; 
    io.emit('update_user_list', Object.values(users));
  });

  // 2. Text & Voice Messages
  socket.on('send_message', (data) => {
    io.emit('receive_message', data);
  });

  // 3. Start a Call
  socket.on('call_user', (data) => {
    // Find the socket ID of the person being called
    const targetId = Object.keys(users).find(id => users[id].username === data.userToCall);
    if (targetId) {
      io.to(targetId).emit('incoming_call', { 
        signal: data.signal, 
        from: data.from, 
        name: data.name 
      });
    }
  });

  // 4. Answer a Call
  socket.on('answer_call', (data) => {
    const targetId = Object.keys(users).find(id => users[id].username === data.to);
    if (targetId) {
      io.to(targetId).emit('call_accepted', { signal: data.signal, from: socket.id });
    }
  });

  socket.on('disconnect', () => {
    delete users[socket.id];
    io.emit('update_user_list', Object.values(users));
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
