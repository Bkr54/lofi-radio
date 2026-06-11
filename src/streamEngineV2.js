/**
 * streamEngineV2 — Moteur de streaming PERMANENT (hybride) pour la Radio Lofi.
 *
 * Drop-in remplaçant de streamManager.js : MÊME API publique, MÊMES événements,
 * MÊME forme de getStatus(). Sélectionnable via STREAM_ENGINE=v2.
 *
 * Principe (cf. docs/MOTEUR-PERMANENT-EVALUATION.md) :
 *   - Mode MUSIC : UN SEUL ffmpeg encodeur tourne en permanence.
 *       * vidéo de fond bouclée (-stream_loop -1)
 *       * audio gapless via une FIFO : node décode chaque mp3 en PCM s16le
 *         et enchaîne les flux dans le pipe -> aucune coupure entre morceaux.
 *       * overlays "Now Playing" + message via drawtext textfile reload=1
 *         -> le contrôleur écrit les fichiers texte, ffmpeg recharge à chaud.
 *     => changement de morceau = 0 reconnexion RTMP (vs ~410/jour en V1).
 *   - Mode PROGRAM : on accepte UNE reconnexion contrôlée (rare) pour diffuser
 *     une vidéo programmée avec son propre son, puis on reprend le moteur permanent.
 *   - hotSwap playlist : à chaud (on change la file du feeder, l'encodeur ne bouge pas).
 *   - hotSwap vidéo de fond / changement de position d'overlay : redémarrage contrôlé
 *     de l'encodeur (action manuelle rare).
 *
 * Moteur permanent (gapless) pour streaming RTMP 24/7.
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

    // Process encodeur permanent (mode MUSIC) OU process programme (mode PROGRAM).
    // Exposé sous le nom ffmpegProcess pour compat /healthz et server.js.
    this.ffmpegProcess = null;

    // Feeder audio (mode MUSIC)
    this.fifoStream = null;       // WritableStream vers la FIFO
    this.decoderProcess = null;   // ffmpeg décodeur mp3 -> PCM en cours
    this.feederActive = false;
    this.trackStartTime = 0;          // horloge de début du morceau courant
    this.currentTrackDurationMs = 0;  // durée du morceau courant (ffprobe)
    this.progressInterval = null;     // émission périodique de la progression

    // État playlist
    this.currentPlaylist = null;
    this.currentVideo = null;
    this.currentTrack = null;
    this.playlistQueue = [];
    this.currentTrackIndex = 0;
    this.pendingPlaylistSwap = null;

    // Diffusion
    this.isStreaming = false;
    this.isPaused = false;
    this.stopping = false; // évite le redémarrage auto pendant un arrêt volontaire

    // Overlays
    this.textOverlay = {
      nowPlaying: 'En attente...',
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

    // Watchdog encodeur
    this.encoderWatchdog = null;
    this.lastEncoderOutput = 0;
    this.restartCount = 0; // reconnexions involontaires (crash) — devrait rester ~0
  }

  // ───────────────────────── Helpers playlist (identiques V1) ─────────────────────────

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

  // Durée d'un mp3 en ms (ffprobe rapide). 0 si inconnue.
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

  // drawtext lit le texte depuis un fichier rechargé à chaque frame : aucune
  // donnée sensible dans la ligne de commande, et mise à jour à chaud sans restart.
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

  // Échappe un chemin pour le filtre ffmpeg (textfile=...).
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
    // Permet un override local (selftest) sans toucher au RTMP de prod.
    if (this.config.outputOverride) return this.config.outputOverride;
    return `${this.config.streamUrl}/${this.config.streamKey}`;
  }

  // ───────────────────────── FIFO audio ─────────────────────────

  ensureFifo() {
    try { fs.mkdirSync(RUN_DIR, { recursive: true }); } catch (e) {}
    try {
      // (re)crée la FIFO proprement
      if (fs.existsSync(FIFO_PATH)) fs.unlinkSync(FIFO_PATH);
    } catch (e) {}
    const r = spawn('mkfifo', [FIFO_PATH]);
    return new Promise((resolve, reject) => {
      r.on('close', (code) => code === 0 ? resolve() : reject(new Error('mkfifo a échoué')));
      r.on('error', reject);
    });
  }

  // ───────────────────────── Démarrage MUSIC ─────────────────────────

  async startStream(playlistName, videoName) {
    if (this.isStreaming) throw new Error('Stream déjà en cours');
    if (!this.config.streamKey && !this.config.outputOverride) {
      throw new Error('Clé de stream non configurée');
    }
    if (this.config.streamKey === 'STAGING_KEY_A_REMPLACER' && !this.config.outputOverride) {
      throw new Error('Clé STAGING non configurée : colle une vraie clé YouTube de test dans .env (STREAM_KEY).');
    }

    const videoPath = path.join(__dirname, '../media/mp4/bg', videoName);
    if (!fs.existsSync(videoPath)) throw new Error('Vidéo de fond non trouvée');
    if (!(await this.loadPlaylist(playlistName))) throw new Error('Playlist non trouvée ou vide');

    this.currentVideo = videoName;
    this.isStreaming = true;
    this.isPaused = false;
    this.stopping = false;
    this.mode = 'MUSIC';
    this.stats.startTime = Date.now();
    this.stats.tracksPlayed = 0;

    this.textOverlay.nowPlaying = 'En attente...';
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

  // Lance l'encodeur permanent + le feeder audio gapless.
  async startMusicEngine() {
    await this.ensureFifo();

    const videoPath = path.join(__dirname, '../media/mp4/bg', this.currentVideo);
    const filter = this.buildFilterComplex();
    const fps = this.config.fps || 24;

    const args = [
      '-re', '-stream_loop', '-1', '-i', videoPath,            // vidéo de fond en boucle (horloge réaliste)
      '-f', 's16le', '-ar', String(PCM_RATE), '-ac', String(PCM_CHANNELS), '-i', FIFO_PATH, // audio PCM gapless
      '-filter_complex', filter,
      '-map', '[v]', '-map', '1:a',
      '-c:v', 'libx264', '-preset', 'ultrafast',
      '-b:v', this.config.videoBitrate, '-maxrate', this.config.videoBitrate, '-bufsize', '5000k',
      '-pix_fmt', 'yuv420p',
      '-g', String(fps * 2), '-keyint_min', String(fps), '-sc_threshold', '0',
      '-c:a', 'aac', '-b:a', this.config.audioBitrate, '-ar', String(PCM_RATE),
      '-f', 'flv', this.outputTarget()
    ];

    logger.info('V2: démarrage encodeur PERMANENT (mode MUSIC)');
    this.ffmpegProcess = spawn('ffmpeg', args, { detached: false });
    this.attachEncoderHandlers(this.ffmpegProcess);
    this.startEncoderWatchdog();

    // Ouvre l'extrémité écriture de la FIFO (se débloque quand ffmpeg ouvre la lecture),
    // puis démarre l'alimentation audio.
    this.fifoStream = fs.createWriteStream(FIFO_PATH);
    this.fifoStream.on('error', (err) => {
      // EPIPE quand l'encodeur meurt : géré par le watchdog/close.
      if (err && err.code !== 'EPIPE') logger.error('V2 FIFO erreur:', err.message);
    });
    this.fifoStream.on('open', () => {
      logger.info('V2: FIFO ouverte, démarrage du feeder audio gapless');
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
        // bruit normal possible ; on logue en debug léger
        if (/fail|invalid|unable|Connection refused/i.test(output)) logger.error('V2 ffmpeg:', output.trim().slice(0, 300));
      }
    });
    proc.on('close', (code) => {
      logger.info(`V2: encodeur terminé (code ${code})`);
      if (this.stopping || !this.isStreaming || this.mode !== 'MUSIC') return;
      // Mort involontaire de l'encodeur permanent -> reconnexion de secours.
      this.restartCount++;
      logger.error(`V2: encodeur permanent mort de façon inattendue, reconnexion #${this.restartCount}`);
      this.emit('error', 'Encodeur permanent interrompu, reconnexion…');
      this.teardownFeeder();
      setTimeout(() => {
        if (this.isStreaming && this.mode === 'MUSIC' && !this.stopping) {
          this.startMusicEngine().catch(e => logger.error('V2: échec reconnexion', e.message));
        }
      }, 1000);
    });
    proc.on('error', (err) => {
      logger.error('V2 ffmpeg error:', err.message);
      this.emit('error', err.message);
    });
  }

  // Enchaîne les morceaux dans la FIFO sans jamais couper l'encodeur.
  feedNextTrack() {
    if (!this.feederActive || !this.isStreaming || this.isPaused) return;

    // Application d'un changement de playlist programmé (à chaud)
    if (this.pendingPlaylistSwap) {
      const target = this.pendingPlaylistSwap;
      this.pendingPlaylistSwap = null;
      // loadPlaylist est synchrone côté disque ici
      this.loadPlaylist(target).then((ok) => {
        if (ok) this.emit('hotSwap', { type: 'playlist', name: target });
        else logger.error(`V2: playlist introuvable: ${target}`);
        this.spawnDecoderForNext();
      });
      return;
    }
    this.spawnDecoderForNext();
  }

  spawnDecoderForNext() {
    const track = this.getNextTrack();
    if (!track) { this.emit('error', 'Aucun morceau disponible'); return; }

    // V2_TRACK_LIMIT_SEC : coupe chaque morceau à N s (utile pour tests/preview rapides).
    const limit = parseInt(process.env.V2_TRACK_LIMIT_SEC, 10);

    this.currentTrack = track;
    this.stats.tracksPlayed++;
    // Durée du morceau (réelle, ou bornée si limit) pour la progression et la durée totale.
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

    // Progression émise toutes les 2 s (horloge réaliste : diffusion calée temps réel).
    if (this.progressInterval) clearInterval(this.progressInterval);
    this.progressInterval = setInterval(() => {
      if (this.currentTrackDurationMs > 0) {
        const pct = Math.min(((Date.now() - this.trackStartTime) / this.currentTrackDurationMs) * 100, 100);
        this.emit('progress', { progress: pct });
      }
    }, 2000);

    // Décode le mp3 en PCM s16le et pousse dans la FIFO (sans fermer la FIFO).
    const decArgs = ['-hide_banner', '-loglevel', 'error', '-i', track.path];
    if (limit > 0) decArgs.push('-t', String(limit));
    decArgs.push('-f', 's16le', '-ar', String(PCM_RATE), '-ac', String(PCM_CHANNELS),
      '-af', 'volume=0.8', 'pipe:1');
    const dec = spawn('ffmpeg', decArgs, { detached: false });

    this.decoderProcess = dec;

    dec.stderr.on('data', (d) => {
      const s = d.toString();
      if (s.trim()) logger.error('V2 décodeur:', s.trim().slice(0, 200));
    });

    // Backpressure naturelle : si la FIFO est pleine (ffmpeg consomme à ~temps réel),
    // pipe() met le décodeur en pause -> alimentation calée sur le temps réel.
    if (this.fifoStream) dec.stdout.pipe(this.fifoStream, { end: false });

    dec.on('close', () => {
      this.decoderProcess = null;
      if (this.progressInterval) { clearInterval(this.progressInterval); this.progressInterval = null; }
      // Cumul de la durée totale diffusée (alimente "Durée totale" du dashboard).
      if (this.currentTrackDurationMs > 0) this.stats.totalDuration += this.currentTrackDurationMs;
      if (this.feederActive && this.isStreaming && !this.isPaused && this.mode === 'MUSIC') {
        // Morceau suivant immédiatement -> audio continu (gapless).
        this.feedNextTrack();
      }
    });
    dec.on('error', (err) => logger.error('V2 décodeur error:', err.message));
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
        logger.error('V2 watchdog: aucune sortie encodeur depuis 30s, redémarrage');
        if (this.ffmpegProcess) { try { this.ffmpegProcess.kill('SIGKILL'); } catch (e) {} }
        // le handler close() relancera startMusicEngine
      }
    }, 10000);
  }

  stopEncoderWatchdog() {
    if (this.encoderWatchdog) { clearInterval(this.encoderWatchdog); this.encoderWatchdog = null; }
  }

  // ───────────────────────── Messages rotatifs ─────────────────────────

  startMessageRotation() {
    if (this.messageInterval) clearInterval(this.messageInterval);
    this.messageInterval = setInterval(() => {
      if (this.messages.length > 0) {
        this.currentMessageIndex = (this.currentMessageIndex + 1) % this.messages.length;
        this.setMessage(this.messages[this.currentMessageIndex]); // reload à chaud, aucun restart
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
    if (!this.isStreaming) throw new Error('Aucun stream en cours');
    const playlistPath = path.join(__dirname, '../media/mp3', playlistName);
    if (!fs.existsSync(playlistPath) ||
        fs.readdirSync(playlistPath).filter(f => f.endsWith('.mp3')).length === 0) {
      throw new Error('Playlist non trouvée ou vide');
    }
    // À chaud : appliqué au prochain morceau, SANS toucher l'encodeur (0 reconnexion).
    this.pendingPlaylistSwap = playlistName;
    logger.info(`V2: hotSwap playlist programmé (à chaud): ${playlistName}`);
    return true;
  }

  async hotSwapVideo(videoName) {
    if (!this.isStreaming) throw new Error('Aucun stream en cours');
    const videoPath = path.join(__dirname, '../media/mp4/bg', videoName);
    if (!fs.existsSync(videoPath)) throw new Error('Vidéo non trouvée');
    // Changer la source vidéo dans un ffmpeg vivant n'est pas trivial : redémarrage
    // contrôlé de l'encodeur permanent (action manuelle rare). Le feeder audio
    // continue d'alimenter la FIFO -> reprise quasi immédiate.
    this.currentVideo = videoName;
    logger.info(`V2: hotSwap vidéo de fond -> ${videoName} (redémarrage contrôlé encodeur)`);
    await this.restartEncoderOnly();
    this.emit('hotSwap', { type: 'video', name: videoName });
    return true;
  }

  // Redémarre uniquement l'encodeur (garde le feeder/FIFO) — pour changement vidéo/overlay.
  async restartEncoderOnly() {
    this.stopping = true; // empêche le close-handler de relancer en double
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

  // ───────────────────────── Overlay update (position/couleur) ─────────────────────────

  async updateTextOverlay(overlayConfig) {
    const prev = this.textOverlay;
    this.textOverlay = { ...this.textOverlay, ...overlayConfig };
    this.writeOverlayFiles();

    // Le TEXTE est rechargé à chaud (textfile reload). Seuls position/taille/couleur/police
    // exigent de reconstruire le graphe -> redémarrage contrôlé de l'encodeur.
    const layoutChanged = JSON.stringify(prev.nowPlayingPos) !== JSON.stringify(this.textOverlay.nowPlayingPos) ||
                          JSON.stringify(prev.messagePos) !== JSON.stringify(this.textOverlay.messagePos);
    if (this.isStreaming && this.mode === 'MUSIC' && layoutChanged) {
      logger.info('V2: changement de mise en page overlay -> redémarrage contrôlé encodeur');
      await this.restartEncoderOnly();
    }
    this.emit('textUpdate', this.textOverlay);
    return true;
  }

  // ───────────────────────── PROGRAM mode (hybride : reconnexion contrôlée) ─────────────────────────

  async startProgram(videoPath, returnConfig) {
    if (!this.isStreaming) throw new Error('Aucun stream en cours');
    if (this.mode === 'PROGRAM') throw new Error('Un programme est déjà en cours');
    if (!fs.existsSync(videoPath)) throw new Error('Vidéo programmée non trouvée');

    this.programConfig = {
      playlist: returnConfig.playlist || this.currentPlaylist,
      video: returnConfig.video || this.currentVideo
    };
    logger.info(`V2: PROGRAM -> ${path.basename(videoPath)} (reconnexion contrôlée)`);

    // On arrête proprement le moteur permanent (feeder + encodeur).
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
      logger.info('V2: PROGRAM terminé');
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
    logger.info(`V2: retour MUSIC (playlist=${playlist}, video=${video})`);
    this.mode = 'MUSIC';
    const cfg = this.programConfig;
    this.programConfig = null;
    this.currentProgramVideo = null;

    if (this.ffmpegProcess) {
      try { this.ffmpegProcess.kill('SIGTERM'); } catch (e) {}
    }
    await new Promise(r => setTimeout(r, 500));

    if (!(await this.loadPlaylist(playlist))) {
      this.emit('error', `Échec rechargement playlist: ${playlist}`);
      return;
    }
    this.currentVideo = video;
    this.stopping = false;
    await this.startMusicEngine();
    this.emit('mode:changed', { mode: 'MUSIC', playlist, video });
    this.emit('music:resumed', { playlist, video });
  }

  async stopProgram() {
    if (this.mode !== 'PROGRAM') throw new Error('Aucun programme en cours');
    logger.info('V2: arrêt manuel du PROGRAM');
    if (this.programConfig) {
      await this.returnToMusic();
    }
    return true;
  }

  // ───────────────────────── Arrêt ─────────────────────────

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
    logger.warn('V2: ARRET D URGENCE');
    this.stopping = true;
    this.stopEncoderWatchdog();
    this.teardownFeeder();
    this.mode = 'MUSIC';
    this.programConfig = null;
    this.currentProgramVideo = null;
    this.ffmpegProcess = null;
    try { require('child_process').execSync('pkill -9 -f "ffmpeg.*audio.fifo" 2>/dev/null || true'); } catch (e) {}
    // Filet : ne tue que les ffmpeg de CETTE instance (identifiés par le chemin de leur FIFO).
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
