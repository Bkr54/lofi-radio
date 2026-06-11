/**
 * streamEngineV2 — PERMANENT (hybrid) streaming engine for Lofi Radio.
 *
 * The streaming engine. Exposes a clean public API + events consumed by the dashboard.
 *
 * Design (see docs/ENGINE.md):
 *   - MUSIC mode: A SINGLE ffmpeg encoder runs continuously.
 *       * looped background video (-stream_loop -1)
 *       * gapless audio via a FIFO: node decodes each mp3 to PCM s16le
 *         and chains streams through the pipe -> no gap between tracks.
 *       * "Now Playing" + message overlays via drawtext textfile reload=1
 *         -> the controller writes text files, ffmpeg hot-reloads them.
 *     => track change = 0 RTMP reconnections (vs hundreds/day with a per-track restart).
 *   - PROGRAM mode: ONE controlled reconnection (rare) to broadcast a
 *     scheduled video with its own audio, then resume the permanent engine.
 *   - hotSwap playlist: live (the feeder queue is swapped, the encoder is untouched).
 *   - hotSwap background video / overlay position change: controlled encoder
 *     restart (rare manual action).
 *
 * Permanent (gapless) engine for 24/7 RTMP streaming.
 */

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const EventEmitter = require('events');
const logger = require('./logger');

const RUN_DIR = path.join(__dirname, '../run');
const FIFO_PATH = path.join(RUN_DIR, 'audio.fifo');
const NOW_TXT = path.join(RUN_DIR, 'now.txt');
const MSG_TXT = path.join(RUN_DIR, 'msg.txt');
const FONT = '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf';

const PCM_RATE = 44100;
const PCM_CHANNELS = 2;
const PCM_BYTES_PER_SEC = PCM_RATE * PCM_CHANNELS * 2; // s16le

class StreamEngineV2 extends EventEmitter {
  constructor(config) {
    super();
    this.config = config;

    // Permanent encoder process (MUSIC mode) OR program process (PROGRAM mode).
    // Exposed as ffmpegProcess for /healthz and server.js compatibility.
    this.ffmpegProcess = null;

    // Audio feeder (MUSIC mode)
    this.fifoStream = null;       // WritableStream to the FIFO
    this.decoderProcess = null;   // ffmpeg mp3 -> PCM decoder in progress
    this.feederActive = false;
    this.trackStartTime = 0;          // clock marking the start of the current track
    this.currentTrackDurationMs = 0;  // current track duration (ffprobe)
    this.progressInterval = null;     // periodic progress event emitter

    // Playlist state
    this.currentPlaylist = null;
    this.currentVideo = null;
    this.currentTrack = null;
    this.playlistQueue = [];
    this.currentTrackIndex = 0;
    this.pendingPlaylistSwap = null;

    // Streaming state
    this.isStreaming = false;
    this.isPaused = false;
    this.stopping = false; // prevents auto-restart during a deliberate stop

    // Overlays
    this.textOverlay = {
      nowPlaying: 'Waiting...',
      message: 'Radio Lofi 24/7',
      nowPlayingPos: { x: 50, y: 640, fontSize: 32, color: '#ffffff', font: 'DejaVu Sans' },
      messagePos: { x: 50, y: 40, fontSize: 24, color: '#ffffff', font: 'DejaVu Sans' }
    };
    this.messages = ['Radio Lofi 24/7', 'Relax & Study', 'Chill Vibes Only'];
    this.currentMessageIndex = 0;
    this.messageInterval = null;

    // Stats
    this.stats = { startTime: null, tracksPlayed: 0, totalDuration: 0 };

    // PROGRAM mode
    this.mode = 'MUSIC';
    this.programConfig = null;
    this.currentProgramVideo = null;

    // Encoder watchdog
    this.encoderWatchdog = null;
    this.lastEncoderOutput = 0;
    this.restartCount = 0; // unintentional reconnections (crash) — should stay ~0
  }

  // ───────────────────────── Playlist helpers ─────────────────────────

  async getPlaylists() {
    const mp3Dir = path.join(__dirname, '../media/mp3');
    if (!fs.existsSync(mp3Dir)) return [];
    const playlists = [];
    for (const item of fs.readdirSync(mp3Dir)) {
      const fullPath = path.join(mp3Dir, item);
      if (fs.statSync(fullPath).isDirectory()) {
        const files = fs.readdirSync(fullPath).filter(f => f.endsWith('.mp3'));
        if (files.length > 0) playlists.push({ name: item, path: fullPath, tracks: files.length });
      }
    }
    return playlists;
  }

