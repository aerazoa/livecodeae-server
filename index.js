const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 4815;

app.get('/favicon.ico', (req, res) => res.status(204).end());

// ─── Rutas Web y Health check ─────────────────────────────────────────────────
app.get('/voice', (req, res) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.sendFile(path.join(__dirname, 'public', 'voice.html'));
});

app.get('/call', (req, res) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.sendFile(path.join(__dirname, 'public', 'call.html'));
});

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
const callRooms = new Map();   // roomId → Map(userId → callerName)

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

    const isHostAttempt = data.isHost === true;
    const roomExists = rooms.has(roomId);
    const hasFiles = data.initialFiles && Object.keys(data.initialFiles).length > 0;

    if (!roomExists) {
      if (!isHostAttempt) {
        console.warn(`[LivecodeAE] Intento denegado de crear sala ${roomId} por invitado: ${userId}`);
        socket.emit('session-join-error', {
          reason: 'Esta sala no existe aún. Solamente el anfitrión autorizado puede crear nuevas sesiones colaborativas.'
        });
        return;
      }

      rooms.set(roomId, {
        id: roomId,
        users: {},
        files: hasFiles ? data.initialFiles : {},
        hostId: userId,
        readonlyForAllGuests: false,
        userPermissions: {}, // userId -> boolean (true = readonly, false = editor)
        annotations: [],
        focusMode: false
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

    // Deduplicar: Si este usuario ya estaba registrado en la sala con otro socket (reconexión o sub-panel)
    const normName = (data.name || '').trim().toLowerCase();
    const existingEntry = Object.entries(room.users).find(
      ([uId, u]) => u.name && u.name.trim().toLowerCase() === normName
    );

    let userColor = color;
    if (existingEntry) {
      const [oldId, oldUser] = existingEntry;
      userColor = oldUser.color;
      if (oldId !== userId) {
        delete room.users[oldId];
      }
    }

    const presence = {
      id: userId,
      name: data.name || `Dev-${userId.substring(0, 4)}`,
      avatar: data.avatar || `https://api.dicebear.com/7.x/bottts/svg?seed=${encodeURIComponent(data.name || userId)}`,
      color: userColor,
      currentFile: Object.keys(room.files)[0] || 'index.html',
      line: 1,
      col: 1,
      selections: [],
      isHost: room.hostId === userId || (existingEntry && existingEntry[1].isHost),
      isReadOnly: room.hostId !== userId && (room.readonlyForAllGuests || room.userPermissions[userId] === true)
    };

    room.users[userId] = presence;

    // Enviar estado completo al usuario recién conectado
    socket.emit('room-joined', {
      roomId,
      user: presence,
      roomState: {
        id: room.id,
        users: room.users,
        files: room.files,
        hostId: room.hostId,
        readonlyForAllGuests: room.readonlyForAllGuests || false,
        userPermissions: room.userPermissions || {},
        annotations: room.annotations || [],
        focusMode: room.focusMode || false
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

      if (room.voiceUsers) room.voiceUsers.delete(userId);
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
        if (room.voiceUsers) {
          io.to(roomId).emit('voice-presence-updated', Array.from(room.voiceUsers).map(id => ({
            id,
            name: room.users[id]?.name || 'Dev',
            avatar: room.users[id]?.avatar || '',
            color: room.users[id]?.color || '#38bdf8'
          })));
        }
      }
    }
  });

  // 4. Cambios de documento (Con control de permisos Solo Lectura)
  socket.on('doc-change', (data) => {
    const { roomId, fileName, content, changes } = data;
    const room = rooms.get(roomId);
    if (room) {
      const isHost = room.hostId === userId;
      const isReadOnly = !isHost && (room.readonlyForAllGuests || room.userPermissions[userId] === true);

      if (isReadOnly) {
        socket.emit('permission-denied', { reason: 'Modo Solo Lectura activo: No tienes permisos para editar.' });
        return;
      }

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

  // 6. Chat de texto en vivo
  socket.on('chat-message', (data) => {
    const { roomId, text } = data;
    const room = rooms.get(roomId);
    if (room && room.users[userId]) {
      const user = room.users[userId];
      const msg = {
        id: 'msg_' + Date.now() + '_' + Math.random().toString(36).substring(2, 6),
        userId,
        userName: user.name,
        userAvatar: user.avatar,
        userColor: user.color,
        text,
        timestamp: Date.now()
      };
      io.to(roomId).emit('chat-message-received', msg);
    }
  });

  // 7. Configuración de Permisos del Anfitrión (Feature 1)
  socket.on('set-room-permissions', (data) => {
    const { roomId, readonlyForAllGuests, userPermissions, voiceEnabled, whiteboardEnabled } = data;
    const room = rooms.get(roomId);
    if (room && room.hostId === userId) {
      if (typeof readonlyForAllGuests === 'boolean') room.readonlyForAllGuests = readonlyForAllGuests;
      if (userPermissions) room.userPermissions = { ...room.userPermissions, ...userPermissions };
      if (typeof voiceEnabled === 'boolean') room.voiceEnabled = voiceEnabled;
      if (typeof whiteboardEnabled === 'boolean') room.whiteboardEnabled = whiteboardEnabled;

      // Actualizar estado de usuarios
      Object.keys(room.users).forEach(uId => {
        const u = room.users[uId];
        u.isReadOnly = (uId !== room.hostId) && (room.readonlyForAllGuests || room.userPermissions[uId] === true);
      });

      io.to(roomId).emit('permissions-updated', {
        readonlyForAllGuests: room.readonlyForAllGuests,
        userPermissions: room.userPermissions,
        voiceEnabled: room.voiceEnabled,
        whiteboardEnabled: room.whiteboardEnabled
      });
      io.to(roomId).emit('room-presence-updated', Object.values(room.users));
      console.log(`[LivecodeAE] Permisos actualizados en ${roomId}: readonly=${room.readonlyForAllGuests}`);
    }
  });

  // 8. Comentarios y Notas en Línea de Código (Feature 4)
  socket.on('add-annotation', (data) => {
    const { roomId, annotation } = data;
    const room = rooms.get(roomId);
    if (room && annotation) {
      if (!room.annotations) room.annotations = [];
      room.annotations.push(annotation);
      io.to(roomId).emit('annotations-updated', room.annotations);
      console.log(`[LivecodeAE] Comentario agregado en ${roomId} por ${annotation.authorName} en ${annotation.fileName}:L${annotation.line}`);
    }
  });

  socket.on('resolve-annotation', (data) => {
    const { roomId, id } = data;
    const room = rooms.get(roomId);
    if (room && room.annotations) {
      const ann = room.annotations.find(a => a.id === id);
      if (ann) {
        ann.resolved = !ann.resolved;
        io.to(roomId).emit('annotations-updated', room.annotations);
      }
    }
  });

  socket.on('delete-annotation', (data) => {
    const { roomId, id } = data;
    const room = rooms.get(roomId);
    if (room && room.annotations) {
      room.annotations = room.annotations.filter(a => a.id !== id);
      io.to(roomId).emit('annotations-updated', room.annotations);
    }
  });

  // Focus Mode (Presentador guía a todos) (Feature 1)
  socket.on('set-focus-mode', (data) => {
    const { roomId, enabled } = data;
    const room = rooms.get(roomId);
    if (room && room.hostId === userId) {
      room.focusMode = !!enabled;
      io.to(roomId).emit('focus-mode-updated', { enabled: room.focusMode, hostId: userId });
      console.log(`[LivecodeAE] Focus mode en ${roomId}: ${room.focusMode}`);
    }
  });

  // 9. Desconexión
  socket.on('disconnect', () => {
    console.log(`[LivecodeAE] Desconectado: ${userId}`);

    // Limpieza de sala de código en VS Code
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
