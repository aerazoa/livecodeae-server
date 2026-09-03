const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
app.use(cors());

const PORT = process.env.PORT || 4815;

// ─── Health check ────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    service: 'LivecodeAE Relay Server',
    version: '1.0.0',
    activeRooms: rooms.size,
    uptime: Math.floor(process.uptime()) + 's'
  });
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', activeRooms: rooms.size });
});

// ─── State ───────────────────────────────────────────────────────────────────
const rooms = new Map();       // roomId → { id, users, files, hostId }
const colorIndex = new Map();  // roomId → nextColorIndex

const PALETTE = [
  '#22c55e', // Verde (Sam)
  '#f43f5e', // Rosa / Coral (Lisa)
  '#3b82f6', // Azul Eléctrico (David)
  '#f59e0b', // Ámbar / Dorado (Maria)
  '#a855f7', // Púrpura Neón (Kevin)
  '#06b6d4', // Celeste Cian
  '#ec4899', // Fucsia
  '#f97316'  // Naranja
];

// ─── HTTP + Socket.IO server ─────────────────────────────────────────────────
const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  },
  transports: ['websocket', 'polling'],
  pingTimeout: 30000,
  pingInterval: 10000
});

// ─── Socket events ───────────────────────────────────────────────────────────
io.on('connection', (socket) => {
  let userRoomId = null;
  const userId = socket.id;

  console.log(`[LivecodeAE] Nueva conexión: ${userId}`);

  // 1. Unirse a sala
  socket.on('join-room', (data) => {
    const roomId = (data.roomId || '').toUpperCase().trim();
    if (!roomId) return;

    userRoomId = roomId;
    socket.join(roomId);

    const hasFiles = data.initialFiles && Object.keys(data.initialFiles).length > 0;

    if (!rooms.has(roomId)) {
      rooms.set(roomId, {
        id: roomId,
        users: {},
        files: hasFiles ? data.initialFiles : {},
        hostId: userId
      });
      colorIndex.set(roomId, 0);
    }

    const room = rooms.get(roomId);

    if (hasFiles) {
      room.files = data.initialFiles;
      console.log(`[LivecodeAE] Sala ${roomId}: archivos recibidos: ${Object.keys(data.initialFiles).join(', ')}`);
    }

    const idx = colorIndex.get(roomId) || 0;
    const color = PALETTE[idx % PALETTE.length];
    colorIndex.set(roomId, idx + 1);

    const presence = {
      id: userId,
      name: data.name || `Dev-${userId.substring(0, 4)}`,
      avatar: data.avatar || `https://api.dicebear.com/7.x/bottts/svg?seed=${encodeURIComponent(data.name || userId)}`,
      color,
      currentFile: Object.keys(room.files)[0] || 'index.html',
      line: 1,
      col: 1,
      selections: []
    };

    room.users[userId] = presence;

    // Enviar estado completo al usuario recién conectado
    socket.emit('room-joined', {
      roomId,
      user: presence,
      roomState: {
        id: room.id,
        users: room.users,
        files: room.files
      }
    });

    socket.to(roomId).emit('user-joined', presence);
    io.to(roomId).emit('room-presence-updated', Object.values(room.users));

    console.log(`[LivecodeAE] ${presence.name} se unió a la sala ${roomId} (${Object.keys(room.users).length} usuarios)`);
  });

  // 2. Actualización de perfil en tiempo real
  socket.on('update-profile', (data) => {
    const roomId = (data.roomId || userRoomId || '').toUpperCase().trim();
    if (roomId && rooms.has(roomId)) {
      const room = rooms.get(roomId);
      const user = room.users[userId];
      if (user) {
        if (data.name) user.name = data.name;
        if (data.avatar) user.avatar = data.avatar;
        io.to(roomId).emit('room-presence-updated', Object.values(room.users));
      }
    }
  });

  // 3. Salir de sala
  socket.on('leave-room', (data) => {
    const roomId = ((data && data.roomId) || userRoomId || '').toUpperCase().trim();
    if (roomId && rooms.has(roomId)) {
      const room = rooms.get(roomId);
      const isHost = room.hostId === userId;

      delete room.users[userId];
      socket.leave(roomId);

      if (isHost || Object.keys(room.users).length === 0) {
        io.to(roomId).emit('session-ended', { reason: 'La sesión fue cerrada por el anfitrión.' });
        rooms.delete(roomId);
        colorIndex.delete(roomId);
        console.log(`[LivecodeAE] Sala ${roomId} eliminada.`);
      } else {
        socket.to(roomId).emit('user-left', userId);
        io.to(roomId).emit('room-presence-updated', Object.values(room.users));
      }
    }
  });

  // 4. Cambios de documento
  socket.on('doc-change', (data) => {
    const { roomId, fileName, content, changes } = data;
    const room = rooms.get(roomId);
    if (room) {
      room.files[fileName] = content;
      const user = room.users[userId];
      socket.to(roomId).emit('doc-changed', {
        userId,
        fileName,
        content,
        changes,
        color: user ? user.color : '#38bdf8',
        name: user ? user.name : 'Dev',
        avatar: user ? user.avatar : ''
      });
    }
  });

  // 5. Cambios de selección y cursor
  socket.on('selection-change', (data) => {
    const { roomId, fileName, line, col, selections } = data;
    const room = rooms.get(roomId);
    if (room && room.users[userId]) {
      const user = room.users[userId];
      user.currentFile = fileName;
      user.line = line;
      user.col = col;
      user.selections = selections;

      socket.to(roomId).emit('selection-changed', {
        userId, fileName, line, col, selections,
        color: user.color,
        name: user.name,
        avatar: user.avatar
      });

      io.to(roomId).emit('room-presence-updated', Object.values(room.users));
    }
  });

  // 6. Desconexión
  socket.on('disconnect', () => {
    console.log(`[LivecodeAE] Desconectado: ${userId}`);
    if (userRoomId && rooms.has(userRoomId)) {
      const room = rooms.get(userRoomId);
      const isHost = room.hostId === userId;

      delete room.users[userId];

      if (isHost || Object.keys(room.users).length === 0) {
        io.to(userRoomId).emit('session-ended', { reason: 'El anfitrión se ha desconectado.' });
        rooms.delete(userRoomId);
        colorIndex.delete(userRoomId);
      } else {
        socket.to(userRoomId).emit('user-left', userId);
        io.to(userRoomId).emit('room-presence-updated', Object.values(room.users));
      }
    }
  });
});

// ─── Iniciar servidor ────────────────────────────────────────────────────────
server.listen(PORT, () => {
  console.log(`[LivecodeAE Relay Server] ✅ Escuchando en puerto ${PORT}`);
  console.log(`[LivecodeAE Relay Server] Health check: http://localhost:${PORT}/health`);
});
