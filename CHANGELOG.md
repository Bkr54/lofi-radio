# Changelog

All notable changes to this project are documented here.

## [1.0.0]

Initial public release.

- 24/7 music livestreaming to YouTube/RTMP via ffmpeg.
- Web dashboard (Express + WebSocket): start/stop, status, uptime, now playing, progress.
- Live "Now Playing" + rotating message overlays.
- Two interchangeable engines via `STREAM_ENGINE`:
  - `v1` per-track (restart ffmpeg each track).
  - `v2` permanent / gapless (single ffmpeg, FIFO-fed audio, textfile-reload overlays,
    0 RTMP reconnects between tracks).
- Hot-swap playlist/background; TV-grid scheduler for programmed videos (PROGRAM mode).
- Security: scrypt password hashing, secrets in `.env`, sandboxed systemd unit,
  nginx + HTTPS templates, optional ntfy monitoring.
- Local `v2` self-test that renders to a file (no YouTube key required).
