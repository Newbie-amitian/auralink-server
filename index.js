const http = require('http');
const https = require('https');
const { Server } = require('socket.io');
const { createClient } = require('@supabase/supabase-js');

// ── SUPABASE ───────────────────────────────────────────────────
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY // use service role key (bypasses RLS)
);

const server = http.createServer((req, res) => {
  if (req.url === '/ping') {
    res.writeHead(200);
    res.end('pong');
    return;
  }
  res.writeHead(200);
  res.end('AuraLink Signaling Server 🚀');
});

const io = new Server(server, {
  cors: { origin: '*' }
});

console.log('🚀 AuraLink Signaling Server starting...');

// deviceCode → socketId (in-memory presence)
const deviceSockets = new Map();

// ── SUPABASE HELPERS ───────────────────────────────────────────
async function setDeviceOnline(deviceCode, platform) {
  const { error } = await supabase.from('devices').upsert({
    device_code: deviceCode,
    platform: platform || 'windows',
    is_online: true,
    last_seen: new Date().toISOString(),
    session_id: null,
  }, { onConflict: 'device_code' });
  if (error) console.error('[Supabase] setOnline error:', error.message);
}

async function setDeviceOffline(deviceCode) {
  const { error } = await supabase.from('devices').update({
    is_online: false,
    last_seen: new Date().toISOString(),
    session_id: null,
  }).eq('device_code', deviceCode);
  if (error) console.error('[Supabase] setOffline error:', error.message);
}

async function setSessionId(deviceCode, sessionId) {
  const { error } = await supabase.from('devices').update({
    session_id: sessionId,
  }).eq('device_code', deviceCode);
  if (error) console.error('[Supabase] setSession error:', error.message);
}

async function logSessionStart(hostDevice, viewerDevice) {
  const sessionId = `${hostDevice}_${viewerDevice}_${Date.now()}`;
  const { error } = await supabase.from('session_logs').insert({
    host_device: hostDevice,
    viewer_device: viewerDevice,
    started_at: new Date().toISOString(),
  });
  if (error) console.error('[Supabase] logStart error:', error.message);
  return sessionId;
}

async function logSessionEnd(hostDevice, viewerDevice) {
  // find latest open session between these two
  const { data, error } = await supabase
    .from('session_logs')
    .select('id, started_at')
    .eq('host_device', hostDevice)
    .eq('viewer_device', viewerDevice)
    .is('ended_at', null)
    .order('started_at', { ascending: false })
    .limit(1);

  if (error || !data?.length) return;

  const started = new Date(data[0].started_at);
  const ended = new Date();
  const duration = Math.floor((ended - started) / 1000);

  await supabase.from('session_logs').update({
    ended_at: ended.toISOString(),
    duration_secs: duration,
  }).eq('id', data[0].id);
}

// ── Keep-alive self ping (prevents Render free tier sleep) ──────
const RENDER_URL = process.env.RENDER_URL || '';
if (RENDER_URL) {
  setInterval(() => {
    https.get(`${RENDER_URL}/ping`, () => {}).on('error', () => {});
    console.log('[Keep-alive] ping sent');
  }, 10 * 60 * 1000); // every 10 minutes
}