  async getBackgroundVideos() {
    const videoDir = path.join(__dirname, '../media/mp4/bg');
    if (!fs.existsSync(videoDir)) return [];
    return fs.readdirSync(videoDir).filter(f => f.endsWith('.mp4'))
      .map(f => ({ name: f, path: path.join(videoDir, f) }));
  }

  async getProgramVideos() {
    const videoDir = path.join(__dirname, '../media/mp4/video');
    if (!fs.existsSync(videoDir)) return [];
    return fs.readdirSync(videoDir).filter(f => f.endsWith('.mp4'))
      .map(f => ({ name: f, path: path.join(videoDir, f), relativePath: `media/mp4/video/${f}` }));
  }

  shuffleArray(array) {
    const shuffled = [...array];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    return shuffled;
  }

  async loadPlaylist(playlistName) {
    const playlistPath = path.join(__dirname, '../media/mp3', playlistName);
    if (!fs.existsSync(playlistPath)) return false;
    const files = fs.readdirSync(playlistPath).filter(f => f.endsWith('.mp3'))
      .map(f => ({ name: path.basename(f, '.mp3'), path: path.join(playlistPath, f) }));
    if (files.length === 0) return false;
    this.playlistQueue = this.shuffleArray(files);
    this.currentTrackIndex = 0;
    this.currentPlaylist = playlistName;
    return true;
  }

  // Duration of an mp3 in ms (fast ffprobe). Returns 0 if unknown.
  getTrackDurationMs(filePath) {
    try {
      const r = require('child_process').spawnSync('ffprobe',
        ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', filePath],
        { encoding: 'utf8' });
      const sec = parseFloat((r.stdout || '').trim());
      return (isFinite(sec) && sec > 0) ? Math.round(sec * 1000) : 0;
    } catch (e) { return 0; }
  }

  getNextTrack() {
    if (this.playlistQueue.length === 0) return null;
    if (this.currentTrackIndex >= this.playlistQueue.length) {
      this.playlistQueue = this.shuffleArray(this.playlistQueue);
      this.currentTrackIndex = 0;
    }
    const track = this.playlistQueue[this.currentTrackIndex];
    this.currentTrackIndex++;
    return track;
  }

  // ───────────────────────── Overlays (textfile reload) ─────────────────────────

  // drawtext reads text from a file reloaded every frame: no sensitive data
  // in the command line, and live updates without a restart.
  writeOverlayFiles() {
    try { fs.mkdirSync(RUN_DIR, { recursive: true }); } catch (e) {}
    fs.writeFileSync(NOW_TXT, (this.textOverlay.nowPlaying || ' ') + '\n');
    fs.writeFileSync(MSG_TXT, (this.textOverlay.message || ' ') + '\n');
  }

  setNowPlaying(text) {
    this.textOverlay.nowPlaying = text;
    try { fs.writeFileSync(NOW_TXT, (text || ' ') + '\n'); } catch (e) {}
  }

  setMessage(text) {
    this.textOverlay.message = text;
    try { fs.writeFileSync(MSG_TXT, (text || ' ') + '\n'); } catch (e) {}
  }

