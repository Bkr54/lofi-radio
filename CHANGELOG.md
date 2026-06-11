# Changelog

All notable changes to this project are documented here.

## [1.0.0]

Initial public release.

- 24/7 music livestreaming to YouTube/RTMP via ffmpeg.
- Web dashboard (Express + WebSocket): start/stop, status, uptime, now playing, progress.
- Live "Now Playing" + rotating message overlays.
- Permanent / gapless streaming engine: a single long-lived ffmpeg, FIFO-fed audio,
  textfile-reload overlays — **0 RTMP reconnects between tracks**, smooth ingest.
- Hot-swap playlist/background; TV-grid scheduler for programmed videos (PROGRAM mode).
- Security: scrypt password hashing, secrets in `.env`, sandboxed systemd unit,
  nginx + HTTPS templates, optional ntfy monitoring.
- Local self-test that renders to a file (no YouTube key required).
