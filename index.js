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
        callStarted: false
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

  // 7. Señalización WebRTC para Video y Audio P2P en el editor
  socket.on('webrtc-signal', (data) => {
    const { roomId, targetUserId, signal } = data;
    if (targetUserId) {
      io.to(targetUserId).emit('webrtc-signal-received', {
        senderUserId: userId,
        signal
      });
    } else if (roomId) {
      socket.to(roomId).emit('webrtc-signal-received', {
        senderUserId: userId,
        signal
      });
    }
  });

  // 8. Sala de Videollamada y Voz WebRTC P2P (Canal Independiente - No duplica usuarios de código)
  let callRoomId = null;

  socket.on('join-call', (data) => {
    const roomId = (data.roomId || '').toUpperCase().trim();
    const callerName = data.name || 'Programador LivecodeAE';
    const isHost = data.isHost === '1' || data.isHost === true;
    const allowGuestCall = data.allowGuestCall === '1' || data.allowGuestCall === true;
    if (!roomId) return;

    callRoomId = roomId;
    const callChannel = 'call_' + roomId;
    socket.join(callChannel);

    if (!callRooms.has(roomId)) {
      callRooms.set(roomId, {
        hostId: isHost ? userId : null,
        hostName: isHost ? callerName : '',
        started: isHost || allowGuestCall,
        callers: new Map()
      });
    }
    const cRoom = callRooms.get(roomId);

    if (isHost) {
      cRoom.hostId = userId;
      cRoom.hostName = callerName;
      if (!cRoom.started) {
        cRoom.started = true;
        console.log(`[LivecodeAE Call] El Anfitrión ${callerName} ha INICIADO la videollamada en la sala ${roomId}`);
        socket.to(callChannel).emit('call-started', { hostName: callerName });
      }
    }

    // Registrar participante
    cRoom.callers.set(userId, callerName);

    // Obtener los otros participantes que ya están en la llamada
    const existingCallers = [];
    cRoom.callers.forEach((name, id) => {
      if (id !== userId) existingCallers.push({ id, name });
    });

    const isCallActive = cRoom.started || allowGuestCall;
    console.log(`[LivecodeAE Call] ${callerName} (${isHost ? 'Anfitrión' : 'Invitado'}) se unió a la llamada en ${roomId}. Activa: ${isCallActive}`);

    // Responder al participante que se unió
    socket.emit('call-joined', {
      myId: userId,
      isHost,
      isCallActive,
      hostName: cRoom.hostName || 'el anfitrión',
      participants: existingCallers
    });

    if (isCallActive) {
      socket.to(callChannel).emit('caller-joined', {
        id: userId,
        name: callerName
      });
    }
  });

  socket.on('call-signal', (data) => {
    const { roomId, targetUserId, signal } = data;
    const callChannel = 'call_' + roomId;
    if (targetUserId) {
      io.to(targetUserId).emit('call-signal-received', {
        senderUserId: userId,
        signal
      });
    } else if (roomId) {
      socket.to(callChannel).emit('call-signal-received', {
        senderUserId: userId,
        signal
      });
    }
  });

  // Relay Multimedia Directo por WebSocket (Inmune a Firewalls y NAT Simétrico)
  socket.on('call-video-frame', (data) => {
    const { roomId, frame, isScreen } = data;
    if (roomId) {
      const senderName = callRooms.get(roomId)?.get(userId) || data.senderName || 'Programador';
      socket.to('call_' + roomId).emit('call-video-frame', {
        senderUserId: userId,
        senderName,
        frame,
        isScreen
      });
    }
  });

  socket.on('call-audio-pcm', (data) => {
    const { roomId, pcm } = data;
    if (roomId) {
      socket.to('call_' + roomId).emit('call-audio-pcm', {
        senderUserId: userId,
        pcm
      });
    }
  });

  // 9. Desconexión
  socket.on('disconnect', () => {
    console.log(`[LivecodeAE] Desconectado: ${userId}`);

    // Limpieza de llamada si estaba en videollamada
    if (callRoomId && callRooms.has(callRoomId)) {
      const cRoom = callRooms.get(callRoomId);
      if (cRoom && cRoom.callers) {
        cRoom.callers.delete(userId);
        socket.to('call_' + callRoomId).emit('caller-left', { id: userId });
        if (cRoom.callers.size === 0) {
          callRooms.delete(callRoomId);
        }
      }
      console.log(`[LivecodeAE Call] Usuario ${userId} salió de la llamada ${callRoomId}`);
    }

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
