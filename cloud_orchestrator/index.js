const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
app.use(cors());

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

const edgeDevices = new Map();

io.use((socket, next) => {
  const token = socket.handshake.auth.token || socket.handshake.query.token;
  // In a real system, validate the registration key against a database
  if (token && token.startsWith('edge-')) {
    socket.data.deviceId = token;
    next();
  } else {
    next(new Error("Authentication error: Invalid registration key"));
  }
});

io.on('connection', (socket) => {
  const deviceId = socket.data.deviceId;
  console.log(`[+] Edge device connected: ${deviceId} (${socket.id})`);
  
  edgeDevices.set(deviceId, {
    socketId: socket.id,
    status: 'online',
    lastSeen: new Date()
  });

  // Broadcast to any clients that a new device is online
  io.emit('device_status_changed', { deviceId, status: 'online' });

  socket.on('disconnect', () => {
    console.log(`[-] Edge device disconnected: ${deviceId}`);
    edgeDevices.delete(deviceId);
    io.emit('device_status_changed', { deviceId, status: 'offline' });
  });

  // Receive telemetry/status updates from the edge
  socket.on('workflow_status', (data) => {
    console.log(`[Status] ${deviceId} running workflow: ${data.status}`);
    // You can persist this to a database, or broadcast to web clients
  });
});

app.get('/api/devices', (req, res) => {
  const devices = Array.from(edgeDevices.entries()).map(([id, data]) => ({
    id,
    status: data.status,
    lastSeen: data.lastSeen
  }));
  res.json(devices);
});

const PORT = process.env.PORT || 4000;
server.listen(PORT, () => {
  console.log(`Cloud Orchestrator listening on port ${PORT}`);
});
