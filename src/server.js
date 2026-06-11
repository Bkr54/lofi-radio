const express = require('express');
const session = require('express-session');
const WebSocket = require('ws');
const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { loadConfig, saveConfig } = require('./config');
const StreamEngine = require('./streamEngineV2');
const BroadcastScheduler = require('./broadcastScheduler');
const logger = require('./logger');

const app = express();
const config = loadConfig();
const streamManager = new StreamEngine(config);
const scheduler = new BroadcastScheduler(streamManager);
logger.info('Streaming engine: permanent / gapless');

// Verifies a password against a "scrypt$<salt>$<hash>" hash (timing-safe), with no external dependency.
function verifyPassword(plain, stored) {
  try {
    if (!stored || !plain) return false;
    const [scheme, salt, hashHex] = String(stored).split('$');
    if (scheme !== 'scrypt' || !salt || !hashHex) return false;
    const expected = Buffer.from(hashHex, 'hex');
    const actual = crypto.scryptSync(plain, salt, expected.length);
    return crypto.timingSafeEqual(expected, actual);
  } catch (e) {
    return false;
  }
}

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, '../public')));

// Behind the nginx reverse-proxy (HTTPS): required for "secure" cookies
app.set('trust proxy', 1);

if (!process.env.SESSION_SECRET) {
  logger.warn('SESSION_SECRET is not set in the environment — using a temporary random secret');
}

app.use(session({
  secret: process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex'),
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: process.env.COOKIE_SECURE === '1',
    httpOnly: true,
    sameSite: 'lax',
    maxAge: 24 * 60 * 60 * 1000
  }
}));

function requireAuth(req, res, next) {
  if (req.session.authenticated) {
    next();
  } else {
    res.redirect('/login');
  }
}

// Unauthenticated health endpoint (non-sensitive state) for monitoring.
app.get('/healthz', (req, res) => {
  const s = streamManager.getStatus();
  const ffmpegAlive = !!(streamManager.ffmpegProcess && !streamManager.ffmpegProcess.killed);
  res.json({
    ok: true,
    isStreaming: s.isStreaming,
    isPaused: s.isPaused,
    mode: s.mode,
    ffmpegAlive,
    currentTrack: s.currentTrack,
    uptime: s.stats ? s.stats.uptime : 0
  });
});

app.get('/', (req, res) => {
  res.redirect('/login');
});

app.get('/login', (req, res) => {
  if (req.session.authenticated) {
    res.redirect('/dashboard');
  } else {
    res.sendFile(path.join(__dirname, '../views/login.html'));
  }
});

app.post('/login', (req, res) => {
  const { password } = req.body;
  if (verifyPassword(password, config.passwordHash)) {
    req.session.authenticated = true;
    res.json({ success: true });
  } else {
    res.status(401).json({ success: false, error: 'Incorrect password' });
  }
});

app.get('/logout', (req, res) => {
  req.session.destroy();
  res.redirect('/login');
});

app.get('/dashboard', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, '../views/dashboard.html'));
});

app.get('/text-management', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, '../views/text-management.html'));
});

app.get('/schedule', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, '../views/schedule.html'));
});

app.get('/api/playlists', requireAuth, async (req, res) => {
  const playlists = await streamManager.getPlaylists();
  res.json(playlists);
});

app.get('/api/videos', requireAuth, async (req, res) => {
  const videos = await streamManager.getBackgroundVideos();
  res.json(videos);
});

app.get('/api/status', requireAuth, (req, res) => {
  res.json(streamManager.getStatus());
});

