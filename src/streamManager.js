const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const EventEmitter = require('events');
const logger = require('./logger');

class StreamManager extends EventEmitter {
  constructor(config) {
    super();
    this.config = config;
    this.ffmpegProcess = null;
    this.currentPlaylist = null;
    this.currentVideo = null;
    this.currentTrack = null;
    this.isStreaming = false;
    this.isPaused = false;
    this.playlistQueue = [];
    this.currentTrackIndex = 0;
    this.textOverlay = {
      nowPlaying: 'En attente...',
      message: 'Radio Lofi 24/7',
      nowPlayingPos: { x: 50, y: 640, fontSize: 32, color: '#ffffff', font: 'DejaVu Sans' },
      messagePos: { x: 50, y: 40, fontSize: 24, color: '#ffffff', font: 'DejaVu Sans' }
    };
    this.messages = [
      'Radio Lofi 24/7',
      'Relax & Study',
      'Chill Vibes Only'
    ];
    this.currentMessageIndex = 0;
    this.messageInterval = null;
    this.stats = {
      startTime: null,
      tracksPlayed: 0,
      totalDuration: 0
    };
    this.nextTrackTimeout = null;
    this.pendingPlaylistSwap = null; // Pending playlist to swap after current track

    // PROGRAM mode support
    this.mode = 'MUSIC'; // 'MUSIC' | 'PROGRAM'
    this.programConfig = null; // Config for returning to MUSIC after program ends
    this.currentProgramVideo = null; // Current program video path

    // FFmpeg watchdog for detecting dead/zombie processes
    this.ffmpegWatchdog = null;
    this.lastFFmpegOutput = 0;
  }

  // FFmpeg watchdog methods
  startFFmpegWatchdog() {
    this.stopFFmpegWatchdog();
    this.lastFFmpegOutput = Date.now();

    this.ffmpegWatchdog = setInterval(() => {
      // Si pas de sortie FFmpeg depuis 30 secondes, considerer comme mort
      if (Date.now() - this.lastFFmpegOutput > 30000) {
        logger.error('FFmpeg watchdog: Pas de sortie depuis 30s, redemarrage...');
        this.handleFFmpegDeath();
      }
    }, 10000);
  }

  stopFFmpegWatchdog() {
    if (this.ffmpegWatchdog) {
      clearInterval(this.ffmpegWatchdog);
      this.ffmpegWatchdog = null;
    }
  }

  handleFFmpegDeath() {
    this.stopFFmpegWatchdog();

    // Tuer le processus zombie
    if (this.ffmpegProcess) {
      try { this.ffmpegProcess.kill('SIGKILL'); } catch(e) {}
      this.ffmpegProcess = null;
    }

    // Force kill systeme en backup
    try {
      require('child_process').execSync('pkill -9 ffmpeg 2>/dev/null || true');
    } catch(e) {}

    // Si on etait en streaming, tenter de redemarrer
    if (this.isStreaming && this.mode === 'MUSIC') {
      logger.info('Tentative de redemarrage automatique...');
      // Reprise plus rapide après mort de ffmpeg (2000->500ms)
      setTimeout(() => this.playNextTrack(), 500);
    }
  }

  async getPlaylists() {
    const mp3Dir = path.join(__dirname, '../media/mp3');
    if (!fs.existsSync(mp3Dir)) return [];
    
    const items = fs.readdirSync(mp3Dir);
    const playlists = [];
    
    for (const item of items) {
      const fullPath = path.join(mp3Dir, item);
      const stat = fs.statSync(fullPath);
      if (stat.isDirectory()) {
        const files = fs.readdirSync(fullPath)
          .filter(f => f.endsWith('.mp3'))
          .map(f => path.join(fullPath, f));
        if (files.length > 0) {
          playlists.push({ name: item, path: fullPath, tracks: files.length });
        }
      }
    }
    return playlists;
  }

