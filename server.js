'use strict';

const express    = require('express');
const http       = require('http');
const { Server } = require('socket.io');
const crypto     = require('crypto');
const path       = require('path');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
  maxHttpBufferSize: 1e6   // 1 MB cap — signalling only, file bytes NEVER touch this server
});

app.use(express.static(path.join(__dirname, 'public')));

/* ── Room storage (in-memory only) ─────────────────────────────────────── */
// Rooms hold socket IDs and metadata — never file data
const rooms = new Map();

const AVATARS = [
  '🦊','🐼','🦁','🐯','🐸','🦄','🐙','🦋','🐳','🦅',
  '🐉','🦚','🦜','🐬','🐺','🦝','🐨','🐘','🦩','🦔',
  '🦭','🦁','🐮','🦊','🐧','🦆','🦉','🦇','🐝','🦋'
];

const pick  = arr => arr[Math.floor(Math.random() * arr.length)];
const genId = ()  => crypto.randomBytes(3).toString('hex').toUpperCase();

function publicUsers(room) {
  return Array.from(room.users.values()).map(u => ({
    id:       u.id,
    nickname: u.nickname,
    avatar:   u.avatar,
    isHost:   u.id === room.hostId
  }));
}

/* ── Socket.IO connection handler ──────────────────────────────────────── */
io.on('connection', socket => {
  let roomId = null;  // track which room this socket is in

  /* ── Create Room ──────────────────────────────────────────── */
  socket.on('create-room', ({ customId, password, nickname }) => {
    const id = (customId || '')
      .trim().toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12) || genId();

    if (rooms.has(id)) {
      socket.emit('room-error', 'Room ID already taken. Try another.');
      return;
    }

    const user = {
      id:       socket.id,
      nickname: (nickname || 'Anonymous').slice(0, 30),
      avatar:   pick(AVATARS)
    };

    rooms.set(id, {
      id,
      password:  password || null,
      hostId:    socket.id,
      users:     new Map([[socket.id, user]]),
      locked:    false,
      createdAt: Date.now()
    });

    roomId = id;
    socket.join(id);

    const users = publicUsers(rooms.get(id));
    socket.emit('room-created', { roomId: id, user: users[0], users });
  });

  /* ── Join Room ────────────────────────────────────────────── */
  socket.on('join-room', ({ roomId: rid, password, nickname }) => {
    const id   = (rid || '').trim().toUpperCase();
    const room = rooms.get(id);

    if (!room)                                        { socket.emit('room-error', 'Room not found.'); return; }
    if (room.locked)                                  { socket.emit('room-error', 'Room is locked.'); return; }
    if (room.password && room.password !== password)  { socket.emit('room-error', 'Wrong password.'); return; }
    if (room.users.has(socket.id))                    { socket.emit('room-error', 'Already in this room.'); return; }

    const user = {
      id:       socket.id,
      nickname: (nickname || 'Anonymous').slice(0, 30),
      avatar:   pick(AVATARS)
    };

    room.users.set(socket.id, user);
    roomId = id;
    socket.join(id);

    const users = publicUsers(room);
    socket.emit('room-joined',  { roomId: id, user: users.find(u => u.id === socket.id), users });
    socket.to(id).emit('user-joined', { user: users.find(u => u.id === socket.id), users });
  });

  /* ── WebRTC Signalling — relay only, never inspect content ─ */
  socket.on('webrtc-offer',  d => socket.to(d.to).emit('webrtc-offer',  { from: socket.id, sdp:       d.sdp       }));
  socket.on('webrtc-answer', d => socket.to(d.to).emit('webrtc-answer', { from: socket.id, sdp:       d.sdp       }));
  socket.on('webrtc-ice',    d => socket.to(d.to).emit('webrtc-ice',    { from: socket.id, candidate: d.candidate }));

  /* ── Chat ─────────────────────────────────────────────────── */
  socket.on('chat', ({ message }) => {
    const room = rooms.get(roomId);
    if (!room || !room.users.has(socket.id)) return;
    const u = room.users.get(socket.id);
    io.to(roomId).emit('chat', {
      id:       crypto.randomBytes(4).toString('hex'),
      from:     socket.id,
      avatar:   u.avatar,
      nickname: u.nickname,
      message:  String(message).slice(0, 2000),
      ts:       Date.now()
    });
  });

  /* ── Lock / Unlock Room (host only) ───────────────────────── */
  socket.on('lock-room', () => {
    const room = rooms.get(roomId);
    if (!room || room.hostId !== socket.id) return;
    room.locked = !room.locked;
    io.to(roomId).emit('room-locked', { locked: room.locked });
  });

  /* ── Kick User (host only) ────────────────────────────────── */
  socket.on('kick-user', ({ userId }) => {
    const room = rooms.get(roomId);
    if (!room || room.hostId !== socket.id || userId === socket.id) return;
    const target = io.sockets.sockets.get(userId);
    if (target) { target.emit('kicked'); target.leave(roomId); }
    room.users.delete(userId);
    io.to(roomId).emit('user-left', { userId, users: publicUsers(room) });
  });

  /* ── Leave / Disconnect ───────────────────────────────────── */
  function leave() {
    if (!roomId) return;
    const room = rooms.get(roomId);
    if (!room) { roomId = null; return; }

    room.users.delete(socket.id);

    if (room.users.size === 0) {
      rooms.delete(roomId);
    } else {
      // Transfer host to next available user
      if (room.hostId === socket.id) {
        room.hostId = room.users.keys().next().value;
        io.to(room.hostId).emit('host-granted');
      }
      io.to(roomId).emit('user-left', { userId: socket.id, users: publicUsers(room) });
    }
    roomId = null;
  }

  socket.on('leave-room', leave);
  socket.on('disconnect',  leave);
});

/* ── Cleanup abandoned empty rooms every 60s ───────────────────────────── */
setInterval(() => {
  const cutoff = Date.now() - 300_000; // 5 minutes
  for (const [id, room] of rooms) {
    if (room.users.size === 0 && room.createdAt < cutoff) rooms.delete(id);
  }
}, 60_000);

/* ── Start ─────────────────────────────────────────────────────────────── */
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 ShareDrop → http://localhost:${PORT}`));