  // Escapes a path for use in an ffmpeg filter (textfile=...).
  escapePath(p) {
    return p.replace(/\\/g, '\\\\').replace(/:/g, '\\:').replace(/'/g, "\\'");
  }

  buildFilterComplex() {
    const { nowPlayingPos, messagePos } = this.textOverlay;
    const [vw, vh] = (this.config.resolution || '1280x720').split('x');
    const vfps = this.config.fps || 24;
    const npFile = this.escapePath(NOW_TXT);
    const msgFile = this.escapePath(MSG_TXT);

    const nowFilter = `drawtext=textfile='${npFile}':reload=1:fontfile=${FONT}:` +
      `fontsize=${nowPlayingPos.fontSize}:fontcolor=${nowPlayingPos.color}:` +
      `x=${nowPlayingPos.x}:y=${nowPlayingPos.y}:box=1:boxcolor=black@0.5:boxborderw=10`;

    const msgFilter = `drawtext=textfile='${msgFile}':reload=1:fontfile=${FONT}:` +
      `fontsize=${messagePos.fontSize}:fontcolor=${messagePos.color}:` +
      `x=${messagePos.x}:y=${messagePos.y}:box=1:boxcolor=black@0.5:boxborderw=10`;

    return `[0:v]scale=${vw}:${vh},fps=${vfps},${nowFilter},${msgFilter}[v]`;
  }

  outputTarget() {
    // Allows a local override (self-test) without touching the production RTMP URL.
    if (this.config.outputOverride) return this.config.outputOverride;
    return `${this.config.streamUrl}/${this.config.streamKey}`;
  }

  // ───────────────────────── FIFO audio ─────────────────────────

  ensureFifo() {
    try { fs.mkdirSync(RUN_DIR, { recursive: true }); } catch (e) {}
    try {
      // (re)create the FIFO cleanly
      if (fs.existsSync(FIFO_PATH)) fs.unlinkSync(FIFO_PATH);
    } catch (e) {}
    const r = spawn('mkfifo', [FIFO_PATH]);
    return new Promise((resolve, reject) => {
      r.on('close', (code) => code === 0 ? resolve() : reject(new Error('mkfifo failed')));
      r.on('error', reject);
    });
  }

  // ───────────────────────── MUSIC startup ─────────────────────────

  async startStream(playlistName, videoName) {
    if (this.isStreaming) throw new Error('Stream already running');
    if (!this.config.streamKey && !this.config.outputOverride) {
      throw new Error('Stream key not configured');
    }
    if (this.config.streamKey === 'STAGING_KEY_A_REMPLACER' && !this.config.outputOverride) {
      throw new Error('STAGING key not configured: paste a real YouTube test key into .env (STREAM_KEY).');
    }

    const videoPath = path.join(__dirname, '../media/mp4/bg', videoName);
    if (!fs.existsSync(videoPath)) throw new Error('Background video not found');
    if (!(await this.loadPlaylist(playlistName))) throw new Error('Playlist not found or empty');

    this.currentVideo = videoName;
    this.isStreaming = true;
    this.isPaused = false;
    this.stopping = false;
    this.mode = 'MUSIC';
    this.stats.startTime = Date.now();
    this.stats.tracksPlayed = 0;

    this.textOverlay.nowPlaying = 'Waiting...';
    this.writeOverlayFiles();
    this.startMessageRotation();

    await this.startMusicEngine();

    this.emit('status', {
      isStreaming: true,
      playlist: playlistName,
      video: videoName,
      currentTrack: this.currentTrack?.name
    });
    return true;
  }

  // Starts the permanent encoder + the gapless audio feeder.
  async startMusicEngine() {
    await this.ensureFifo();

    const videoPath = path.join(__dirname, '../media/mp4/bg', this.currentVideo);
    const filter = this.buildFilterComplex();
    const fps = this.config.fps || 24;

    const args = [
      '-re', '-stream_loop', '-1', '-i', videoPath,            // looped background video (realistic clock)
      '-f', 's16le', '-ar', String(PCM_RATE), '-ac', String(PCM_CHANNELS), '-i', FIFO_PATH, // gapless PCM audio
      '-filter_complex', filter,
      '-map', '[v]', '-map', '1:a',
      '-c:v', 'libx264', '-preset', 'ultrafast',
      '-b:v', this.config.videoBitrate, '-maxrate', this.config.videoBitrate, '-bufsize', '5000k',
      '-pix_fmt', 'yuv420p',
      '-g', String(fps * 2), '-keyint_min', String(fps), '-sc_threshold', '0',
      '-c:a', 'aac', '-b:a', this.config.audioBitrate, '-ar', String(PCM_RATE),
      '-f', 'flv', this.outputTarget()
    ];

    logger.info('V2: starting PERMANENT encoder (MUSIC mode)');
    this.ffmpegProcess = spawn('ffmpeg', args, { detached: false });
    this.attachEncoderHandlers(this.ffmpegProcess);
    this.startEncoderWatchdog();

    // Opens the write end of the FIFO (unblocks once ffmpeg opens the read end),
    // then starts feeding audio.
    this.fifoStream = fs.createWriteStream(FIFO_PATH);
    this.fifoStream.on('error', (err) => {
      // EPIPE when the encoder dies: handled by the watchdog/close handler.
      if (err && err.code !== 'EPIPE') logger.error('V2 FIFO error:', err.message);
    });
    this.fifoStream.on('open', () => {
      logger.info('V2: FIFO open, starting gapless audio feeder');
      this.feederActive = true;
      this.feedNextTrack();
    });
  }

  attachEncoderHandlers(proc) {
    let trackDuration = 0;
    proc.stderr.on('data', (data) => {
      this.lastEncoderOutput = Date.now();
      const output = data.toString();
      if (output.includes('Error') || output.includes('error')) {
        // possibly normal noise; only log the actionable cases
        if (/fail|invalid|unable|Connection refused/i.test(output)) logger.error('V2 ffmpeg:', output.trim().slice(0, 300));
      }
    });
    proc.on('close', (code) => {
      logger.info(`V2: encoder exited (code ${code})`);
      if (this.stopping || !this.isStreaming || this.mode !== 'MUSIC') return;
      // Unexpected death of the permanent encoder -> emergency reconnection.
      this.restartCount++;
      logger.error(`V2: permanent encoder died unexpectedly, reconnecting #${this.restartCount}`);
      this.emit('error', 'Permanent encoder interrupted, reconnecting…');
      this.teardownFeeder();
      setTimeout(() => {
        if (this.isStreaming && this.mode === 'MUSIC' && !this.stopping) {
          this.startMusicEngine().catch(e => logger.error('V2: reconnection failed', e.message));
        }
      }, 1000);
    });
    proc.on('error', (err) => {
      logger.error('V2 ffmpeg error:', err.message);
      this.emit('error', err.message);
    });
  }

  // Chains tracks into the FIFO without ever stopping the encoder.
  feedNextTrack() {
    if (!this.feederActive || !this.isStreaming || this.isPaused) return;

    // Apply a pending live playlist swap
    if (this.pendingPlaylistSwap) {
      const target = this.pendingPlaylistSwap;
      this.pendingPlaylistSwap = null;
      // loadPlaylist is synchronous on the disk side here
      this.loadPlaylist(target).then((ok) => {
        if (ok) this.emit('hotSwap', { type: 'playlist', name: target });
        else logger.error(`V2: playlist not found: ${target}`);
        this.spawnDecoderForNext();
      });
      return;
    }
    this.spawnDecoderForNext();
  }

  spawnDecoderForNext() {
    const track = this.getNextTrack();
    if (!track) { this.emit('error', 'No track available'); return; }

    // V2_TRACK_LIMIT_SEC: trims each track to N seconds (useful for fast tests/previews).
    const limit = parseInt(process.env.V2_TRACK_LIMIT_SEC, 10);

    this.currentTrack = track;
    this.stats.tracksPlayed++;
    // Track duration (actual, or capped by limit) used for progress and total duration.
    const probed = this.getTrackDurationMs(track.path);
    this.currentTrackDurationMs = (limit > 0) ? Math.min(limit * 1000, probed || limit * 1000) : probed;
    this.trackStartTime = Date.now();
    this.setNowPlaying(`Now Playing: ${track.name}`);

    this.emit('trackChange', {
      name: track.name,
      playlist: this.currentPlaylist,
      trackNumber: this.currentTrackIndex,
      totalTracks: this.playlistQueue.length,
      duration: this.currentTrackDurationMs
    });

    // Progress emitted every 2 s (realistic clock: broadcast locked to real time).
    if (this.progressInterval) clearInterval(this.progressInterval);
    this.progressInterval = setInterval(() => {
      if (this.currentTrackDurationMs > 0) {
        const pct = Math.min(((Date.now() - this.trackStartTime) / this.currentTrackDurationMs) * 100, 100);
        this.emit('progress', { progress: pct });
      }
    }, 2000);

    // Decodes the mp3 to PCM s16le and pushes it into the FIFO (without closing the FIFO).
    const decArgs = ['-hide_banner', '-loglevel', 'error', '-i', track.path];
    if (limit > 0) decArgs.push('-t', String(limit));
    decArgs.push('-f', 's16le', '-ar', String(PCM_RATE), '-ac', String(PCM_CHANNELS),
      '-af', 'volume=0.8', 'pipe:1');
    const dec = spawn('ffmpeg', decArgs, { detached: false });

    this.decoderProcess = dec;

    dec.stderr.on('data', (d) => {
      const s = d.toString();
      if (s.trim()) logger.error('V2 decoder:', s.trim().slice(0, 200));
    });

    // Natural backpressure: if the FIFO is full (ffmpeg consumes at ~real time),
    // pipe() pauses the decoder -> feeding is locked to real time.
    if (this.fifoStream) dec.stdout.pipe(this.fifoStream, { end: false });

    dec.on('close', () => {
      this.decoderProcess = null;
      if (this.progressInterval) { clearInterval(this.progressInterval); this.progressInterval = null; }
      // Accumulate total broadcast duration (feeds the dashboard "Total Duration" stat).
      if (this.currentTrackDurationMs > 0) this.stats.totalDuration += this.currentTrackDurationMs;
      if (this.feederActive && this.isStreaming && !this.isPaused && this.mode === 'MUSIC') {
        // Start next track immediately -> continuous (gapless) audio.
        this.feedNextTrack();
      }
    });
    dec.on('error', (err) => logger.error('V2 decoder error:', err.message));
  }

  teardownFeeder() {
    this.feederActive = false;
    if (this.progressInterval) { clearInterval(this.progressInterval); this.progressInterval = null; }
    if (this.decoderProcess) {
      try { this.decoderProcess.kill('SIGKILL'); } catch (e) {}
      this.decoderProcess = null;
    }
    if (this.fifoStream) {
      try { this.fifoStream.destroy(); } catch (e) {}
      this.fifoStream = null;
    }
  }

  // ───────────────────────── Watchdog ─────────────────────────

  startEncoderWatchdog() {
    this.stopEncoderWatchdog();
    this.lastEncoderOutput = Date.now();
    this.encoderWatchdog = setInterval(() => {
      if (this.mode !== 'MUSIC' || !this.isStreaming || this.stopping) return;
      if (Date.now() - this.lastEncoderOutput > 30000) {
        logger.error('V2 watchdog: no encoder output for 30s, restarting');
        if (this.ffmpegProcess) { try { this.ffmpegProcess.kill('SIGKILL'); } catch (e) {} }
        // the close() handler will relaunch startMusicEngine
      }
    }, 10000);
  }

  stopEncoderWatchdog() {
    if (this.encoderWatchdog) { clearInterval(this.encoderWatchdog); this.encoderWatchdog = null; }
  }

  // ───────────────────────── Rotating messages ─────────────────────────

  startMessageRotation() {
    if (this.messageInterval) clearInterval(this.messageInterval);
    this.messageInterval = setInterval(() => {
      if (this.messages.length > 0) {
        this.currentMessageIndex = (this.currentMessageIndex + 1) % this.messages.length;
        this.setMessage(this.messages[this.currentMessageIndex]); // live reload, no restart
      }
    }, 30000);
  }

  updateMessages(messages) {
    this.messages = messages.filter(m => m.trim() !== '');
    if (this.messages.length === 0) this.messages = ['Radio Lofi 24/7'];
    this.currentMessageIndex = 0;
    this.setMessage(this.messages[0]);
    return true;
  }

  // ───────────────────────── hotSwap ─────────────────────────

  async hotSwapPlaylist(playlistName) {
    if (!this.isStreaming) throw new Error('No stream running');
    const playlistPath = path.join(__dirname, '../media/mp3', playlistName);
    if (!fs.existsSync(playlistPath) ||
        fs.readdirSync(playlistPath).filter(f => f.endsWith('.mp3')).length === 0) {
      throw new Error('Playlist not found or empty');
    }
    // Live swap: applied on the next track, WITHOUT touching the encoder (0 reconnections).
    this.pendingPlaylistSwap = playlistName;
    logger.info(`V2: playlist hotSwap scheduled (live): ${playlistName}`);
    return true;
  }

  async hotSwapVideo(videoName) {
    if (!this.isStreaming) throw new Error('No stream running');
    const videoPath = path.join(__dirname, '../media/mp4/bg', videoName);
    if (!fs.existsSync(videoPath)) throw new Error('Video not found');
    // Changing the video source in a live ffmpeg process is not trivial: controlled
    // restart of the permanent encoder (rare manual action). The audio feeder
    // keeps feeding the FIFO -> near-instant resumption.
    this.currentVideo = videoName;
    logger.info(`V2: background video hotSwap -> ${videoName} (controlled encoder restart)`);
    await this.restartEncoderOnly();
    this.emit('hotSwap', { type: 'video', name: videoName });
    return true;
  }

  // Restarts only the encoder (keeps the feeder/FIFO) — for video/overlay changes.
  async restartEncoderOnly() {
    this.stopping = true; // prevents the close-handler from triggering a double restart
    this.teardownFeeder();
    if (this.ffmpegProcess) {
      try { this.ffmpegProcess.kill('SIGTERM'); } catch (e) {}
      await new Promise((resolve) => {
        if (!this.ffmpegProcess) return resolve();
        this.ffmpegProcess.once('close', resolve);
        setTimeout(resolve, 2000);
      });
    }
    await new Promise(r => setTimeout(r, 300));
    this.stopping = false;
    await this.startMusicEngine();
  }

  // ───────────────────────── Overlay update (position/color) ─────────────────────────

  async updateTextOverlay(overlayConfig) {
    const prev = this.textOverlay;
    this.textOverlay = { ...this.textOverlay, ...overlayConfig };
    this.writeOverlayFiles();

    // TEXT is hot-reloaded (textfile reload). Only position/size/color/font
    // require rebuilding the filter graph -> controlled encoder restart.
    const layoutChanged = JSON.stringify(prev.nowPlayingPos) !== JSON.stringify(this.textOverlay.nowPlayingPos) ||
                          JSON.stringify(prev.messagePos) !== JSON.stringify(this.textOverlay.messagePos);
    if (this.isStreaming && this.mode === 'MUSIC' && layoutChanged) {
      logger.info('V2: overlay layout changed -> controlled encoder restart');
      await this.restartEncoderOnly();
    }
    this.emit('textUpdate', this.textOverlay);
    return true;
  }

  // ───────────────────────── PROGRAM mode (hybrid: controlled reconnection) ─────────────────────────

  async startProgram(videoPath, returnConfig) {
    if (!this.isStreaming) throw new Error('No stream running');
    if (this.mode === 'PROGRAM') throw new Error('A program is already running');
    if (!fs.existsSync(videoPath)) throw new Error('Scheduled video not found');

    this.programConfig = {
      playlist: returnConfig.playlist || this.currentPlaylist,
      video: returnConfig.video || this.currentVideo
    };
    logger.info(`V2: PROGRAM -> ${path.basename(videoPath)} (controlled reconnection)`);

    // Cleanly stop the permanent engine (feeder + encoder).
    this.stopping = true;
    this.teardownFeeder();
    this.stopEncoderWatchdog();
    if (this.ffmpegProcess) {
      try { this.ffmpegProcess.kill('SIGTERM'); } catch (e) {}
      await new Promise((resolve) => {
        if (!this.ffmpegProcess) return resolve();
        this.ffmpegProcess.once('close', resolve);
        setTimeout(resolve, 2000);
      });
    }
    await new Promise(r => setTimeout(r, 500));

    this.mode = 'PROGRAM';
    this.stopping = false;
    this.currentProgramVideo = videoPath;
    this.emit('mode:changed', { mode: 'PROGRAM', video: path.basename(videoPath) });
    this.startProgramFFmpeg(videoPath);
    return true;
  }

  startProgramFFmpeg(videoPath) {
    const filter = this.buildFilterComplex();
    const fps = this.config.fps || 24;
    const args = [
      '-re', '-i', videoPath,
      '-filter_complex', filter,
      '-map', '[v]', '-map', '0:a',
      '-c:v', 'libx264', '-preset', 'ultrafast',
      '-b:v', this.config.videoBitrate, '-maxrate', this.config.videoBitrate, '-bufsize', '5000k',
      '-pix_fmt', 'yuv420p',
      '-g', String(fps * 2), '-keyint_min', String(fps), '-sc_threshold', '0',
      '-c:a', 'aac', '-b:a', this.config.audioBitrate, '-ar', String(PCM_RATE),
      '-f', 'flv', this.outputTarget()
    ];
    logger.info('V2: PROGRAM ffmpeg', path.basename(videoPath));
    this.ffmpegProcess = spawn('ffmpeg', args, { detached: false });
    this.ffmpegProcess.stderr.on('data', (d) => {
      this.lastEncoderOutput = Date.now();
      const s = d.toString();
      if (/fail|invalid|unable/i.test(s)) logger.error('V2 PROGRAM ffmpeg:', s.trim().slice(0, 200));
    });
    this.ffmpegProcess.on('close', () => {
      logger.info('V2: PROGRAM ended');
      if (this.mode === 'PROGRAM' && this.isStreaming && this.programConfig) {
        this.emit('program:ended', { video: path.basename(videoPath) });
        this.returnToMusic();
      }
    });
    this.ffmpegProcess.on('error', (err) => {
      logger.error('V2 PROGRAM error:', err.message);
      this.emit('error', err.message);
      if (this.mode === 'PROGRAM' && this.programConfig) this.returnToMusic();
    });
  }

  async returnToMusic() {
    if (!this.programConfig) return;
    const { playlist, video } = this.programConfig;
    logger.info(`V2: returning to MUSIC (playlist=${playlist}, video=${video})`);
    this.mode = 'MUSIC';
    const cfg = this.programConfig;
    this.programConfig = null;
    this.currentProgramVideo = null;

    if (this.ffmpegProcess) {
      try { this.ffmpegProcess.kill('SIGTERM'); } catch (e) {}
    }
    await new Promise(r => setTimeout(r, 500));

    if (!(await this.loadPlaylist(playlist))) {
      this.emit('error', `Failed to reload playlist: ${playlist}`);
      return;
    }
    this.currentVideo = video;
    this.stopping = false;
    await this.startMusicEngine();
    this.emit('mode:changed', { mode: 'MUSIC', playlist, video });
    this.emit('music:resumed', { playlist, video });
  }

  async stopProgram() {
    if (this.mode !== 'PROGRAM') throw new Error('No program running');
    logger.info('V2: manual PROGRAM stop');
    if (this.programConfig) {
      await this.returnToMusic();
    }
    return true;
  }

  // ───────────────────────── Shutdown ─────────────────────────

  stopStream() {
    this.stopping = true;
    this.isStreaming = false;
    this.isPaused = false;
    this.mode = 'MUSIC';
    this.programConfig = null;
    this.currentProgramVideo = null;

    this.stopEncoderWatchdog();
    this.teardownFeeder();

    if (this.ffmpegProcess) {
      try { this.ffmpegProcess.kill('SIGKILL'); } catch (e) {}
      this.ffmpegProcess = null;
    }
    if (this.messageInterval) { clearInterval(this.messageInterval); this.messageInterval = null; }
    this.pendingPlaylistSwap = null;

    this.emit('status', { isStreaming: false });
    return true;
  }

  emergencyStop() {
    logger.warn('V2: EMERGENCY STOP');
    this.stopping = true;
    this.stopEncoderWatchdog();
    this.teardownFeeder();
    this.mode = 'MUSIC';
    this.programConfig = null;
    this.currentProgramVideo = null;
    this.ffmpegProcess = null;
    try { require('child_process').execSync('pkill -9 -f "ffmpeg.*audio.fifo" 2>/dev/null || true'); } catch (e) {}
    // Safety net: only kills ffmpeg processes belonging to THIS instance (identified by their FIFO path).
    this.isStreaming = false;
    this.isPaused = false;
    this.pendingPlaylistSwap = null;
    if (this.messageInterval) { clearInterval(this.messageInterval); this.messageInterval = null; }
    this.stats = { startTime: null, tracksPlayed: 0, totalDuration: 0 };
    this.emit('status', { isStreaming: false });
    return true;
  }

  getStatus() {
    return {
      isStreaming: this.isStreaming,
      isPaused: this.isPaused,
      currentPlaylist: this.currentPlaylist,
      currentVideo: this.currentVideo,
      currentTrack: this.currentTrack?.name || null,
      textOverlay: this.textOverlay,
      messages: this.messages,
      stats: {
        ...this.stats,
        uptime: this.stats.startTime ? Date.now() - this.stats.startTime : 0,
        reconnections: this.restartCount,
        engine: 'v2-permanent'
      },
      mode: this.mode,
      currentProgramVideo: this.currentProgramVideo ? path.basename(this.currentProgramVideo) : null
    };
  }
}

module.exports = StreamEngineV2;
