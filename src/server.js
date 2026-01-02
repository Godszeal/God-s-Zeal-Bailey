require('dotenv').config();
const express = require('express');
const cors = require('cors');
const http = require('http');
const WebSocket = require('ws');
const { 
  default: makeWASocket, 
  DisconnectReason, 
  useMultiFileAuthState,
  fetchLatestBaileysVersion 
} = require('@whiskeysockets/baileys');
const pino = require('pino');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;
const sessions = new Map();
const wsClients = new Map();

// Logger
const logger = pino({ level: 'silent' });

// Broadcast to all WebSocket clients for a session
const broadcast = (sessionId, data) => {
  const clients = wsClients.get(sessionId) || [];
  clients.forEach(ws => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(data));
    }
  });
};

// Create WhatsApp session
const createSession = async (sessionId, phoneNumber) => {
  const { version } = await fetchLatestBaileysVersion();
  const { state, saveCreds } = await useMultiFileAuthState(`sessions/${sessionId}`);

  const sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false,
    logger,
    browser: ['BotForge', 'Chrome', '120.0.0'],
    connectTimeoutMs: 60000,
  });

  sessions.set(sessionId, { sock, phoneNumber, status: 'connecting' });

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      broadcast(sessionId, { type: 'qr', data: qr });
    }

    if (connection === 'open') {
      sessions.set(sessionId, { ...sessions.get(sessionId), status: 'connected' });
      broadcast(sessionId, { type: 'connection', status: 'connected' });
      console.log(`[Session ${sessionId}] Connected!`);
    }

    if (connection === 'close') {
      const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
      console.log(`[Session ${sessionId}] Connection closed. Reconnecting: ${shouldReconnect}`);
      
      if (shouldReconnect) {
        setTimeout(() => createSession(sessionId, phoneNumber), 5000);
      } else {
        sessions.delete(sessionId);
        broadcast(sessionId, { type: 'connection', status: 'logged_out' });
      }
    }
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;

    for (const msg of messages) {
      if (msg.key.fromMe) continue;

      const text = msg.message?.conversation || 
                   msg.message?.extendedTextMessage?.text || '';
      
      if (!text) continue;

      const from = msg.key.remoteJid;
      console.log(`[Session ${sessionId}] Message from ${from}: ${text}`);

      broadcast(sessionId, { 
        type: 'message', 
        data: { from, text, timestamp: Date.now() } 
      });

      // Auto-reply for commands (you can customize this)
      if (text.startsWith('/')) {
        const command = text.slice(1).split(' ')[0].toLowerCase();
        
        // Fetch commands from your backend here
        // For now, just acknowledge
        await sock.sendMessage(from, { 
          text: `Command received: /${command}` 
        });
      }
    }
  });

  return sock;
};

// Request pairing code
app.post('/api/pair', async (req, res) => {
  try {
    const { sessionId, phoneNumber } = req.body;
    
    if (!sessionId || !phoneNumber) {
      return res.status(400).json({ error: 'sessionId and phoneNumber required' });
    }

    // Clean phone number (remove + and spaces)
    const cleanPhone = phoneNumber.replace(/[^0-9]/g, '');
    
    await createSession(sessionId, cleanPhone);
    const session = sessions.get(sessionId);
    
    // Wait for socket to be ready
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    // Request pairing code
    const code = await session.sock.requestPairingCode(cleanPhone);
    
    res.json({ 
      success: true, 
      pairCode: code,
      message: 'Enter this code in WhatsApp > Linked Devices > Link a Device'
    });
  } catch (error) {
    console.error('Pairing error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get session status
app.get('/api/status/:sessionId', (req, res) => {
  const { sessionId } = req.params;
  const session = sessions.get(sessionId);
  
  if (!session) {
    return res.json({ status: 'not_found' });
  }
  
  res.json({ status: session.status });
});

// Send message
app.post('/api/send', async (req, res) => {
  try {
    const { sessionId, to, message } = req.body;
    const session = sessions.get(sessionId);
    
    if (!session || session.status !== 'connected') {
      return res.status(400).json({ error: 'Session not connected' });
    }
    
    const jid = to.includes('@') ? to : `${to}@s.whatsapp.net`;
    await session.sock.sendMessage(jid, { text: message });
    
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Disconnect session
app.post('/api/disconnect/:sessionId', async (req, res) => {
  const { sessionId } = req.params;
  const session = sessions.get(sessionId);
  
  if (session) {
    await session.sock.logout();
    sessions.delete(sessionId);
  }
  
  res.json({ success: true });
});

// Health check
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    activeSessions: sessions.size,
    uptime: process.uptime()
  });
});

// WebSocket connection handler
wss.on('connection', (ws, req) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const sessionId = url.searchParams.get('sessionId');
  
  if (!sessionId) {
    ws.close(1008, 'sessionId required');
    return;
  }
  
  console.log(`[WS] Client connected for session: ${sessionId}`);
  
  if (!wsClients.has(sessionId)) {
    wsClients.set(sessionId, []);
  }
  wsClients.get(sessionId).push(ws);
  
  // Send current status
  const session = sessions.get(sessionId);
  if (session) {
    ws.send(JSON.stringify({ type: 'connection', status: session.status }));
  }
  
  ws.on('close', () => {
    const clients = wsClients.get(sessionId) || [];
    wsClients.set(sessionId, clients.filter(c => c !== ws));
    console.log(`[WS] Client disconnected from session: ${sessionId}`);
  });
});

server.listen(PORT, () => {
  console.log(`🚀 Baileys server running on port ${PORT}`);
  console.log(`📡 WebSocket available at ws://localhost:${PORT}`);
});