app.post('/api/stream/start', requireAuth, async (req, res) => {
  try {
    const { playlist, video } = req.body;
    await streamManager.startStream(playlist, video);
    res.json({ success: true, message: 'Stream started' });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

app.post('/api/stream/stop', requireAuth, (req, res) => {
  streamManager.stopStream();
  res.json({ success: true, message: 'Stream stopped' });
});

app.post('/api/stream/emergency-stop', requireAuth, (req, res) => {
  streamManager.emergencyStop();
  res.json({ success: true, message: 'Emergency stop executed' });
});

app.post('/api/stream/hotswap/playlist', requireAuth, async (req, res) => {
  try {
    const { playlist } = req.body;
    await streamManager.hotSwapPlaylist(playlist);
    res.json({ success: true, message: 'Playlist changed' });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

app.post('/api/stream/hotswap/video', requireAuth, async (req, res) => {
  try {
    const { video } = req.body;
    await streamManager.hotSwapVideo(video);
    res.json({ success: true, message: 'Video changed' });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

app.post('/api/text/overlay', requireAuth, (req, res) => {
  streamManager.updateTextOverlay(req.body);
  res.json({ success: true, message: 'Text overlay updated' });
});

app.post('/api/text/messages', requireAuth, (req, res) => {
  const { messages } = req.body;
  streamManager.updateMessages(messages);
  res.json({ success: true, message: 'Messages updated' });
});

app.get('/api/config', requireAuth, (req, res) => {
  res.json({
    streamUrl: config.streamUrl,
    videoBitrate: config.videoBitrate,
    audioBitrate: config.audioBitrate,
    resolution: config.resolution,
    fps: config.fps
  });
});

// NOTE: the stream key is now managed via .env (STREAM_KEY).
// This route only updates it in memory (until the next restart).
// To change it permanently: edit STREAM_KEY in <app>/.env then restart the service.
app.post('/api/config/stream-key', requireAuth, (req, res) => {
  const { streamKey } = req.body;
  config.streamKey = streamKey;
  streamManager.config = config;
  res.json({ success: true, message: 'Stream key applied (in memory — edit .env for persistence)' });
});

// Schedule API Routes
app.get('/api/schedule', requireAuth, (req, res) => {
  res.json(scheduler.getAllEvents());
});

app.get('/api/schedule/upcoming', requireAuth, (req, res) => {
  const hours = parseInt(req.query.hours) || 24;
  res.json(scheduler.getUpcomingEvents(hours));
});

app.get('/api/schedule/current', requireAuth, (req, res) => {
  res.json({ currentEvent: scheduler.getCurrentEvent() });
});

app.post('/api/schedule/event/weekly', requireAuth, (req, res) => {
  try {
    const event = scheduler.addWeeklyEvent(req.body);
    res.json({ success: true, event });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

app.post('/api/schedule/event/onetime', requireAuth, (req, res) => {
  try {
    const event = scheduler.addOneTimeEvent(req.body);
    res.json({ success: true, event });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

app.put('/api/schedule/event/:id', requireAuth, (req, res) => {
  try {
    const event = scheduler.updateEvent(req.params.id, req.body);
    if (event) {
      res.json({ success: true, event });
    } else {
      res.status(404).json({ success: false, error: 'Event not found' });
    }
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

app.delete('/api/schedule/event/:id', requireAuth, (req, res) => {
  try {
    const event = scheduler.removeEvent(req.params.id);
    if (event) {
      res.json({ success: true, event });
    } else {
      res.status(404).json({ success: false, error: 'Event not found' });
    }
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

app.post('/api/schedule/play-now/:id', requireAuth, async (req, res) => {
  try {
    const event = await scheduler.playNow(req.params.id);
    res.json({ success: true, event });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

app.post('/api/schedule/defaults', requireAuth, (req, res) => {
  try {
    const defaults = scheduler.updateDefaults(req.body);
    res.json({ success: true, defaults });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

app.get('/api/videos/programs', requireAuth, async (req, res) => {
  const videos = await streamManager.getProgramVideos();
  res.json(videos);
});

app.post('/api/stream/stop-program', requireAuth, async (req, res) => {
  try {
    await streamManager.stopProgram();
    res.json({ success: true, message: 'Program stopped' });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

wss.on('connection', (ws, req) => {
  logger.info('WebSocket client connected');

  ws.send(JSON.stringify({
    type: 'status',
    data: streamManager.getStatus()
  }));

  ws.on('close', () => {
    logger.info('WebSocket client disconnected');
  });
});

function broadcast(data) {
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify(data));
    }
  });
}

streamManager.on('status', (data) => {
  broadcast({ type: 'status', data });
});

streamManager.on('trackChange', (data) => {
  broadcast({ type: 'trackChange', data });
});

streamManager.on('progress', (data) => {
  broadcast({ type: 'progress', data });
});

streamManager.on('hotSwap', (data) => {
  broadcast({ type: 'hotSwap', data });
});

streamManager.on('textUpdate', (data) => {
  broadcast({ type: 'textUpdate', data });
});

streamManager.on('error', (error) => {
  broadcast({ type: 'error', data: { error } });
});

streamManager.on('mode:changed', (data) => {
  broadcast({ type: 'modeChanged', data });
});

streamManager.on('program:ended', (data) => {
  broadcast({ type: 'programEnded', data });
  scheduler.handleProgramEnd();
});

streamManager.on('music:resumed', (data) => {
  broadcast({ type: 'musicResumed', data });
});

// Scheduler events
scheduler.on('event:triggered', (event) => {
  broadcast({ type: 'scheduleEventTriggered', data: event });
});

scheduler.on('event:ended', (event) => {
  broadcast({ type: 'scheduleEventEnded', data: event });
});

scheduler.on('event:error', (data) => {
  broadcast({ type: 'scheduleEventError', data });
});

scheduler.on('event:added', (event) => {
  broadcast({ type: 'scheduleEventAdded', data: event });
});

scheduler.on('event:updated', (event) => {
  broadcast({ type: 'scheduleEventUpdated', data: event });
});

scheduler.on('event:removed', (event) => {
  broadcast({ type: 'scheduleEventRemoved', data: event });
});

const PORT = config.port || 5228;
server.listen(PORT, '127.0.0.1', () => {
  logger.info(`
╔════════════════════════════════════════════════════════════╗
║              LOFI RADIO DASHBOARD                          ║
╠════════════════════════════════════════════════════════════╣
║  Port: ${PORT}                                             ║
║  Public: https://your-domain.example                       ║
║  Stream: ${config.streamUrl}                               ║
╚════════════════════════════════════════════════════════════╝
  `);
});

process.on('SIGINT', () => {
  logger.info('\nShutting down server...');
  streamManager.stopStream();
  process.exit(0);
});

process.on('SIGTERM', () => {
  logger.info('\nShutting down server...');
  streamManager.stopStream();
  process.exit(0);
});