io.on('connection', (socket) => {
  console.log(`[+] Connected: ${socket.id}`);

  // ── DEVICE REGISTRATION ────────────────────────────────────
  socket.on('register-device', async ({ deviceCode, platform }) => {
    socket.deviceCode = deviceCode;
    socket.platform = platform;
    deviceSockets.set(deviceCode, socket.id);
    socket.join(deviceCode);

    // update Supabase → is_online = true
    await setDeviceOnline(deviceCode, platform);

    console.log(`[Register] ${deviceCode} (${platform}) → ${socket.id}`);
    socket.emit('registered', { deviceCode, status: 'online' });
  });

  // ── DEVICE DISCOVERY ───────────────────────────────────────
  socket.on('check-device', ({ deviceCode }) => {
    const isOnline = deviceSockets.has(deviceCode);
    console.log(`[Check] ${deviceCode} → ${isOnline ? 'online' : 'offline'}`);
    socket.emit('device-status', { deviceCode, isOnline });
  });

  // ── SESSION REQUEST ────────────────────────────────────────
  socket.on('session-request', ({ targetDeviceCode, viewerDeviceCode }) => {
    console.log(`[Session] ${viewerDeviceCode} → ${targetDeviceCode}`);
    socket.viewerOf = targetDeviceCode;
    socket.join(`peer:${targetDeviceCode}`);
    io.to(targetDeviceCode).emit('session-request', { viewerDeviceCode });
  });

  // Host → Viewer: accepted or rejected
  socket.on('session-response', async ({ viewerDeviceCode, accepted }) => {
    console.log(`[Session] ${socket.deviceCode} ${accepted ? 'accepted' : 'rejected'} ${viewerDeviceCode}`);
    
    if (accepted) {
      // log session start in Supabase
      await logSessionStart(socket.deviceCode, viewerDeviceCode);
      // update session_id on both devices
      const sessionId = `${socket.deviceCode}_${viewerDeviceCode}_${Date.now()}`;
      await setSessionId(socket.deviceCode, sessionId);
    }

    io.to(viewerDeviceCode).emit('session-response', {
      accepted,
      hostDeviceCode: socket.deviceCode
    });
  });

  // ── WEBRTC SIGNALING ───────────────────────────────────────
  socket.on('offer', ({ targetDeviceCode, sdp }) => {
    console.log(`[Offer] → ${targetDeviceCode}`);
    io.to(targetDeviceCode).emit('offer', {
      sdp,
      fromDeviceCode: socket.deviceCode
    });
  });

  socket.on('answer', ({ targetDeviceCode, sdp }) => {
    console.log(`[Answer] → ${targetDeviceCode}`);
    io.to(targetDeviceCode).emit('answer', {
      sdp,
      fromDeviceCode: socket.deviceCode
    });
  });

  socket.on('ice-candidate', ({ targetDeviceCode, candidate }) => {
    io.to(targetDeviceCode).emit('ice-candidate', {
      candidate,
      fromDeviceCode: socket.deviceCode
    });
  });

  // ── CHAT ───────────────────────────────────────────────────
  socket.on('chat-message', ({ targetDeviceCode, message, senderCode }) => {
    io.to(targetDeviceCode).emit('chat-message', { message, senderCode });
  });

  // ── REACTIONS ──────────────────────────────────────────────
  socket.on('reaction', ({ targetDeviceCode, emoji, senderCode }) => {
    io.to(targetDeviceCode).emit('reaction', { emoji, senderCode });
  });

  // ── FILE METADATA ──────────────────────────────────────────
  socket.on('file-meta', ({ targetDeviceCode, fileName, fileSize, fileType, transferId }) => {
    console.log(`[File] ${fileName} (${fileSize}b) → ${targetDeviceCode}`);
    io.to(targetDeviceCode).emit('file-meta', {
      fileName,
      fileSize,
      fileType,
      transferId,
      senderCode: socket.deviceCode
    });
  });

  // ── SESSION END ────────────────────────────────────────────
  socket.on('end-session', async ({ targetDeviceCode }) => {
    console.log(`[End] ${socket.deviceCode} ended session with ${targetDeviceCode}`);
    
    // log session end in Supabase
    await logSessionEnd(socket.deviceCode, targetDeviceCode);
    await setSessionId(socket.deviceCode, null);
    await setSessionId(targetDeviceCode, null);

    io.to(targetDeviceCode).emit('session-ended', {
      byDeviceCode: socket.deviceCode
    });
  });

  // ── DISCONNECT ─────────────────────────────────────────────
  socket.on('disconnect', async () => {
    if (socket.deviceCode) {
      deviceSockets.delete(socket.deviceCode);

      // update Supabase → is_online = false
      await setDeviceOffline(socket.deviceCode);

      // notify peer if in session
      io.to(`peer:${socket.deviceCode}`).emit('device-offline', {
        deviceCode: socket.deviceCode
      });
      console.log(`[-] Device offline: ${socket.deviceCode}`);
    }
    console.log(`[-] Disconnected: ${socket.id}`);
  });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`✅ AuraLink Signaling Server running on port ${PORT}`);
});