  async getBackgroundVideos() {
    const videoDir = path.join(__dirname, '../media/mp4/bg');
    if (!fs.existsSync(videoDir)) return [];
    
    return fs.readdirSync(videoDir)
      .filter(f => f.endsWith('.mp4'))
      .map(f => ({
        name: f,
        path: path.join(videoDir, f)
      }));
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
    
    const files = fs.readdirSync(playlistPath)
      .filter(f => f.endsWith('.mp3'))
      .map(f => ({
        name: path.basename(f, '.mp3'),
        path: path.join(playlistPath, f)
      }));
    
    if (files.length === 0) return false;
    
    this.playlistQueue = this.shuffleArray(files);
    this.currentTrackIndex = 0;
    this.currentPlaylist = playlistName;
    return true;
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

  formatTextForFilter(text) {
    return text.replace(/'/g, "'\\\\''").replace(/:/g, '\\:').replace(/\[/g, '\\[').replace(/\]/g, '\\]');
  }

  escapeFilter(text) {
    return text.replace(/\\/g, '\\\\')
               .replace(/'/g, "'\\\\''")
               .replace(/:/g, '\\:')
               .replace(/\[/g, '\\[')
               .replace(/\]/g, '\\]')
               .replace(/,/g, '\\,');
  }

  buildFilterComplex() {
    const { nowPlayingPos, messagePos } = this.textOverlay;
    
    const nowPlayingText = this.escapeFilter(this.textOverlay.nowPlaying);
    const messageText = this.escapeFilter(this.textOverlay.message);
    
    const nowPlayingFilter = `drawtext=text='${nowPlayingText}':fontsize=${nowPlayingPos.fontSize}:fontcolor=${nowPlayingPos.color}:fontfile=/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf:x=${nowPlayingPos.x}:y=${nowPlayingPos.y}:box=1:boxcolor=black@0.5:boxborderw=10`;
    
    const messageFilter = `drawtext=text='${messageText}':fontsize=${messagePos.fontSize}:fontcolor=${messagePos.color}:fontfile=/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf:x=${messagePos.x}:y=${messagePos.y}:box=1:boxcolor=black@0.5:boxborderw=10`;
    
    // Axe 2 : normalise toute source (musique 720p, programmes 1080p) vers la résolution/fps cible
    // AVANT le drawtext, pour une sortie uniforme et un coût d'encodage maîtrisé.
    const [vw, vh] = (this.config.resolution || '1280x720').split('x');
    const vfps = this.config.fps || 24;
    return `[0:v]scale=${vw}:${vh},fps=${vfps},${nowPlayingFilter},${messageFilter}[vout]`;
  }

  async startStream(playlistName, videoName) {
    if (this.isStreaming) {
      throw new Error('Stream déjà en cours');
    }

    if (!this.config.streamKey) {
      throw new Error('Clé de stream non configurée');
    }

    const videoPath = path.join(__dirname, '../media/mp4/bg', videoName);
    if (!fs.existsSync(videoPath)) {
      throw new Error('Vidéo de fond non trouvée');
    }

    if (!(await this.loadPlaylist(playlistName))) {
      throw new Error('Playlist non trouvée ou vide');
    }

    this.currentVideo = videoName;
    this.isStreaming = true;
    this.stats.startTime = Date.now();

    this.startMessageRotation();
    this.playNextTrack(); // This will call startFFmpeg(track)

    this.emit('status', {
      isStreaming: true,
      playlist: playlistName,
      video: videoName,
      currentTrack: this.currentTrack?.name
    });

    return true;
  }

  playNextTrack() {
    if (!this.isStreaming || this.isPaused) return;

    // Check if there's a pending playlist swap
    if (this.pendingPlaylistSwap) {
      const newPlaylist = this.pendingPlaylistSwap;
      this.pendingPlaylistSwap = null;

      logger.info(`Switching to playlist: ${newPlaylist}`);
      this.loadPlaylist(newPlaylist).then((success) => {
        if (success) {
          this.currentPlaylist = newPlaylist;
          this.emit('hotSwap', { type: 'playlist', name: newPlaylist });
        } else {
          logger.error(`Failed to load pending playlist: ${newPlaylist}`);
        }
      });
    }

    const track = this.getNextTrack();
    if (!track) {
      this.emit('error', 'Aucun morceau disponible');
      return;
    }

    this.currentTrack = track;
    this.textOverlay.nowPlaying = `Now Playing: ${track.name}`;
    this.stats.tracksPlayed++;

    this.emit('trackChange', {
      name: track.name,
      playlist: this.currentPlaylist,
      trackNumber: this.currentTrackIndex,
      totalTracks: this.playlistQueue.length
    });

    // Restart FFmpeg with new track
    this.startFFmpeg(track);
  }

  startFFmpeg(track) {
    // Kill existing process
    if (this.ffmpegProcess) {
      this.ffmpegProcess.kill('SIGTERM');
    }

    const videoPath = path.join(__dirname, '../media/mp4/bg', this.currentVideo);
    const filterComplex = this.buildFilterComplex();

    const args = [
      '-re',
      '-stream_loop', '-1',
      '-i', videoPath,
      '-i', track.path,  // Audio from file
      '-filter_complex', filterComplex,
      '-map', '[vout]',
      '-map', '1:a',
      '-c:v', 'libx264',
      '-preset', 'ultrafast',
      '-b:v', this.config.videoBitrate,
      '-maxrate', this.config.videoBitrate,
      '-bufsize', '5000k',
      '-pix_fmt', 'yuv420p',
      '-g', (this.config.fps * 2).toString(),
      '-keyint_min', this.config.fps.toString(),
      '-sc_threshold', '0',
      '-c:a', 'aac',
      '-b:a', this.config.audioBitrate,
      '-ar', '44100',
      '-af', 'volume=0.8',
      '-shortest',  // Re-add this
      '-f', 'flv',
      `${this.config.streamUrl}/${this.config.streamKey}`
    ];

    logger.info('Démarrage FFmpeg avec:', track.name);

    this.ffmpegProcess = spawn('ffmpeg', args, { detached: false });

    // Start watchdog to detect FFmpeg death
    this.startFFmpegWatchdog();

    // Track duration tracking for automatic restart
    let trackDuration = 0;
    let lastProgressUpdate = 0;

    this.ffmpegProcess.stderr.on('data', (data) => {
      // Update watchdog timestamp
      this.lastFFmpegOutput = Date.now();

      const output = data.toString();

      // Extract duration
      const durationMatch = output.match(/Duration: (\d{2}):(\d{2}):(\d{2}\.\d{2})/);
      if (durationMatch) {
        const hours = parseInt(durationMatch[1]);
        const minutes = parseInt(durationMatch[2]);
        const seconds = parseFloat(durationMatch[3]);
        trackDuration = (hours * 3600 + minutes * 60 + seconds) * 1000;
      }

      // Extract current time and calculate progress
      const timeMatch = output.match(/time=(\d{2}):(\d{2}):(\d{2}\.\d{2})/);
      if (timeMatch && trackDuration > 0) {
        const hours = parseInt(timeMatch[1]);
        const minutes = parseInt(timeMatch[2]);
        const seconds = parseFloat(timeMatch[3]);
        const currentTime = (hours * 3600 + minutes * 60 + seconds) * 1000;
        const progress = Math.min((currentTime / trackDuration) * 100, 100);

        // Emit progress update every 2 seconds to avoid flooding
        const now = Date.now();
        if (now - lastProgressUpdate > 2000) {
          lastProgressUpdate = now;
          this.emit('progress', { progress });
        }
      }

      if (output.includes('error') || output.includes('Error')) {
        logger.error('FFmpeg:', output);
      }
    });

    this.ffmpegProcess.on('close', (code) => {
      logger.info(`FFmpeg terminé avec code ${code}`);

      // Automatically play next track when this one finishes
      if (this.isStreaming && !this.isPaused && code !== null) {
        this.stats.totalDuration += trackDuration;
        // Gap inter-morceau réduit (1000->250ms) pour limiter le vidage du tampon RTMP YouTube
        setTimeout(() => this.playNextTrack(), 250);
      }
    });

    this.ffmpegProcess.on('error', (err) => {
      logger.error('FFmpeg error:', err);
      this.emit('error', err.message);
    });
  }

  startMessageRotation() {
    if (this.messageInterval) {
      clearInterval(this.messageInterval);
    }
    
    this.messageInterval = setInterval(() => {
      if (this.messages.length > 0) {
        this.currentMessageIndex = (this.currentMessageIndex + 1) % this.messages.length;
        this.textOverlay.message = this.messages[this.currentMessageIndex];
      }
    }, 30000);
  }

  async hotSwapPlaylist(playlistName) {
    if (!this.isStreaming) {
      throw new Error('Aucun stream en cours');
    }

    // Validate playlist exists before scheduling swap
    const playlistPath = path.join(__dirname, '../media/mp3', playlistName);
    if (!fs.existsSync(playlistPath)) {
      throw new Error('Playlist non trouvée ou vide');
    }

    const files = fs.readdirSync(playlistPath)
      .filter(f => f.endsWith('.mp3'));

    if (files.length === 0) {
      throw new Error('Playlist non trouvée ou vide');
    }

    // Schedule playlist swap at end of current track
    this.pendingPlaylistSwap = playlistName;
    logger.info(`Playlist swap scheduled: ${playlistName} (will apply after current track)`);

    return true;
  }

  async hotSwapVideo(videoName) {
    if (!this.isStreaming) {
      throw new Error('Aucun stream en cours');
    }

    // Validate video file
    const videoPath = path.join(__dirname, '../media/mp4/bg', videoName);
    if (!fs.existsSync(videoPath)) {
      throw new Error('Vidéo non trouvée');
    }

    const wasPlaying = this.currentTrack;
    this.currentVideo = videoName;

    // Stop FFmpeg
    if (this.ffmpegProcess) {
      this.ffmpegProcess.kill('SIGTERM');

      // Wait for clean termination
      await new Promise((resolve) => {
        if (!this.ffmpegProcess) {
          resolve();
          return;
        }
        this.ffmpegProcess.once('close', resolve);
        setTimeout(resolve, 2000); // Timeout fallback
      });
    }

    // Wait for initialization
    await new Promise(resolve => setTimeout(resolve, 1000));

    // Resume playing from same position in playlist
    this.currentTrack = wasPlaying;
    this.playNextTrack();

    this.emit('hotSwap', { type: 'video', name: videoName });
    return true;
  }

  // PROGRAM MODE METHODS

  async getProgramVideos() {
    const videoDir = path.join(__dirname, '../media/mp4/video');
    if (!fs.existsSync(videoDir)) return [];

    return fs.readdirSync(videoDir)
      .filter(f => f.endsWith('.mp4'))
      .map(f => ({
        name: f,
        path: path.join(videoDir, f),
        relativePath: `media/mp4/video/${f}`
      }));
  }

  async startProgram(videoPath, returnConfig) {
    if (!this.isStreaming) {
      throw new Error('Aucun stream en cours');
    }

    if (this.mode === 'PROGRAM') {
      throw new Error('Un programme est déjà en cours');
    }

    // Validate video file
    if (!fs.existsSync(videoPath)) {
      throw new Error('Vidéo programmée non trouvée');
    }

    // Save config for return to MUSIC mode
    this.programConfig = {
      playlist: returnConfig.playlist || this.currentPlaylist,
      video: returnConfig.video || this.currentVideo
    };

    logger.info(`Starting PROGRAM mode with video: ${videoPath}`);
    logger.info(`Return config: playlist=${this.programConfig.playlist}, video=${this.programConfig.video}`);

    // Stop current MUSIC mode FFmpeg
    if (this.ffmpegProcess) {
      this.ffmpegProcess.kill('SIGTERM');

      // Wait for clean termination
      await new Promise((resolve) => {
        if (!this.ffmpegProcess) {
          resolve();
          return;
        }
        this.ffmpegProcess.once('close', resolve);
        setTimeout(resolve, 2000); // Timeout fallback
      });
    }

    // Brief pause for transition
    await new Promise(resolve => setTimeout(resolve, 1000));

    this.mode = 'PROGRAM';
    this.currentProgramVideo = videoPath;

    this.emit('mode:changed', { mode: 'PROGRAM', video: path.basename(videoPath) });

    this.startProgramFFmpeg(videoPath);

    return true;
  }

  startProgramFFmpeg(videoPath) {
    // Kill existing process just in case
    if (this.ffmpegProcess) {
      this.ffmpegProcess.kill('SIGTERM');
    }

    const filterComplex = this.buildFilterComplex();

    const args = [
      '-re',
      '-i', videoPath,  // Video with integrated audio
      '-filter_complex', filterComplex,
      '-map', '[vout]',
      '-map', '0:a',    // Audio from the video file
      '-c:v', 'libx264',
      '-preset', 'ultrafast',
      '-b:v', this.config.videoBitrate,
      '-maxrate', this.config.videoBitrate,
      '-bufsize', '5000k',
      '-pix_fmt', 'yuv420p',
      '-g', (this.config.fps * 2).toString(),
      '-keyint_min', this.config.fps.toString(),
      '-sc_threshold', '0',
      '-c:a', 'aac',
      '-b:a', this.config.audioBitrate,
      '-ar', '44100',
      '-f', 'flv',
      `${this.config.streamUrl}/${this.config.streamKey}`
    ];

    logger.info('Starting PROGRAM FFmpeg with video:', path.basename(videoPath));

    this.ffmpegProcess = spawn('ffmpeg', args, { detached: false });

    // Start watchdog to detect FFmpeg death
    this.startFFmpegWatchdog();

    this.ffmpegProcess.stderr.on('data', (data) => {
      // Update watchdog timestamp
      this.lastFFmpegOutput = Date.now();

      const output = data.toString();
      if (output.includes('error') || output.includes('Error')) {
        logger.error('FFmpeg PROGRAM:', output);
      }
    });

    this.ffmpegProcess.on('close', (code) => {
      logger.info(`FFmpeg PROGRAM terminated with code ${code}`);

      // If we're still in PROGRAM mode and stream is active, video has finished
      if (this.mode === 'PROGRAM' && this.isStreaming && this.programConfig) {
        this.emit('program:ended', { video: path.basename(videoPath) });
        this.returnToMusic();
      }
    });

    this.ffmpegProcess.on('error', (err) => {
      logger.error('FFmpeg PROGRAM error:', err);
      this.emit('error', err.message);
      // Try to return to music on error
      if (this.mode === 'PROGRAM' && this.programConfig) {
        this.returnToMusic();
      }
    });
  }

  async returnToMusic() {
    if (!this.programConfig) {
      logger.error('No program config for return to MUSIC');
      return;
    }

    const { playlist, video } = this.programConfig;
    logger.info(`Returning to MUSIC mode: playlist=${playlist}, video=${video}`);

    this.mode = 'MUSIC';
    this.programConfig = null;
    this.currentProgramVideo = null;

    // Brief pause for transition
    await new Promise(resolve => setTimeout(resolve, 1000));

    // Reload playlist and set video
    const success = await this.loadPlaylist(playlist);
    if (!success) {
      logger.error(`Failed to reload playlist: ${playlist}`);
      this.emit('error', `Failed to reload playlist: ${playlist}`);
      return;
    }

    this.currentVideo = video;

    // Resume playing
    this.playNextTrack();

    this.emit('mode:changed', { mode: 'MUSIC', playlist, video });
    this.emit('music:resumed', { playlist, video });
  }

  async stopProgram() {
    if (this.mode !== 'PROGRAM') {
      throw new Error('Aucun programme en cours');
    }

    logger.info('Stopping PROGRAM mode manually');

    // Stop FFmpeg
    if (this.ffmpegProcess) {
      this.ffmpegProcess.kill('SIGTERM');

      await new Promise((resolve) => {
        if (!this.ffmpegProcess) {
          resolve();
          return;
        }
        this.ffmpegProcess.once('close', resolve);
        setTimeout(resolve, 2000);
      });
    }

    // Brief pause
    await new Promise(resolve => setTimeout(resolve, 500));

    // Return to music
    if (this.programConfig) {
      await this.returnToMusic();
    }

    return true;
  }

  async updateTextOverlay(overlayConfig) {
    this.textOverlay = { ...this.textOverlay, ...overlayConfig };

    if (this.isStreaming && this.ffmpegProcess) {
      const wasPlaying = this.currentTrack;

      // Stop FFmpeg
      this.ffmpegProcess.kill('SIGTERM');

      // Wait for clean termination
      await new Promise((resolve) => {
        if (!this.ffmpegProcess) {
          resolve();
          return;
        }
        this.ffmpegProcess.once('close', resolve);
        setTimeout(resolve, 2000); // Timeout fallback
      });

      // Wait for initialization
      await new Promise(resolve => setTimeout(resolve, 1000));

      // Resume playing from same position in playlist
      this.currentTrack = wasPlaying;
      this.playNextTrack();
    }

    this.emit('textUpdate', this.textOverlay);
    return true;
  }

  updateMessages(messages) {
    this.messages = messages.filter(m => m.trim() !== '');
    if (this.messages.length === 0) {
      this.messages = ['Radio Lofi 24/7'];
    }
    this.currentMessageIndex = 0;
    this.textOverlay.message = this.messages[0];
    return true;
  }

  stopStream() {
    this.isStreaming = false;
    this.isPaused = false;

    // Reset mode and program state
    this.mode = 'MUSIC';
    this.programConfig = null;
    this.currentProgramVideo = null;

    // Stop FFmpeg watchdog
    this.stopFFmpegWatchdog();

    // Kill FFmpeg process - first via object, then via system
    if (this.ffmpegProcess) {
      try { this.ffmpegProcess.kill('SIGKILL'); } catch(e) {}
      this.ffmpegProcess = null;
    }

    // Force kill system backup - ensures all ffmpeg processes are dead
    try {
      require('child_process').execSync('pkill -9 ffmpeg 2>/dev/null || true');
    } catch(e) {}

    // Clear any pending playlist swap
    this.pendingPlaylistSwap = null;

    if (this.nextTrackTimeout) {
      clearTimeout(this.nextTrackTimeout);
      this.nextTrackTimeout = null;
    }

    if (this.messageInterval) {
      clearInterval(this.messageInterval);
      this.messageInterval = null;
    }

    this.emit('status', { isStreaming: false });
    return true;
  }

  emergencyStop() {
    logger.warn('ARRET D URGENCE DU STREAM');

    // Stop watchdog first
    this.stopFFmpegWatchdog();

    // Reset complete state
    this.mode = 'MUSIC';
    this.programConfig = null;
    this.currentProgramVideo = null;
    this.ffmpegProcess = null;

    // Force kill SYSTEM - guarantees death of all ffmpeg processes
    try {
      require('child_process').execSync('pkill -9 ffmpeg', { stdio: 'ignore' });
    } catch(e) {}

    // Reset streaming state
    this.isStreaming = false;
    this.isPaused = false;
    this.pendingPlaylistSwap = null;

    if (this.nextTrackTimeout) {
      clearTimeout(this.nextTrackTimeout);
      this.nextTrackTimeout = null;
    }

    if (this.messageInterval) {
      clearInterval(this.messageInterval);
      this.messageInterval = null;
    }

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
        uptime: this.stats.startTime ? Date.now() - this.stats.startTime : 0
      },
      mode: this.mode,
      currentProgramVideo: this.currentProgramVideo ? path.basename(this.currentProgramVideo) : null
    };
  }
}

module.exports = StreamManager;
